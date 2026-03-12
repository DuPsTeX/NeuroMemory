import{NeuroMemoryCore,defaultSettings}from'./src/core.js';
import{exportStore,importStore,loadStore,deleteStore,setContextGetter}from'./src/store.js';
import{extractMemories}from'./src/extraction.js';

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
if(!core.settings.enabled)return;
const c=getCtx();
if(!c||!c.chat||!c.chat.length)return;
// Letzte User-Nachricht finden
let lastUserMsg='';
for(let i=c.chat.length-1;i>=0;i--){
if(c.chat[i].is_user){lastUserMsg=c.chat[i].mes;break}
}
if(!lastUserMsg)return;

const memContext=core.retrieveForMessage(lastUserMsg);
if(!memContext)return;

c.setExtensionPrompt(
MODULE_NAME,memContext,
core.settings.injectionPosition,
core.settings.injectionDepth,
false,
core.settings.injectionRole
);
console.log('[NM] Injected',core.lastInjected.length,'memories');
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
on('nm_showMemories','click',()=>showMemoryBrowser());
on('nm_showLastInjected','click',()=>showLastInjected());
on('nm_export','click',()=>doExport());
on('nm_import','click',()=>doImport());
on('nm_clearAll','click',()=>doClear());
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

function showMemoryBrowser(){
const s=core.getStats();
if(!core.store)return;
const mems=Object.values(core.store.memories).sort((a,b)=>b.createdAt-a.createdAt);
const ents=Object.values(core.store.entities).sort((a,b)=>b.mentionCount-a.mentionCount);
let html='<h3>Memories ('+mems.length+')</h3><div class="nm-mem-list">';
for(const m of mems.slice(0,100)){
const age=((Date.now()-m.createdAt)/86400000).toFixed(1);
html+=`<div class="nm-mem-item nm-type-${m.type}">
<div class="nm-mem-header"><span class="nm-badge">${m.type}</span> <span class="nm-imp">imp:${m.importance.toFixed(2)}</span> <span class="nm-ret">ret:${m.retrievability.toFixed(2)}</span> <span class="nm-age">${age}d ago</span></div>
<div class="nm-mem-content">${escHtml(m.content)}</div>
<div class="nm-mem-meta">Entities: ${m.entities.join(', ')} | Keywords: ${m.keywords.join(', ')} | Connections: ${m.connections.length}</div>
</div>`;
}
html+='</div><h3>Entities ('+ents.length+')</h3><div class="nm-ent-list">';
for(const e of ents.slice(0,50)){
html+=`<div class="nm-ent-item"><b>${escHtml(e.name)}</b> [${e.type}] mentions:${e.mentionCount} connections:${e.connections.length}</div>`;
}
html+='</div>';
showPopup('NeuroMemory Browser',html);
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
console.log('[NM] settings loaded',JSON.stringify(core.settings).substring(0,100));
core.setGenerateFn(nmGenerate);
console.log('[NM] generateFn set (nmGenerate with reasoning support)');

// Events - CHAT_CHANGED und CHAT_LOADED abfangen
c.eventSource.on(c.eventTypes.CHAT_CHANGED,onChatChanged);
c.eventSource.on(c.eventTypes.CHAT_LOADED,onChatChanged);
c.eventSource.on(c.eventTypes.MESSAGE_RECEIVED,onMessageReceived);
c.eventSource.on(c.eventTypes.GENERATE_BEFORE_COMBINE_PROMPTS,onGenerateBefore);
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
