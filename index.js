import{NeuroMemoryCore,defaultSettings}from'./src/core.js';
import{exportStore,importStore,loadStore,deleteStore,setContextGetter,removeMemory,saveStore,addMemory,updateMemory}from'./src/store.js';
import{extractMemories,integrateMemories,setExtractionPrompt,getExtractionPrompt,DEFAULT_EXTRACT_SYSTEM}from'./src/extraction.js';
import{uid,extractKeywords}from'./src/utils.js';
import{updateMemoryConnections}from'./src/network.js';

const MODULE_NAME='neuro-memory';
const core=new NeuroMemoryCore();

const CARD_EXTRACT_SYSTEM=`You are a memory extraction system for character backstories. Analyze this character description and extract factual memories as a JSON array.

Each memory object must have:
- "content": string (concise fact, 1-2 sentences max)
- "type": "semantic"|"relational" (NO episodic — nothing happened yet in the story)
- "subtype": null|"appearance" (use "appearance" for physical descriptions: hair, eyes, clothing, scars, body type, etc.)
- "entities": string[] (named characters, places, objects mentioned)
- "keywords": string[] (3-8 important lowercase keywords)
- "emotionalValence": number (-1.0 to 1.0, usually 0 for background facts)
- "emotionalIntensity": number (0.0 to 1.0)
- "importance": number (0.5-1.0, backstory facts are usually important)

Rules:
- Extract personality traits, abilities, relationships, history, motivations
- ALWAYS extract appearance as separate memories with subtype "appearance" — one per character if multiple are described
- Maximum 8 memories. Be concise, no fluff.
- Respond ONLY with a valid JSON array, no markdown, no explanation`;

const LOREBOOK_EXTRACT_SYSTEM=`You are a memory extraction system for world-building lore entries. Analyze the following lorebook entries and extract properly categorized memories as a JSON array.

Each memory object must have:
- "content": string (concise fact, 1-2 sentences max)
- "type": "semantic"|"relational"|"episodic"|"emotional"
  - semantic: facts, descriptions, abilities, locations, items, rules
  - relational: relationships between characters, factions, alliances
  - episodic: historical events, battles, past incidents
  - emotional: emotionally charged lore (traumas, oaths, deep bonds)
- "subtype": null|"appearance"|"plot" (optional)
  - "appearance": physical descriptions of characters (hair, eyes, clothing, scars, body type) — use type "semantic"
  - "plot": key story/historical events with time context — use type "episodic"
  - null: for everything else
- "entities": string[] (named characters, places, objects, factions)
- "keywords": string[] (3-8 important lowercase keywords)
- "emotionalValence": number (-1.0 to 1.0, usually 0 for lore facts)
- "emotionalIntensity": number (0.0 to 1.0)
- "importance": number (0.5-1.0, lore is usually important)

Rules:
- One lorebook entry may produce MULTIPLE memories if it contains different types of information
- ALWAYS extract appearance as separate memories with subtype "appearance"
- ALWAYS extract historical events as episodic with subtype "plot" where applicable
- Extract relationships between characters/factions as "relational"
- Maximum 3 memories per lorebook entry, be concise
- Respond ONLY with a valid JSON array, no markdown, no explanation`;

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
const ppCb=document.getElementById('nm_proactivePrompt');if(ppCb)ppCb.checked=!!s.proactivePrompt;
set('nm_digestEveryN',s.digestEveryN??15);
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

// Flag: nur extrahieren wenn der User tatsaechlich eine neue Nachricht gesendet hat (kein Regen-Guard)
let _userMessageSent=false;

function onUserMessageSent(){
_userMessageSent=true;
console.log('[NM] MESSAGE_SENT: flagged for extraction');
}

// KRITISCHER FIX: Non-blocking extraction mit Delay
function onMessageReceived(msgIdx){
console.log('[NM] MESSAGE_RECEIVED fired, msgIdx:',msgIdx);

// Regenerierungs-Guard: nur extrahieren wenn vorher eine echte User-Nachricht gesendet wurde
if(!_userMessageSent){
console.log('[NM] SKIP: regeneration detected (no new user message preceded this response)');
return;
}
_userMessageSent=false;

if(!core.settings.enabled){
console.log('[NM] skipped: extension disabled');
return;
}
const c=getCtx();
if(!c){console.log('[NM] skipped: no context');return}
if(!c.chat){console.log('[NM] skipped: no chat');return}
if(c.chat.length<2){console.log('[NM] skipped: chat.length=',c.chat.length,'(need >=2)');return}

console.log('[NM] chat has',c.chat.length,'messages, scheduling extraction...');

// Selective Reinforcement: KI-Antwort gegen injizierte Memories pruefen
const lastMsg=c.chat[c.chat.length-1];
if(lastMsg&&!lastMsg.is_user&&lastMsg.mes){
core.applySelectiveReinforcement(lastMsg.mes);
saveStore(core.store).catch(e=>console.warn('[NM] save after selective reinforce failed',e));
}

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

// Chat-Messages fuer Themen-Tracking uebergeben
const chatMsgs=c.chat.map(m=>({is_user:m.is_user,name:m.name,mes:m.mes}));
const{context:memContext,hint}=core.retrieveForMessage(lastUserMsg,chatMsgs);
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

// Dynamic Injection Hint (kontextabhaengig statt generisch)
if(hint){
c.setExtensionPrompt(MODULE_NAME+'_hint',hint,0,0,false,0);// IN_PROMPT
console.log('[NM] injected dynamic hint:',hint.substring(0,80));
}else{
c.setExtensionPrompt(MODULE_NAME+'_hint','',0,0,false,0);
}
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
<label>Digest alle N Memories <input type="number" id="nm_digestEveryN" value="${s.digestEveryN}" min="5" max="100" class="text_pole nm-input"></label>
<label class="checkbox_label" style="margin-top:4px">
<input type="checkbox" id="nm_proactivePrompt" ${s.proactivePrompt?'checked':''}>
<span style="font-size:.9em">Proaktive Memory-Nutzung (KI baut Memories natürlich ein)</span>
</label>

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
<div id="nm_cardImportRow" style="display:none;margin:4px 0;padding:4px 0">
<button id="nm_importCard" class="menu_button nm-import-card-btn">📥 Aus Character Card importieren</button>
<span style="font-size:.75em;opacity:.6;display:block;margin-top:2px">Backstory-Fakten direkt aus der Character Card als Memories extrahieren</span>
</div>

<div id="nm_lorebookImportRow" style="display:none;margin:4px 0;padding:4px 0">
<button id="nm_importLorebook" class="menu_button nm-import-card-btn">🧠 Smart-Import aus Lorebook</button>
<span style="font-size:.75em;opacity:.6;display:block;margin-top:2px">KI analysiert Lorebook-Einträge und kategorisiert sie korrekt (Aussehen, Story, Beziehungen, Fakten)</span>
</div>

<div class="inline-drawer nm-textimport-drawer">
<div class="inline-drawer-toggle inline-drawer-header nm-add-toggle">
<span>📋 Text zu Memories importieren</span>
<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
</div>
<div class="inline-drawer-content">
<textarea id="nm_importText" class="text_pole nm-add-textarea" rows="5" placeholder="Füge beliebigen Text ein — Session-Zusammenfassung, Lore, Charakternotizen..."></textarea>
<div style="display:flex;gap:6px;align-items:center;margin-top:4px">
<button id="nm_doTextImport" class="menu_button">📋 Importieren</button>
<span style="font-size:.75em;opacity:.6">KI extrahiert passende Memories aus dem Text</span>
</div>
</div>
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
<option value="semantic:appearance">👤 Aussehen (Erscheinungsbild)</option>
<option value="episodic:plot">📖 Story (Handlungsereignis)</option>
</select>
<label class="nm-add-imp-label">Wichtigkeit:
<input type="range" id="nm_newMemImportance" min="0" max="1" step="0.1" value="0.8" class="nm-imp-range">
<span id="nm_impValue">0.8</span>
</label>
</div>
<input id="nm_newMemEntities" class="text_pole" placeholder="Entities (kommagetrennt): Veyra, Tay" style="margin:3px 0">
<div class="nm-add-row">
<label class="nm-add-emo-label">😔 <input type="range" id="nm_newMemValence" min="-1" max="1" step="0.1" value="0" class="nm-emo-range"> 😊 <span id="nm_valenceValue">0.0</span></label>
<label class="nm-add-emo-label">⚡ Intensität: <input type="range" id="nm_newMemIntensity" min="0" max="1" step="0.1" value="0" class="nm-emo-range"> <span id="nm_intensityValue">0.0</span></label>
</div>
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
'halfLifeDays','emotionFactor','consolidateEveryN','maxMemories','activationHops','activationThreshold','digestEveryN'];
for(const n of nums){
on(`nm_${n}`,'change',e=>{
const v=parseFloat(e.target.value);
if(!isNaN(v)){core.settings[n]=v;saveSettings()}
});
}

on('nm_proactivePrompt','change',e=>{core.settings.proactivePrompt=e.target.checked;saveSettings()});
on('nm_testExtraction','click',()=>doTestExtraction());
on('nm_showMemories','click',()=>{_browserFilter={type:'all',search:''};_browserShowCount=50;showMemoryBrowser();});
on('nm_importCard','click',()=>doImportFromCard());
on('nm_doTextImport','click',()=>doImportFromText());
on('nm_importLorebook','click',()=>doImportFromLorebook());
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
// Emotions-Slider Anzeige
const valRange=document.getElementById('nm_newMemValence');
const valVal=document.getElementById('nm_valenceValue');
if(valRange&&valVal){
valRange.addEventListener('input',()=>{valVal.textContent=parseFloat(valRange.value).toFixed(1)});
}
const intRange=document.getElementById('nm_newMemIntensity');
const intVal=document.getElementById('nm_intensityValue');
if(intRange&&intVal){
intRange.addEventListener('input',()=>{intVal.textContent=parseFloat(intRange.value).toFixed(1)});
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
<div class="nm-stat-row"><b>Types:</b> E:${s.byType.episodic} S:${s.byType.semantic} Em:${s.byType.emotional} R:${s.byType.relational} 👤:${s.bySubtype?.appearance||0} 📖:${s.bySubtype?.plot||0}</div>
<div class="nm-stat-row"><b>Avg Importance:</b> ${s.avgImportance.toFixed(2)} | <b>Avg Retrievability:</b> ${s.avgRetrievability.toFixed(2)}</div>
<div class="nm-stat-row"><b>Last injected:</b> ${s.lastInjectedCount} memories</div>`;
const mood=core.store?getMoodSummary(core.store):null;
if(mood){
const strongest=mood.strongest;
statsEl.innerHTML+=`<div class="nm-mood-summary">💭 ${mood.pos}% positiv · ${mood.neu}% neutral · ${mood.neg}% negativ${strongest?`<div class="nm-mood-strongest">🔥 "${escHtml(strongest.content.substring(0,50))}..." (${strongest.emotionalIntensity.toFixed(2)})</div>`:''}</div>`;
}
// Fading Memory Alert
const fadingMems=core.store?Object.values(core.store.memories).filter(m=>!m.pinned&&(m.retrievability||0)<0.25):[];
if(fadingMems.length){
statsEl.innerHTML+=`<div class="nm-fading-alert">⚠️ ${fadingMems.length} ${fadingMems.length===1?'Memory verblasst':'Memories verblassen'} <button id="nm_reinforceFading" class="nm-action-btn" title="Stabilität auffrischen">🔄 Auffrischen</button></div>`;
const rfBtn=document.getElementById('nm_reinforceFading');
if(rfBtn)rfBtn.addEventListener('click',()=>doReinforceFading());
}
// Card-Import Button: sichtbar wenn Store geladen aber noch kein Import
const cardRow=document.getElementById('nm_cardImportRow');
if(cardRow){
const show=!!(core.store&&!core.store.meta?.cardImported);
cardRow.style.display=show?'':'none';
}
const lbRow=document.getElementById('nm_lorebookImportRow');
if(lbRow)lbRow.style.display=core.store?'':'none';
}

// Browser-Filter-State
let _browserFilter={type:'all',search:''};
let _browserShowCount=50;// Virtuelles Scrolling: zeige nur N Memories initial
let _searchDebounceTimer=null;

function renderTimeline(memories){
const sorted=[...memories].filter(m=>m.emotionalIntensity>0.1).sort((a,b)=>a.createdAt-b.createdAt).slice(-40);
if(sorted.length<3)return'';
const bars=sorted.map(m=>{
const h=Math.max(10,Math.round(m.emotionalIntensity*100));
const v=m.emotionalValence;
const color=v>0.2?'#4caf50':v<-0.2?'#f44336':'#9e9e9e';
return`<div class="nm-arc-bar" style="height:${h}%;background:${color}" title="${escHtmlAttr(m.content.slice(0,80))}"></div>`;
}).join('');
return`<div class="nm-arc-section"><div class="nm-arc-label">📊 Emotional Arc (${sorted.length} Memories)</div><div class="nm-arc-bars">${bars}</div><div class="nm-arc-legend"><span style="color:#f44336">■</span> Negativ &nbsp; <span style="color:#9e9e9e">■</span> Neutral &nbsp; <span style="color:#4caf50">■</span> Positiv</div></div>`;
}

function getMoodSummary(store){
const mems=Object.values(store.memories).filter(m=>m.emotionalIntensity>0.1);
if(mems.length<3)return null;
const pos=mems.filter(m=>m.emotionalValence>0.2).length;
const neg=mems.filter(m=>m.emotionalValence<-0.2).length;
const neu=mems.length-pos-neg;
const pct=n=>Math.round(n/mems.length*100);
const strongest=[...mems].sort((a,b)=>b.emotionalIntensity-a.emotionalIntensity)[0];
return{pos:pct(pos),neu:pct(neu),neg:pct(neg),strongest};
}

function renderMemoryBrowser(filter){
if(!filter)filter=_browserFilter;
if(!core.store)return'';
let mems=Object.values(core.store.memories).sort((a,b)=>b.createdAt-a.createdAt);
// Filter anwenden
if(filter.type==='pinned')mems=mems.filter(m=>m.pinned);
else if(filter.type==='user')mems=mems.filter(m=>m.userCreated);
else if(filter.type==='appearance')mems=mems.filter(m=>m.subtype==='appearance');
else if(filter.type==='plot')mems=mems.filter(m=>m.subtype==='plot');
else if(filter.type!=='all')mems=mems.filter(m=>m.type===filter.type);
if(filter.search){
const q=filter.search.toLowerCase();
mems=mems.filter(m=>m.content.toLowerCase().includes(q)||m.entities.some(e=>e.toLowerCase().includes(q)));
}
const ents=Object.values(core.store.entities).sort((a,b)=>b.mentionCount-a.mentionCount);
const total=Object.keys(core.store.memories).length;

// Filter-Controls
const types=['all','episodic','semantic','emotional','relational','appearance','plot','pinned','user'];
const typeLabels={all:'Alle',episodic:'Episodic',semantic:'Semantic',emotional:'Emotional',relational:'Relational',appearance:'👤 Aussehen',plot:'📖 Story',pinned:'📌 Pinned',user:'✋ Manuell'};
let filterBtns=types.map(t=>`<button class="nm-filter-btn${filter.type===t?' active':''}" data-action="filter" data-type="${t}">${typeLabels[t]}</button>`).join('');

// Digest-Block
let digestHtml='';
if(core.store.digest?.text){
const digestDate=new Date(core.store.digest.generatedAt).toLocaleDateString('de-DE');
digestHtml=`<div class="nm-digest-block"><div class="nm-digest-header"><span class="nm-digest-label">📝 Character Summary</span><button class="nm-action-btn" data-action="regen-digest" title="Digest neu generieren" style="font-size:1em">🔄</button><span class="nm-digest-date">${digestDate}</span></div><div class="nm-digest-text">${escHtml(core.store.digest.text)}</div></div>`;
}else{
digestHtml=`<div class="nm-digest-empty"><button class="menu_button" data-action="regen-digest" style="font-size:.8em;padding:3px 8px">📝 Digest generieren</button><span style="font-size:.75em;opacity:.6;margin-left:6px">Narrative Zusammenfassung aller wichtigen Memories</span></div>`;
}

// Emotion Arc Timeline (alle Memories, nicht gefiltert)
const allMems=Object.values(core.store.memories);
const timelineHtml=renderTimeline(allMems);

let html=`<div class="nm-browser-controls">
<input id="nm_memSearch" class="text_pole nm-search-input" placeholder="Suchen..." value="${escHtml(filter.search)}">
<div class="nm-type-filters">${filterBtns}</div>
</div>
${digestHtml}
${timelineHtml}
<h3>Memories (${mems.length}/${total})</h3><div class="nm-mem-list">`;

const showCount=Math.min(mems.length,_browserShowCount);
for(const m of mems.slice(0,showCount)){
const age=((Date.now()-m.createdAt)/86400000).toFixed(1);
const pinLabel=m.pinned?'📌':'📍';
const pinTitle=m.pinned?'Unpin':'Pin (immer injizieren)';
const userBadge=m.userCreated?'<span class="nm-user-badge" title="Manuell erstellt">✋</span>':'';
const lbBadge=m.lorebookSource?`<span class="nm-lb-badge" title="Aus Lorebook: ${escHtml(m.lorebookSource)}">📚</span>`:'';
const bw=(2+(m.emotionalIntensity||0)*5).toFixed(1);
const bgAlpha=(m.emotionalIntensity||0)*0.06;
const bgColor=(m.emotionalValence||0)>0.2?`rgba(76,175,80,${bgAlpha})`:(m.emotionalValence||0)<-0.2?`rgba(244,67,54,${bgAlpha})`:'transparent';
const intBadge=(m.emotionalIntensity||0)>=0.85?'<span class="nm-int-badge" title="Sehr intensive Erinnerung">⚡⚡</span>':(m.emotionalIntensity||0)>=0.6?'<span class="nm-int-badge" title="Intensive Erinnerung">⚡</span>':'';
html+=`<div class="nm-mem-item nm-type-${m.type}${m.pinned?' nm-pinned':''}" data-memid="${escHtml(m.id)}" style="border-left-width:${bw}px;background-color:${bgColor}">
<div class="nm-mem-header">
<span class="nm-badge">${m.type}</span>${m.subtype?`<span class="nm-subtype-badge nm-sub-${m.subtype}">${m.subtype==='appearance'?'👤':'📖'} ${m.subtype}</span>`:''}${intBadge}${lbBadge}${userBadge}
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
if(mems.length>showCount){
html+=`<button class="menu_button nm-load-more" data-action="load-more" style="width:100%;margin:8px 0;font-size:.85em">▼ ${mems.length-showCount} weitere Memories laden</button>`;
}
html+=`</div><h3>Entities (${ents.length})</h3><div class="nm-ent-list">`;
for(const e of ents.slice(0,50)){
html+=`<div class="nm-ent-item"><b>${escHtml(e.name)}</b> [${e.type}] mentions:${e.mentionCount}</div>`;
}
html+='</div>';
return html;
}

function showMemoryBrowser(){
if(!core.store){setStatus('Kein Charakter geladen',true);return}
document.getElementById('nm_modal_overlay')?.remove();
const overlay=document.createElement('div');
overlay.id='nm_modal_overlay';
overlay.className='nm-modal-overlay';
const dialog=document.createElement('div');
dialog.className='nm-modal-dialog';
const header=document.createElement('div');
header.className='nm-modal-header';
header.innerHTML=`<span class="nm-modal-title">🧠 Memory Browser</span><button class="nm-modal-close" id="nm_modal_close" title="Schließen">✕</button>`;
const panel=document.createElement('div');
panel.className='nm-browser-panel';
panel.innerHTML=renderMemoryBrowser();
dialog.appendChild(header);
dialog.appendChild(panel);
overlay.appendChild(dialog);
document.body.appendChild(overlay);
document.getElementById('nm_modal_close').addEventListener('click',()=>overlay.remove());
overlay.addEventListener('click',e=>{if(e.target===overlay)overlay.remove()});
document.addEventListener('keydown',function onEsc(e){
if(e.key==='Escape'){overlay.remove();document.removeEventListener('keydown',onEsc)}
});
attachBrowserEvents(panel);
panel.querySelector('#nm_memSearch')?.focus();
}

function attachBrowserEvents(panel){
// Suchfeld mit Debounce (300ms) binden
const searchEl=panel.querySelector('#nm_memSearch');
if(searchEl&&!searchEl._nmBound){
searchEl._nmBound=true;
searchEl.addEventListener('input',()=>{
if(_searchDebounceTimer)clearTimeout(_searchDebounceTimer);
_searchDebounceTimer=setTimeout(()=>{
_browserFilter.search=searchEl.value;
_browserShowCount=50;// Reset bei neuer Suche
panel.innerHTML=renderMemoryBrowser();
attachBrowserEvents(panel);
// Fokus+Cursor zurueck auf Suchfeld
const newSearch=panel.querySelector('#nm_memSearch');
if(newSearch){newSearch.focus();newSearch.setSelectionRange(newSearch.value.length,newSearch.value.length)}
},300);
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
_browserShowCount=50;// Reset bei Filterwechsel
panel.innerHTML=renderMemoryBrowser();
attachBrowserEvents(panel);
return;
}

if(action==='load-more'){
_browserShowCount+=50;
panel.innerHTML=renderMemoryBrowser();
attachBrowserEvents(panel);
return;
}

if(action==='regen-digest'){
await doGenerateDigest();
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
<div class="nm-mem-header"><span class="nm-badge">${r.memory.type}</span>${r.memory.subtype?`<span class="nm-subtype-badge nm-sub-${r.memory.subtype}">${r.memory.subtype}</span>`:''} score:${r.score.toFixed(3)} act:${r.activation.toFixed(3)} ret:${r.retrievability.toFixed(3)}</div>
<div class="nm-mem-content">${escHtml(r.memory.content)}</div></div>`;
}
showPopup('Last Injected Memories',html);
}

async function doAddMemory(){
const contentEl=document.getElementById('nm_newMemContent');
const content=contentEl?contentEl.value.trim():'';
if(!content){setStatus('Bitte Inhalt eingeben',true);return}
if(!core.store||!core.charId){setStatus('Kein Charakter geladen',true);return}
const typeRaw=document.getElementById('nm_newMemType')?.value||'semantic';
const[type,subtype]=typeRaw.includes(':')?typeRaw.split(':'):[typeRaw,null];
const importance=parseFloat(document.getElementById('nm_newMemImportance')?.value||'0.8');
const entitiesRaw=document.getElementById('nm_newMemEntities')?.value||'';
const entities=entitiesRaw.split(',').map(s=>s.trim()).filter(Boolean);
const pinned=document.getElementById('nm_newMemPinned')?.checked||false;
const t=Date.now();
const mem={
id:uid(),
characterId:core.charId,
type,
subtype:subtype||null,
content,
entities,
keywords:extractKeywords(content),
importance:isNaN(importance)?0.8:Math.max(0,Math.min(1,importance)),
emotionalValence:parseFloat(document.getElementById('nm_newMemValence')?.value||'0'),
emotionalIntensity:parseFloat(document.getElementById('nm_newMemIntensity')?.value||'0'),
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
const valSlider=document.getElementById('nm_newMemValence');if(valSlider)valSlider.value='0';
const valDisplay=document.getElementById('nm_valenceValue');if(valDisplay)valDisplay.textContent='0.0';
const intSlider=document.getElementById('nm_newMemIntensity');if(intSlider)intSlider.value='0';
const intDisplay=document.getElementById('nm_intensityValue');if(intDisplay)intDisplay.textContent='0.0';
setStatus(`Memory hinzugefügt: "${content.substring(0,50)}..."`);
// Browser aktualisieren falls sichtbar
const panel=document.querySelector('.nm-browser-panel');
if(panel){panel.innerHTML=renderMemoryBrowser();attachBrowserEvents(panel);}
console.log('[NM] manual memory added:',mem.id,content.substring(0,50));
}

async function doReinforceFading(){
if(!core.store)return;
const t=Date.now();let count=0;
for(const m of Object.values(core.store.memories)){
if(!m.pinned&&(m.retrievability||0)<0.25){
m.stability=m.stability*1.3+0.2;
m.lastReinforcedAt=t;
m.retrievability=Math.min(1,(m.retrievability||0)+0.3);
count++;
}
}
await saveStore(core.store);
updateUI();
setStatus(`✓ ${count} ${count===1?'Memory':'Memories'} aufgefrischt`);
}

async function doImportFromCard(){
const c=getCtx();
if(!c||!core.store||!core.charId){setStatus('Kein Charakter geladen',true);return}
if(c.groupId){setStatus('Import nicht für Gruppen verfügbar',true);return}
const char=c.characters[c.characterId];
if(!char){setStatus('Charakter nicht gefunden',true);return}
const cardParts=[char.description,char.personality,char.scenario];
const cardText=cardParts.filter(Boolean).join('\n\n').trim();
if(!cardText){setStatus('Keine Character Card Daten gefunden',true);return}
if(!core._generateFn){setStatus('Kein AI-Modell konfiguriert',true);return}
setStatus('Importiere aus Character Card...');
const origPrompt=getExtractionPrompt();
setExtractionPrompt(CARD_EXTRACT_SYSTEM);
let mems=[];
try{
const fakeChat=[{is_user:false,name:char.name,mes:cardText}];
mems=await extractMemories(core._generateFn,fakeChat,core.charId,1);
}catch(e){
console.error('[NM] card import error',e);
setStatus('Import Error: '+e.message,true);
setExtractionPrompt(origPrompt);
return;
}
setExtractionPrompt(origPrompt);
if(!mems.length){setStatus('Keine Memories extrahiert — prüfe Browser-Konsole',true);return}
for(const m of mems){m.stability=2.0}
integrateMemories(core.store,mems);
updateMemoryConnections(core.store);
core.store.meta.cardImported=true;
await saveStore(core.store);
updateUI();
setStatus(`✓ ${mems.length} Memories aus Character Card importiert`);
const panel=document.querySelector('.nm-browser-panel');
if(panel){panel.innerHTML=renderMemoryBrowser();attachBrowserEvents(panel);}
console.log('[NM] card import: extracted',mems.length,'memories');
}

async function doGenerateDigest(){
if(!core.store||!core._generateFn){setStatus('Kein Charakter oder generateFn',true);return}
setStatus('Generiere Memory Digest...');
try{
const{generateDigest}=await import('./src/consolidation.js');
const digestText=await generateDigest(core._generateFn,core.store);
if(digestText){
core.store.digest={text:digestText,generatedAt:Date.now(),memCount:Object.keys(core.store.memories).length};
await saveStore(core.store);
setStatus('✓ Digest generiert');
const panel=document.querySelector('.nm-browser-panel');
if(panel){panel.innerHTML=renderMemoryBrowser();attachBrowserEvents(panel);}
}else{
setStatus('Digest: zu wenig wichtige Memories (mind. 3 benötigt)',true);
}
}catch(e){
console.error('[NM] digest generation error',e);
setStatus('Digest Error: '+e.message,true);
}
}

async function doImportFromText(){
const textEl=document.getElementById('nm_importText');
const text=textEl?.value.trim();
if(!text){setStatus('Bitte Text eingeben',true);return}
if(!core.store||!core.charId){setStatus('Kein Charakter geladen',true);return}
if(!core._generateFn){setStatus('Kein AI-Modell konfiguriert',true);return}
setStatus('Importiere aus Text...');
const fakeChat=[{is_user:false,name:core.charName||'Character',mes:text}];
try{
const mems=await extractMemories(core._generateFn,fakeChat,core.charId,1);
if(!mems.length){setStatus('Keine Memories extrahiert — prüfe Browser-Konsole',true);return}
integrateMemories(core.store,mems);
updateMemoryConnections(core.store);
await saveStore(core.store);
updateUI();
if(textEl)textEl.value='';
setStatus(`✓ ${mems.length} Memories aus Text importiert`);
const panel=document.querySelector('.nm-browser-panel');
if(panel){panel.innerHTML=renderMemoryBrowser();attachBrowserEvents(panel);}
console.log('[NM] text import: extracted',mems.length,'memories');
}catch(e){
console.error('[NM] text import error',e);
setStatus('Import Error: '+e.message,true);
}
}

async function doImportFromLorebook(){
if(!core.store||!core.charId){setStatus('Kein Charakter geladen',true);return}
if(!core._generateFn){setStatus('Kein AI-Modell konfiguriert — KI wird fuer Smart-Import benoetigt',true);return}
let selected_world_info,wiLoadFn;
try{
const wi=await import('/scripts/world-info.js');
selected_world_info=wi.selected_world_info;
wiLoadFn=wi.loadWorldInfo;
}catch(e){
console.warn('[NM] world-info.js import failed, trying context fallback',e);
const c=getCtx();
wiLoadFn=c?.loadWorldInfo?.bind(c);
selected_world_info=[];
}
if(!selected_world_info?.length){
setStatus('Kein Lorebook aktiv. Bitte im Chat ein Lorebook auswählen.',true);
return;
}
setStatus('Smart-Import aus Lorebook (KI-Analyse)...');
let totalMems=0;
let totalBatches=0;
for(const bookName of selected_world_info){
// Bestehende Lorebook-Memories fuer dieses Buch entfernen (sauberer Re-Import)
for(const[id,m]of Object.entries(core.store.memories)){
if(m.lorebookSource===bookName)removeMemory(core.store,id);
}
let data;
try{data=await wiLoadFn(bookName);}
catch(e){console.warn('[NM] loadWorldInfo failed for',bookName,e);continue}
if(!data?.entries)continue;
const entries=Object.values(data.entries).filter(e=>!e.disable&&e.content?.trim().length>5);
if(!entries.length)continue;

// Batch-Verarbeitung: 6 Lorebook-Eintraege pro API-Call
const BATCH_SIZE=6;
const batches=[];
for(let i=0;i<entries.length;i+=BATCH_SIZE){
batches.push(entries.slice(i,i+BATCH_SIZE));
}
totalBatches+=batches.length;
console.log(`[NM] lorebook "${bookName}": ${entries.length} entries → ${batches.length} batches`);

const origPrompt=getExtractionPrompt();
setExtractionPrompt(LOREBOOK_EXTRACT_SYSTEM);

for(let bi=0;bi<batches.length;bi++){
const batch=batches[bi];
setStatus(`📚 ${bookName}: Batch ${bi+1}/${batches.length} (${totalMems} Memories bisher)...`);

// Lorebook-Eintraege als "fake chat" formatieren damit extractMemories sie verarbeiten kann
const batchText=batch.map(e=>{
const title=e.comment||e.key?.[0]||'Entry';
return`[${title}]\n${e.content}`;
}).join('\n\n---\n\n');

const fakeChat=[{is_user:false,name:'Lorebook',mes:batchText}];
try{
const mems=await extractMemories(core._generateFn,fakeChat,core.charId,1);
if(mems.length){
// Lorebook-Metadata auf jede Memory setzen
const t=Date.now();
for(const m of mems){
m.lorebookSource=bookName;
m.stability=3.0;// Hohe Stabilitaet fuer Weltwissen
m.createdAt=t;
m.lastAccessedAt=t;
m.lastReinforcedAt=t;
}
// Constant-Eintraege: wenn der Batch nur constant-Entries hat, Memories pinnen
const allConstant=batch.every(e=>e.constant);
if(allConstant)for(const m of mems)m.pinned=true;
integrateMemories(core.store,mems);
totalMems+=mems.length;
console.log(`[NM] lorebook batch ${bi+1}: extracted ${mems.length} memories`);
for(const m of mems)console.log(`[NM]   -> [${m.type}${m.subtype?'/'+m.subtype:''}] ${m.content.substring(0,60)}`);
}
}catch(e){
console.error(`[NM] lorebook batch ${bi+1} error:`,e);
}
}
setExtractionPrompt(origPrompt);
console.log(`[NM] lorebook import done: ${bookName} → ${totalMems} memories total`);
}
if(!totalMems){setStatus('Keine Memories extrahiert — prüfe Browser-Konsole',true);return}
updateMemoryConnections(core.store);
await saveStore(core.store);
updateUI();
setStatus(`✓ ${totalMems} Memories aus ${selected_world_info.length} Lorebook(s) smart-importiert (${totalBatches} KI-Calls)`);
const panel=document.querySelector('.nm-browser-panel');
if(panel){panel.innerHTML=renderMemoryBrowser();attachBrowserEvents(panel);}
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

// Message Lifecycle Hooks: Reagiere auf geloeschte, editierte und geswipte Nachrichten
async function onMessageDeleted(msgIdx){
if(!core.store||!core.settings.enabled)return;
console.log('[NM] MESSAGE_DELETED, idx:',msgIdx);
const msgIdStr=String(msgIdx);
let removed=0;
for(const[id,m]of Object.entries(core.store.memories)){
if(m.sourceMessageIds&&m.sourceMessageIds.includes(msgIdStr)){
removeMemory(core.store,id);
removed++;
}
}
if(removed){
updateMemoryConnections(core.store);
await saveStore(core.store);
updateUI();
console.log(`[NM] Removed ${removed} memories linked to deleted message ${msgIdx}`);
setStatus(`${removed} Memory(s) mit gelöschter Nachricht entfernt`);
}
}

async function onMessageSwiped(msgIdx){
if(!core.store||!core.settings.enabled)return;
console.log('[NM] MESSAGE_SWIPED, idx:',msgIdx);
// Swipe = alte Antwort geloescht, neue kommt — alte Memories entfernen
const msgIdStr=String(msgIdx);
let removed=0;
for(const[id,m]of Object.entries(core.store.memories)){
if(m.sourceMessageIds&&m.sourceMessageIds.includes(msgIdStr)){
removeMemory(core.store,id);
removed++;
}
}
if(removed){
updateMemoryConnections(core.store);
await saveStore(core.store);
updateUI();
console.log(`[NM] Removed ${removed} memories from swiped message ${msgIdx}`);
}
}

async function onMessageEdited(msgIdx){
if(!core.store||!core.settings.enabled||!core._generateFn)return;
console.log('[NM] MESSAGE_EDITED, idx:',msgIdx);
const c=getCtx();
if(!c||!c.chat||!c.chat[msgIdx])return;
// Alte Memories fuer diese Nachricht entfernen
const msgIdStr=String(msgIdx);
for(const[id,m]of Object.entries(core.store.memories)){
if(m.sourceMessageIds&&m.sourceMessageIds.includes(msgIdStr)){
removeMemory(core.store,id);
}
}
// Neu-Extraktion aus der editierten Nachricht + Kontext
const start=Math.max(0,msgIdx-1);
const end=Math.min(c.chat.length,msgIdx+2);
const chatSlice=c.chat.slice(start,end).map(m=>({is_user:m.is_user,name:m.name,mes:m.mes}));
try{
const newMems=await extractMemories(core._generateFn,chatSlice,core.charId,chatSlice.length);
if(newMems.length){
integrateMemories(core.store,newMems);
updateMemoryConnections(core.store);
await saveStore(core.store);
updateUI();
console.log(`[NM] Re-extracted ${newMems.length} memories from edited message ${msgIdx}`);
setStatus(`${newMems.length} Memory(s) aus editierter Nachricht aktualisiert`);
}
}catch(e){console.error('[NM] MESSAGE_EDITED extraction error',e)}
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
// MESSAGE_SENT: User hat eine neue Nachricht gesendet (nicht Regenerierung)
c.eventSource.on(c.eventTypes.MESSAGE_SENT,onUserMessageSent);
c.eventSource.on(c.eventTypes.MESSAGE_RECEIVED,onMessageReceived);
// GENERATION_STARTED feuert fuer ALLE APIs (inkl. OpenAI/Chat-Completions)
// GENERATE_BEFORE_COMBINE_PROMPTS feuert NUR fuer Text-Completion-APIs - daher nicht verwendbar
c.eventSource.on(c.eventTypes.GENERATION_STARTED,onGenerateBefore);
// Message Lifecycle: Reagiere auf Aenderungen im Chat
if(c.eventTypes.MESSAGE_DELETED)c.eventSource.on(c.eventTypes.MESSAGE_DELETED,onMessageDeleted);
if(c.eventTypes.MESSAGE_SWIPED)c.eventSource.on(c.eventTypes.MESSAGE_SWIPED,onMessageSwiped);
if(c.eventTypes.MESSAGE_EDITED)c.eventSource.on(c.eventTypes.MESSAGE_EDITED,onMessageEdited);
console.log('[NM] events registered (incl. lifecycle hooks)');

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
