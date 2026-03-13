import{NeuroMemoryCore,defaultSettings}from'./src/core.js';
import{exportStore,importStore,loadStore,deleteStore,setContextGetter,removeMemory,saveStore,addMemory,updateMemory}from'./src/store.js';
import{extractMemories,setExtractionPrompt,getExtractionPrompt,DEFAULT_EXTRACT_SYSTEM}from'./src/extraction.js';
import{uid,extractKeywords}from'./src/utils.js';
import{updateMemoryConnections}from'./src/network.js';

const MODULE_NAME='neuro-memory';
const core=new NeuroMemoryCore();

// WICHTIG: getContext() gibt jedes Mal ein neues Snapshot-Objekt zurueck - NIE cachen!
function getCtx(){
if(typeof SillyTavern!=='undefined'&&SillyTavern.getContext)return SillyTavern.getContext();
return null;
}

// Status im UI anzeigen
function setStatus(msg,isError=false){
const el=document.getElementById('nm_status');
if(el){
el.textContent=msg;
el.className='nm-status'+(isError?' nm-status-error':'');
}
console.log(`[NM] status: ${msg}`);
}

// Settings laden/speichern
function loadSettings(){
const c=getCtx();
if(!c)return;
const ext=c.extensionSettings[MODULE_NAME];
if(ext)Object.assign(core.settings,ext);
else c.extensionSettings[MODULE_NAME]=Object.assign({},defaultSettings());
// Gespeicherten Extraction-Prompt anwenden
setExtractionPrompt(core.settings.extractionPrompt||'');
}

// UI-Eingabefelder mit aktuellen core.settings synchronisieren (nach loadSettings)
function syncUIFromSettings(){
const s=core.settings;
const set=(id,val)=>{const el=document.getElementById(id);if(el)el.value=val};
set('nm_topK',s.topK);
set('nm_maxContextTokens',s.maxContextTokens);
set('nm_injectionDepth',s.injectionDepth);
set('nm_extractEveryN',s.extractEveryN);
set('nm_extractContextMessages',s.extractContextMessages);
set('nm_halfLifeDays',s.halfLifeDays);
set('nm_emotionFactor',s.emotionFactor);
set('nm_consolidateEveryN',s.consolidateEveryN);
set('nm_maxMemories',s.maxMemories);
set('nm_activationHops',s.activationHops);
set('nm_activationThreshold',s.activationThreshold);
const cb=document.getElementById('nm_enabled');if(cb)cb.checked=!!s.enabled;
// Prompt-Textarea ebenfalls aktualisieren
const promptEl=document.getElementById('nm_extractPrompt');
if(promptEl){
const isCustom=!!(s.extractionPrompt&&s.extractionPrompt.trim());
promptEl.value=isCustom?s.extractionPrompt:DEFAULT_EXTRACT_SYSTEM;
const hint=document.getElementById('nm_promptHint');
if(hint)hint.textContent=isCustom?'Benutzerdefinierter Prompt aktiv':'Standard-Prompt (bearbeitbar)';
}
}

function saveSettings(){
const c=getCtx();
if(!c)return;
c.extensionSettings[MODULE_NAME]=Object.assign({},core.settings);
c.saveSettingsDebounced();
}

// Charakter-ID ermitteln
function getCharId(c){
if(!c)c=getCtx();
if(!c)return null;
if(c.groupId)return`group_${c.groupId}`;
if(c.characterId!==undefined&&c.characterId>=0&&c.characters[c.characterId]){
return c.characters[c.characterId].avatar||`char_${c.characterId}`;
}
return null;
}
function getCharName(c){
if(!c)c=getCtx();
if(!c)return'';
if(c.groupId)return c.groups?.find(g=>g.id===c.groupId)?.name||'Group';
if(c.characterId!==undefined&&c.characterId>=0&&c.characters[c.characterId]){
return c.characters[c.characterId].name||'';
}
return'';
}

// Event Handler
async function onChatChanged(){
try{
const c=getCtx();
const charId=getCharId(c);
console.log('[NM] onChatChanged fired, charId:',charId);
if(!charId){
await core.unload();
updateUI();
setStatus('');
return;
}
// Lade Charakter + Memories (aus extensionSettings oder localforage)
await core.loadCharacter(charId,getCharName(c));
const s=core.getStats();
const count=s?.totalMemories||0;
setStatus(count>0?`${count} Memories geladen`:'Bereit');
updateUI();
console.log('[NM] character loaded:',getCharName(c),', memories:',count);
}catch(e){console.error('[NM] onChatChanged error',e)}
}

// KRITISCHER FIX: Non-blocking extraction mit Delay
function onMessageReceived(msgIdx){
console.log('[NM] MESSAGE_RECEIVED fired, msgIdx:',msgIdx);

if(!core.settings.enabled){
console.log('[NM] skipped: extension disabled');
return;
}
const c=getCtx();
if(!c){console.log('[NM] skipped: no context');return}
if(!c.chat){console.log('[NM] skipped: no chat');return}
if(c.chat.length<2){console.log('[NM] skipped: chat.length=',c.chat.length,'(need >=2)');return}

console.log('[NM] chat has',c.chat.length,'messages, scheduling extraction...');

// Chat-Snapshot sichern (Kopie der relevanten Daten)
const chatSnapshot=c.chat.map(m=>({is_user:m.is_user,name:m.name,mes:m.mes}));

// NON-BLOCKING: Extraction nach 1.5s Delay starten (SillyTavern Post-Generation abwarten)
setTimeout(()=>{
console.log('[NM] starting delayed extraction...');
setStatus('Extracting memories...');
core.onMessageReceived(chatSnapshot)
.then(()=>{
const s=core.getStats();
if(s&&s.totalMemories>0){
setStatus(`OK: ${s.totalMemories} memories stored`);
}else{
setStatus('Extraction done (0 new memories)');
}
updateUI();
})
.catch(e=>{
console.error('[NM] extraction background error',e);
setStatus('Error: '+e.message,true);
});
},1500);
}

function onGenerateBefore(){
console.log('[NM] onGenerateBefore fired, enabled=',core.settings.enabled,', store=',!!core.store,', memories=',core.store?Object.keys(core.store.memories).length:0);
if(!core.settings.enabled){console.log('[NM] inject SKIP: disabled');return;}
const c=getCtx();
if(!c||!c.chat||!c.chat.length){console.log('[NM] inject SKIP: no chat');return;}

// Letzte User-Nachricht finden
let lastUserMsg='';
for(let i=c.chat.length-1;i>=0;i--){
if(c.chat[i].is_user){lastUserMsg=c.chat[i].mes;break}
}
if(!lastUserMsg){console.log('[NM] inject SKIP: no user message found');return;}
console.log('[NM] inject: query=',lastUserMsg.substring(0,80));

const memContext=core.retrieveForMessage(lastUserMsg);
console.log('[NM] inject: memContext length=',memContext?.length||0,', lastInjected=',core.lastInjected.length);
if(!memContext){console.log('[NM] inject SKIP: retrieveForMessage returned empty');return;}

// IN_CHAT (1) mit Tiefe 2 - erscheint kurz vor dem letzten Message (besser fuer RAG)
c.setExtensionPrompt(
MODULE_NAME,memContext,
1,// IN_CHAT
core.settings.injectionDepth,
false,
core.settings.injectionRole
);
console.log('[NM] Injected',core.lastInjected.length,'memories into prompt (depth='+core.settings.injectionDepth+')');
}

// Test-Extraction: Pipeline manuell ausfuehren
async function doTestExtraction(){
setStatus('Testing extraction...');
showDebug('');
const c=getCtx();
if(!c||!c.chat||c.chat.length<2){
setStatus('Error: Need at least 2 messages in chat',true);
showDebug('Chat has '+(c?.chat?.length||0)+' messages. Need at least 2.');
return;
}
if(!core.charId||!core.store){
setStatus('Error: No character loaded',true);
showDebug('charId='+core.charId+', store='+(core.store?'yes':'null'));
return;
}

const chatSnapshot=c.chat.map(m=>({is_user:m.is_user,name:m.name,mes:m.mes}));
const generateFn=core._generateFn;

if(!generateFn){
setStatus('Error: generateFn not set',true);
showDebug('core._generateFn is null. Is an AI API configured?');
return;
}

try{
console.log('[NM] TEST: calling extractMemories with',chatSnapshot.length,'messages');
showDebug('Calling extraction with '+chatSnapshot.length+' messages...');

const newMems=await extractMemories(
generateFn,chatSnapshot,core.charId,
core.settings.extractContextMessages
);

if(newMems.length){
const{integrateMemories}=await import('./src/extraction.js');
const{saveStore}=await import('./src/store.js');
integrateMemories(core.store,newMems);
await saveStore(core.store);
setStatus(`Test OK: Extracted ${newMems.length} memories!`);
let dbg=`Extracted ${newMems.length} memories:\n`;
for(const m of newMems){
dbg+=`\n[${m.type}] ${m.content}\n  entities: ${m.entities.join(', ')}\n  keywords: ${m.keywords.join(', ')}\n  importance: ${m.importance}\n`;
}
showDebug(dbg);
}else{
setStatus('Test: 0 memories extracted');
showDebug('extractMemories returned empty array. Check browser console for [NM] logs.');
}
updateUI();
}catch(e){
console.error('[NM] TEST extraction error',e);
setStatus('Test Error: '+e.message,true);
showDebug('Error: '+e.message+'\n\nStack: '+e.stack);
}
}

// UI
function buildSettingsHTML(){
const s=core.settings;
return`
<div id="nm_settings" class="nm-panel">
<div class="inline-drawer">
<div class="inline-drawer-toggle inline-drawer-header">
<b data-i18n="NeuroMemory">NeuroMemory</b>
<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
</div>
<div class="inline-drawer-content">

<div class="nm-section">
<label class="checkbox_label">
<input type="checkbox" id="nm_enabled" ${s.enabled?'checked':''}>
<span data-i18n="Enabled">Enabled</span>
</label>
</div>

<div class="inline-drawer nm-prompt-drawer">
<div class="inline-drawer-toggle inline-drawer-header nm-prompt-toggle">
<span data-i18n="Extraction Prompt">Extraction Prompt</span>
<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
</div>
<div class="inline-drawer-content">
<textarea id="nm_extractPrompt" class="nm-prompt-textarea text_pole" rows="12"></textarea>
<div class="nm-prompt-actions">
<button id="nm_resetPrompt" class="menu_button" title="Auf Standard-Prompt zurücksetzen">
<i class="fa-solid fa-rotate-left"></i> Reset to Default
</button>
<span id="nm_promptHint" class="nm-prompt-hint">Leer = Standard-Prompt wird verwendet</span>
</div>
</div>
</div>

<div id="nm_status" class="nm-status"></div>

<hr>
<h4 data-i18n="Retrieval">Retrieval</h4>
<label>Top-K Memories <input type="number" id="nm_topK" value="${s.topK}" min="1" max="50" class="text_pole nm-input"></label>
<label>Max Context Tokens <input type="number" id="nm_maxContextTokens" value="${s.maxContextTokens}" min="50" max="2000" class="text_pole nm-input"></label>
<label>Injection Depth <input type="number" id="nm_injectionDepth" value="${s.injectionDepth}" min="0" max="100" class="text_pole nm-input"></label>

<hr>
<h4 data-i18n="Extraction">Extraction</h4>
<label>Extract every N messages <input type="number" id="nm_extractEveryN" value="${s.extractEveryN}" min="1" max="20" class="text_pole nm-input"></label>
<label>Context messages for extraction <input type="number" id="nm_extractContextMessages" value="${s.extractContextMessages}" min="2" max="10" class="text_pole nm-input"></label>

<hr>
<h4 data-i18n="Memory Behavior">Memory Behavior</h4>
<label>Half-life (days) <input type="number" id="nm_halfLifeDays" value="${s.halfLifeDays}" min="1" max="365" class="text_pole nm-input"></label>
<label>Emotion factor <input type="number" id="nm_emotionFactor" value="${s.emotionFactor}" min="0" max="2" step="0.1" class="text_pole nm-input"></label>
<label>Consolidate every N msg <input type="number" id="nm_consolidateEveryN" value="${s.consolidateEveryN}" min="1" max="100" class="text_pole nm-input"></label>
<label>Max memories per char <input type="number" id="nm_maxMemories" value="${s.maxMemories}" min="10" max="5000" class="text_pole nm-input"></label>
<label>Activation hops <input type="number" id="nm_activationHops" value="${s.activationHops}" min="1" max="5" class="text_pole nm-input"></label>
<label>Activation threshold <input type="number" id="nm_activationThreshold" value="${s.activationThreshold}" min="0.01" max="0.5" step="0.01" class="text_pole nm-input"></label>

<hr>
<h4 data-i18n="Debug">Debug &amp; Data</h4>
<div id="nm_stats" class="nm-stats"></div>
<div class="nm-buttons">
<button id="nm_testExtraction" class="menu_button">Test Extraction</button>
<button id="nm_showMemories" class="menu_button">Show Memories</button>
<button id="nm_showLastInjected" class="menu_button">Last Injected</button>
<button id="nm_export" class="menu_button">Export</button>
<button id="nm_import" class="menu_button">Import</button>
<button id="nm_clearAll" class="menu_button redWarning">Clear All</button>
</div>

<div class="inline-drawer nm-add-drawer">
<div class="inline-drawer-toggle inline-drawer-header nm-add-toggle">
<span>+ Memory manuell hinzufügen</span>
<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
</div>
<div class="inline-drawer-content">
<textarea id="nm_newMemContent" class="text_pole nm-add-textarea" rows="3" placeholder="Inhalt der Erinnerung... (z.B. 'Veyra ist eine Waldelfin mit magischen Fähigkeiten')"></textarea>
<div class="nm-add-row">
<select id="nm_newMemType" class="text_pole nm-add-select">
<option value="semantic">Semantic (Fakt/Wissen)</option>
<option value="episodic">Episodic (Ereignis)</option>
<option value="emotional">Emotional (Gefühl)</option>
<option value="relational">Relational (Beziehung)</option>
</select>
<label class="nm-add-imp-label">Wichtigkeit:
<input type="range" id="nm_newMemImportance" min="0" max="1" step="0.1" value="0.8" class="nm-imp-range">
<span id="nm_impValue">0.8</span>
</label>
</div>
<input id="nm_newMemEntities" class="text_pole" placeholder="Entities (kommagetrennt): Veyra, Tay" style="margin:3px 0">
<div style="display:flex;align-items:center;gap:6px;margin-top:4px">
<label class="checkbox_label" style="font-size:.85em">
<input type="checkbox" id="nm_newMemPinned">
<span>📌 Gleich anpinnen</span>
</label>
<button id="nm_addMemory" class="menu_button" style="margin-left:auto">+ Hinzufügen</button>
</div>
</div>
</div>

<div id="nm_debugOutput" class="nm-debug"></div>

</div></div></div>`;
}

function bindEvents(){
const on=(id,ev,fn)=>{const el=document.getElementById(id);if(el)el.addEventListener(ev,fn)};

on('nm_enabled','change',e=>{core.settings.enabled=e.target.checked;saveSettings()});
const nums=['topK','maxContextTokens','injectionDepth','extractEveryN','extractContextMessages',
'halfLifeDays','emotionFactor','consolidateEveryN','maxMemories','activationHops','activationThreshold'];
for(const n of nums){
on(`nm_${n}`,'change',e=>{
const v=parseFloat(e.target.value);
if(!isNaN(v)){core.settings[n]=v;saveSettings()}
});
}

on('nm_testExtraction','click',()=>doTestExtraction());
on('nm_showMemories','click',()=>{_browserFilter={type:'all',search:''};showMemoryBrowser();});
on('nm_showLastInjected','click',()=>showLastInjected());
on('nm_export','click',()=>doExport());
on('nm_import','click',()=>doImport());
on('nm_clearAll','click',()=>doClear());
on('nm_addMemory','click',()=>doAddMemory());

// Importance-Slider Anzeige
const impRange=document.getElementById('nm_newMemImportance');
const impVal=document.getElementById('nm_impValue');
if(impRange&&impVal){
impRange.addEventListener('input',()=>{impVal.textContent=parseFloat(impRange.value).toFixed(1)});
}

// Extraction-Prompt Editor
const promptEl=document.getElementById('nm_extractPrompt');
if(promptEl){
// Immer den tatsaechlich verwendeten Prompt anzeigen (Default oder Custom)
const isCustom=!!(core.settings.extractionPrompt&&core.settings.extractionPrompt.trim());
promptEl.value=isCustom?core.settings.extractionPrompt:DEFAULT_EXTRACT_SYSTEM;
const hint=document.getElementById('nm_promptHint');
if(hint)hint.textContent=isCustom?'Benutzerdefinierter Prompt aktiv':'Standard-Prompt (bearbeitbar)';

// Aenderungen speichern: nur wenn Inhalt vom Default abweicht
promptEl.addEventListener('input',()=>{
const val=promptEl.value.trim();
const isDefault=val===DEFAULT_EXTRACT_SYSTEM.trim();
const saveVal=isDefault?'':val;
core.settings.extractionPrompt=saveVal;
setExtractionPrompt(saveVal);
saveSettings();
const hint=document.getElementById('nm_promptHint');
if(hint)hint.textContent=isDefault?'Standard-Prompt (bearbeitbar)':'Benutzerdefinierter Prompt aktiv';
});
}
on('nm_resetPrompt','click',()=>{
const promptEl=document.getElementById('nm_extractPrompt');
if(promptEl){
promptEl.value=DEFAULT_EXTRACT_SYSTEM;
core.settings.extractionPrompt='';
setExtractionPrompt('');
saveSettings();
const hint=document.getElementById('nm_promptHint');
if(hint)hint.textContent='Standard-Prompt (bearbeitbar)';
console.log('[NM] Extraction prompt reset to default');
}
});
}

function updateUI(){
const statsEl=document.getElementById('nm_stats');
if(!statsEl)return;
const s=core.getStats();
if(!s){statsEl.innerHTML='<i>No character loaded</i>';return}
statsEl.innerHTML=`
<div class="nm-stat-row"><b>Memories:</b> ${s.totalMemories} | <b>Entities:</b> ${s.totalEntities}</div>
<div class="nm-stat-row"><b>Types:</b> E:${s.byType.episodic} S:${s.byType.semantic} Em:${s.byType.emotional} R:${s.byType.relational}</div>
<div class="nm-stat-row"><b>Avg Importance:</b> ${s.avgImportance.toFixed(2)} | <b>Avg Retrievability:</b> ${s.avgRetrievability.toFixed(2)}</div>
<div class="nm-stat-row"><b>Last injected:</b> ${s.lastInjectedCount} memories</div>`;
}

// Browser-Filter-State
let _browserFilter={type:'all',search:''};

function renderMemoryBrowser(filter){
if(!filter)filter=_browserFilter;
if(!core.store)return'';
let mems=Object.values(core.store.memories).sort((a,b)=>b.createdAt-a.createdAt);
// Filter anwenden
if(filter.type==='pinned')mems=mems.filter(m=>m.pinned);
else if(filter.type==='user')mems=mems.filter(m=>m.userCreated);
else if(filter.type!=='all')mems=mems.filter(m=>m.type===filter.type);
if(filter.search){
const q=filter.search.toLowerCase();
mems=mems.filter(m=>m.content.toLowerCase().includes(q)||m.entities.some(e=>e.toLowerCase().includes(q)));
}
const ents=Object.values(core.store.entities).sort((a,b)=>b.mentionCount-a.mentionCount);
const total=Object.keys(core.store.memories).length;

// Filter-Controls
const types=['all','episodic','semantic','emotional','relational','pinned','user'];
const typeLabels={all:'Alle',episodic:'Episodic',semantic:'Semantic',emotional:'Emotional',relational:'Relational',pinned:'📌 Pinned',user:'✋ Manuell'};
let filterBtns=types.map(t=>`<button class="nm-filter-btn${filter.type===t?' active':''}" data-action="filter" data-type="${t}">${typeLabels[t]}</button>`).join('');

let html=`<div class="nm-browser-controls">
<input id="nm_memSearch" class="text_pole nm-search-input" placeholder="Suchen..." value="${escHtml(filter.search)}">
<div class="nm-type-filters">${filterBtns}</div>
</div>
<h3>Memories (${mems.length}/${total})</h3><div class="nm-mem-list">`;

for(const m of mems.slice(0,150)){
const age=((Date.now()-m.createdAt)/86400000).toFixed(1);
const pinLabel=m.pinned?'📌':'📍';
const pinTitle=m.pinned?'Unpin':'Pin (immer injizieren)';
const userBadge=m.userCreated?'<span class="nm-user-badge" title="Manuell erstellt">✋</span>':'';
html+=`<div class="nm-mem-item nm-type-${m.type}${m.pinned?' nm-pinned':''}" data-memid="${escHtml(m.id)}">
<div class="nm-mem-header">
<span class="nm-badge">${m.type}</span>${userBadge}
<span class="nm-imp">imp:${m.importance.toFixed(2)}</span>
<span class="nm-ret">ret:${m.retrievability.toFixed(2)}</span>
<span class="nm-age">${age}d</span>
<div class="nm-mem-actions">
<button class="nm-action-btn" data-action="pin" data-memid="${escHtml(m.id)}" title="${pinTitle}">${pinLabel}</button>
<button class="nm-action-btn" data-action="edit" data-memid="${escHtml(m.id)}" title="Bearbeiten">✏️</button>
<button class="nm-action-btn nm-del-btn" data-action="delete" data-memid="${escHtml(m.id)}" title="Löschen">✕</button>
</div>
</div>
<div class="nm-mem-content">${escHtml(m.content)}</div>
<div class="nm-mem-meta">Entities: ${m.entities.join(', ')} | Keywords: ${m.keywords.join(', ')}</div>
</div>`;
}
html+=`</div><h3>Entities (${ents.length})</h3><div class="nm-ent-list">`;
for(const e of ents.slice(0,50)){
html+=`<div class="nm-ent-item"><b>${escHtml(e.name)}</b> [${e.type}] mentions:${e.mentionCount}</div>`;
}
html+='</div>';
return html;
}

function showMemoryBrowser(){
if(!core.store){showDebug('No character loaded');return}
const debugEl=document.getElementById('nm_debugOutput');
if(!debugEl)return;
debugEl.innerHTML=`<div class="nm-browser-panel">${renderMemoryBrowser()}</div>`;
const panel=debugEl.querySelector('.nm-browser-panel');

// Suche
const searchEl=panel.querySelector('#nm_memSearch');
if(searchEl){
searchEl.addEventListener('input',()=>{
_browserFilter.search=searchEl.value;
panel.innerHTML=renderMemoryBrowser();
attachBrowserEvents(panel);
});
}

attachBrowserEvents(panel);
}

function attachBrowserEvents(panel){
// Suchfeld neu binden nach re-render
const searchEl=panel.querySelector('#nm_memSearch');
if(searchEl&&!searchEl._nmBound){
searchEl._nmBound=true;
searchEl.addEventListener('input',()=>{
_browserFilter.search=searchEl.value;
panel.innerHTML=renderMemoryBrowser();
attachBrowserEvents(panel);
});
}

// Event-Delegation fuer alle Actions
panel.onclick=async e=>{
const btn=e.target.closest('[data-action]');
if(!btn||!core.store)return;
e.stopPropagation();
const action=btn.dataset.action;
const memId=btn.dataset.memid;

if(action==='filter'){
_browserFilter.type=btn.dataset.type;
panel.innerHTML=renderMemoryBrowser();
attachBrowserEvents(panel);
return;
}

if(action==='pin'){
const mem=core.store.memories[memId];
if(!mem)return;
updateMemory(core.store,memId,{pinned:!mem.pinned});
await saveStore(core.store);
panel.innerHTML=renderMemoryBrowser();
attachBrowserEvents(panel);
return;
}

if(action==='edit'){
const item=btn.closest('.nm-mem-item');
const contentEl=item.querySelector('.nm-mem-content');
const oldText=contentEl.textContent;
contentEl.innerHTML=`<textarea class="nm-edit-textarea text_pole">${escHtml(oldText)}</textarea>
<div class="nm-edit-actions">
<button class="menu_button" data-action="save-edit" data-memid="${escHtml(memId)}">✓ Speichern</button>
<button class="menu_button" data-action="cancel-edit">✗ Abbrechen</button>
</div>`;
const ta=contentEl.querySelector('textarea');
if(ta){ta.focus();ta.setSelectionRange(ta.value.length,ta.value.length)}
return;
}

if(action==='save-edit'){
const ta=btn.closest('.nm-mem-item')?.querySelector('.nm-edit-textarea');
if(!ta)return;
const newContent=ta.value.trim();
if(newContent){updateMemory(core.store,memId,{content:newContent});}
await saveStore(core.store);
panel.innerHTML=renderMemoryBrowser();
attachBrowserEvents(panel);
return;
}

if(action==='cancel-edit'){
panel.innerHTML=renderMemoryBrowser();
attachBrowserEvents(panel);
return;
}

if(action==='delete'){
const mem=core.store.memories[memId];
if(!mem)return;
if(!confirm(`Memory löschen?\n"${mem.content.substring(0,80)}"`))return;
removeMemory(core.store,memId);
await saveStore(core.store);
updateUI();
panel.innerHTML=renderMemoryBrowser();
attachBrowserEvents(panel);
return;
}
};
}

function showLastInjected(){
const results=core.getLastInjected();
if(!results.length){showDebug('No memories injected in last generation.');return}
let html='<h3>Last Injected ('+results.length+')</h3>';
for(const r of results){
html+=`<div class="nm-mem-item nm-type-${r.memory.type}">
<div class="nm-mem-header"><span class="nm-badge">${r.memory.type}</span> score:${r.score.toFixed(3)} act:${r.activation.toFixed(3)} ret:${r.retrievability.toFixed(3)}</div>
<div class="nm-mem-content">${escHtml(r.memory.content)}</div></div>`;
}
showPopup('Last Injected Memories',html);
}

async function doAddMemory(){
const contentEl=document.getElementById('nm_newMemContent');
const content=contentEl?contentEl.value.trim():'';
if(!content){setStatus('Bitte Inhalt eingeben',true);return}
if(!core.store||!core.charId){setStatus('Kein Charakter geladen',true);return}
const type=document.getElementById('nm_newMemType')?.value||'semantic';
const importance=parseFloat(document.getElementById('nm_newMemImportance')?.value||'0.8');
const entitiesRaw=document.getElementById('nm_newMemEntities')?.value||'';
const entities=entitiesRaw.split(',').map(s=>s.trim()).filter(Boolean);
const pinned=document.getElementById('nm_newMemPinned')?.checked||false;
const t=Date.now();
const mem={
id:uid(),
characterId:core.charId,
type,
content,
entities,
keywords:extractKeywords(content),
importance:isNaN(importance)?0.8:Math.max(0,Math.min(1,importance)),
emotionalValence:0,
emotionalIntensity:0,
stability:2.0,// hohe Stabilitaet fuer manuell erstellte Memories
retrievability:1.0,
accessCount:0,
createdAt:t,
lastAccessedAt:t,
lastReinforcedAt:t,
sourceMessageIds:[],
connections:[],
pinned,
userCreated:true,
};
addMemory(core.store,mem);
updateMemoryConnections(core.store);
await saveStore(core.store);
updateUI();
// Formular leeren
if(contentEl)contentEl.value='';
const entEl=document.getElementById('nm_newMemEntities');if(entEl)entEl.value='';
const pinnedCb=document.getElementById('nm_newMemPinned');if(pinnedCb)pinnedCb.checked=false;
setStatus(`Memory hinzugefügt: "${content.substring(0,50)}..."`);
// Browser aktualisieren falls sichtbar
const panel=document.querySelector('.nm-browser-panel');
if(panel){panel.innerHTML=renderMemoryBrowser();attachBrowserEvents(panel);}
console.log('[NM] manual memory added:',mem.id,content.substring(0,50));
}

async function doExport(){
const charId=getCharId();
if(!charId){showDebug('No character loaded');return}
const json=await exportStore(charId);
const blob=new Blob([json],{type:'application/json'});
const url=URL.createObjectURL(blob);
const a=document.createElement('a');
a.href=url;a.download=`neuromemory_${charId}.json`;
a.click();URL.revokeObjectURL(url);
showDebug('Exported successfully');
}

async function doImport(){
const input=document.createElement('input');
input.type='file';input.accept='.json';
input.onchange=async e=>{
const file=e.target.files[0];if(!file)return;
const text=await file.text();
try{
const store=await importStore(text);
if(store.characterId===core.charId){
core.store=store;
updateUI();
showDebug(`Imported ${Object.keys(store.memories).length} memories`);
}else{
showDebug(`Imported store for ${store.characterName||store.characterId}`);
}
}catch(err){showDebug('Import error: '+err.message)}
};
input.click();
}

async function doClear(){
if(!core.store||!core.charId)return;
const c=getCtx();
if(c&&c.callGenericPopup){
const result=await c.callGenericPopup('Clear ALL memories for this character? This cannot be undone.',c.POPUP_TYPE.CONFIRM);
if(result!==c.POPUP_RESULT.AFFIRMATIVE)return;
}
await deleteStore(core.charId);
await core.loadCharacter(core.charId,core.charName);
updateUI();
showDebug('All memories cleared');
}

function showDebug(msg){
const el=document.getElementById('nm_debugOutput');
if(el)el.textContent=msg;
}

function showPopup(title,html){
const c=getCtx();
if(c&&c.callGenericPopup){
c.callGenericPopup(`<div class="nm-popup"><h2>${title}</h2>${html}</div>`,c.POPUP_TYPE.TEXT);
}else{
const el=document.getElementById('nm_debugOutput');
if(el)el.innerHTML=html;
}
}

function escHtml(s){
return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Fuer Textarea-Inhalt: nur < > & escapen (kein quot noetig bei textContent)
function escHtmlAttr(s){
return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Eigene Generate-Funktion die reasoning_content (DeepSeek-Reasoner) korrekt verarbeitet
async function nmGenerate(opts){
const ctx=getCtx();
if(!ctx)throw new Error('No SillyTavern context');

// Fuer Chat-Completion-APIs: direkter API-Call um reasoning_content zu erhalten
if(ctx.mainApi==='openai'){
const settings=ctx.chatCompletionSettings;
const model=ctx.getChatCompletionModel(settings);
console.log('[NM] nmGenerate: direct API call, source=',settings.chat_completion_source,', model=',model);

const requestBody={
chat_completion_source:settings.chat_completion_source,
model:model,
messages:[{role:'user',content:opts.quietPrompt}],
temperature:Number(settings.temp_openai),
max_tokens:opts.responseLength||8192,
stream:false,
frequency_penalty:Number(settings.freq_pen_openai),
presence_penalty:Number(settings.pres_pen_openai),
top_p:Number(settings.top_p_openai),
};

// Proxy-Settings uebernehmen
if(settings.reverse_proxy){
requestBody.reverse_proxy=settings.reverse_proxy;
requestBody.proxy_password=settings.proxy_password;
}

const response=await fetch('/api/backends/chat-completions/generate',{
method:'POST',
headers:ctx.getRequestHeaders(),
body:JSON.stringify(requestBody),
});

if(!response.ok){
const errText=await response.text();
console.error('[NM] API error:',response.status,errText);
throw new Error(`API error: ${response.status}`);
}

const data=await response.json();
if(data.error){
throw new Error(data.error.message||'API error');
}

const finishReason=data?.choices?.[0]?.finish_reason||'unknown';
const usage=data?.usage;
console.log('[NM] API finish_reason=',finishReason,', usage=',JSON.stringify(usage));

const msg=data?.choices?.[0]?.message;
if(!msg){console.warn('[NM] no message in response');return''}

let text=msg.content||'';
const reasoning=msg.reasoning_content||'';
console.log('[NM] API response: content.length=',text.length,', reasoning.length=',reasoning.length);

if(reasoning){
// Reasoning in <think>-Tags wrappen (unser Parser verarbeitet das)
text='<think>'+reasoning+'</think>'+text;
}

return text;
}

// Fallback fuer Text-Completion-APIs: Standard generateQuietPrompt
console.log('[NM] nmGenerate: using generateQuietPrompt fallback');
return ctx.generateQuietPrompt(opts);
}

// Init
jQuery(async function(){
try{
console.log('[NM] init start');
const c=getCtx();
if(!c){console.error('[NM] Could not get context');return}
console.log('[NM] context ok');

// UI einfuegen
const settingsContainer=document.getElementById('extensions_settings2');
if(settingsContainer){
settingsContainer.insertAdjacentHTML('beforeend',buildSettingsHTML());
bindEvents();
console.log('[NM] UI inserted');
}else{console.warn('[NM] no extensions_settings2 container')}

// Context-Getter an Store weitergeben (fuer persistente extensionSettings-Speicherung)
setContextGetter(getCtx);

loadSettings();
syncUIFromSettings();
console.log('[NM] settings loaded',JSON.stringify(core.settings).substring(0,100));
core.setGenerateFn(nmGenerate);
console.log('[NM] generateFn set (nmGenerate with reasoning support)');

// Events - CHAT_CHANGED und CHAT_LOADED abfangen
c.eventSource.on(c.eventTypes.CHAT_CHANGED,onChatChanged);
c.eventSource.on(c.eventTypes.CHAT_LOADED,onChatChanged);
c.eventSource.on(c.eventTypes.MESSAGE_RECEIVED,onMessageReceived);
// GENERATION_STARTED feuert fuer ALLE APIs (inkl. OpenAI/Chat-Completions)
// GENERATE_BEFORE_COMBINE_PROMPTS feuert NUR fuer Text-Completion-APIs - daher nicht verwendbar
c.eventSource.on(c.eventTypes.GENERATION_STARTED,onGenerateBefore);
console.log('[NM] events registered');

// Initial laden wenn Chat bereits offen
const charId=getCharId(c);
console.log('[NM] initial charId:',charId);
if(charId){
await core.loadCharacter(charId,getCharName(c));
console.log('[NM] initial character loaded');
}
updateUI();

console.log('[NM] NeuroMemory initialized');
}catch(e){console.error('[NM] INIT ERROR',e)}
});
