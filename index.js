import{NeuroMemoryCore,defaultSettings}from'./src/core.js';
import{exportStore,importStore,loadStore,deleteStore,setContextGetter,saveStore,addEntity,removeEntity,getEntityByName,addSlotEntry,updateSlotValue,removeSlotEntry,updateSlotEntry,countTotalEntries,getAllEntities}from'./src/store.js';
import{extractMemories,integrateEntityUpdates,parseEntityUpdates,setExtractionPrompt,getExtractionPrompt,DEFAULT_EXTRACT_SYSTEM}from'./src/extraction.js';
import{uid,extractKeywords,estimateTokens}from'./src/utils.js';
import{updateEntityConnections}from'./src/network.js';
import{formatEntityContext}from'./src/retrieval.js';
import{ENTITY_SCHEMAS,ENTITY_TYPE_ICONS,TIER_LABELS,TIER_COLORS,createEntityNode,initSlots,createSlotEntry}from'./src/entities.js';

const MODULE_NAME='neuro-memory';
const core=new NeuroMemoryCore();

// ============================================================
// Entity-Slot Import Prompts (v2)
// ============================================================

const CARD_EXTRACT_SYSTEM=`You are an entity-centric memory extraction system for character backstories.
Analyze this character description and extract information organized BY ENTITY.

Return a JSON array of entity updates. Each object:
- "entity": string (name of the person, place, item, faction, or concept)
- "entityType": "person"|"location"|"item"|"faction"|"concept"
- "slot": string (which slot to update — see allowed slots below)
- "content": string (the information, 1-2 sentences max)
- "emotionalValence": number (-1.0 to 1.0, usually 0 for backstory)
- "emotionalIntensity": number (0.0 to 1.0)
- "importance": number (0.5-1.0, backstory facts are usually important)
- "relatedEntities": string[] (other entity names mentioned)

Allowed slots per entity type:
- person: profile, appearance, personality, relations, emotions, plot, sexual, notes
- location: description, management, inventory, plot, notes
- item: description, abilities, owner, plot, notes
- faction: description, members, plot, notes
- concept: description, notes

Slot modes:
- SINGLE slots (profile, appearance, personality, description, management, abilities, owner):
  provide the COMPLETE current state including ALL known info, not just the delta.
- ARRAY slots (relations, emotions, plot, sexual, notes, inventory, members):
  provide only the NEW event/fact.

Rules:
- Extract personality, abilities, relationships, history, motivations
- ALWAYS extract character profiles as entityType "person" with slot "profile"
- NO episodic events for backstory unless explicitly described as past events
- Maximum 8 updates. Be concise, no fluff.
- Respond ONLY with a valid JSON array, no markdown, no explanation`;

const LOREBOOK_EXTRACT_SYSTEM=`You are an entity-centric memory extraction system for world-building lore entries.
Analyze the following lorebook entries and extract information organized BY ENTITY.

Return a JSON array of entity updates. Each object:
- "entity": string (name of the person, place, item, faction, or concept)
- "entityType": "person"|"location"|"item"|"faction"|"concept"
- "slot": string (which slot to update — see allowed slots below)
- "content": string (the information, 1-2 sentences max)
- "emotionalValence": number (-1.0 to 1.0, usually 0 for lore)
- "emotionalIntensity": number (0.0 to 1.0)
- "importance": number (0.5-1.0, lore is usually important)
- "relatedEntities": string[] (other entity names mentioned)

Allowed slots per entity type:
- person: profile, appearance, personality, relations, emotions, plot, sexual, notes
- location: description, management, inventory, plot, notes
- item: description, abilities, owner, plot, notes
- faction: description, members, plot, notes
- concept: description, notes

Slot modes:
- SINGLE slots: provide the COMPLETE current state.
- ARRAY slots: provide only the NEW event/fact.

Rules:
- One lorebook entry may produce MULTIPLE entity updates
- Classify entities correctly (person, location, item, faction, concept)
- ALWAYS extract historical events into the "plot" slot
- Maximum 3 updates per lorebook entry. Be concise.
- Respond ONLY with a valid JSON array, no markdown, no explanation`;

// WICHTIG: getContext() gibt jedes Mal ein neues Snapshot-Objekt zurueck - NIE cachen!
function getCtx(){
if(typeof SillyTavern!=='undefined'&&SillyTavern.getContext)return SillyTavern.getContext();
return null;
}

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
setExtractionPrompt(core.settings.extractionPrompt||'');
}

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
set('nm_maxEntries',s.maxEntries);
set('nm_activationHops',s.activationHops);
set('nm_activationThreshold',s.activationThreshold);
const cb=document.getElementById('nm_enabled');if(cb)cb.checked=!!s.enabled;
const ppCb=document.getElementById('nm_proactivePrompt');if(ppCb)ppCb.checked=!!s.proactivePrompt;
const arCb=document.getElementById('nm_associativeRecallEnabled');if(arCb)arCb.checked=!!s.associativeRecallEnabled;
const cmSel=document.getElementById('nm_consolidationMode');if(cmSel)cmSel.value=s.consolidationMode||'smart';
set('nm_coreImportanceThreshold',s.coreImportanceThreshold);
set('nm_significantImportanceThreshold',s.significantImportanceThreshold);
set('nm_maxSlotEntriesBeforeCompress',s.maxSlotEntriesBeforeCompress);
set('nm_wisdomExtractionThreshold',s.wisdomExtractionThreshold);
set('nm_associativeRecallMinEmotion',s.associativeRecallMinEmotion);
set('nm_associativeRecallMaxCount',s.associativeRecallMaxCount);
set('nm_temporalWindow',s.temporalWindow);
set('nm_digestEveryN',s.digestEveryN??15);
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

// ============================================================
// Event Handler
// ============================================================

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
await core.loadCharacter(charId,getCharName(c));
const s=core.getStats();
const entCount=s?.totalEntities||0;
const slotCount=s?.totalSlotEntries||0;
setStatus(entCount>0?`${entCount} Entities, ${slotCount} Einträge`:'Bereit');
updateUI();
}catch(e){console.error('[NM] onChatChanged error',e)}
}

let _userMessageSent=false;

function onUserMessageSent(){
_userMessageSent=true;
console.log('[NM] MESSAGE_SENT: flagged for extraction');
}

function onMessageReceived(msgIdx){
console.log('[NM] MESSAGE_RECEIVED fired, msgIdx:',msgIdx);
if(!_userMessageSent){
console.log('[NM] SKIP: regeneration detected');
return;
}
_userMessageSent=false;
if(!core.settings.enabled)return;
const c=getCtx();
if(!c||!c.chat||c.chat.length<2)return;

// Selective Reinforcement
const lastMsg=c.chat[c.chat.length-1];
if(lastMsg&&!lastMsg.is_user&&lastMsg.mes){
core.applySelectiveReinforcement(lastMsg.mes);
saveStore(core.store).catch(e=>console.warn('[NM] save after selective reinforce failed',e));
}

const chatSnapshot=c.chat.map(m=>({is_user:m.is_user,name:m.name,mes:m.mes}));

setTimeout(()=>{
setStatus('Extracting...');
core.onMessageReceived(chatSnapshot)
.then(()=>{
const s=core.getStats();
if(s&&s.totalEntities>0){
setStatus(`OK: ${s.totalEntities} Entities, ${s.totalSlotEntries} Einträge`);
}else{
setStatus('Extraction done (0 neue Updates)');
}
updateUI();
})
.catch(e=>{
console.error('[NM] extraction background error',e);
setStatus('Error: '+e.message,true);
});
},1500);
}

async function onGenerateBefore(){
if(!core.settings.enabled)return;
const c=getCtx();
if(!c||!c.chat||!c.chat.length)return;

let lastUserMsg='';
for(let i=c.chat.length-1;i>=0;i--){
if(c.chat[i].is_user){lastUserMsg=c.chat[i].mes;break}
}
if(!lastUserMsg)return;

const chatMsgs=c.chat.map(m=>({is_user:m.is_user,name:m.name,mes:m.mes}));
const{context:memContext,hint}=await core.retrieveForMessage(lastUserMsg,chatMsgs);
if(!memContext)return;

c.setExtensionPrompt(MODULE_NAME,memContext,1,core.settings.injectionDepth,false,core.settings.injectionRole);
console.log('[NM] Injected',core.lastInjected.length,'entities into prompt');

if(hint){
c.setExtensionPrompt(MODULE_NAME+'_hint',hint,0,0,false,0);
}else{
c.setExtensionPrompt(MODULE_NAME+'_hint','',0,0,false,0);
}
}

// ============================================================
// Test Extraction
// ============================================================

async function doTestExtraction(){
setStatus('Testing extraction...');
showDebug('');
const c=getCtx();
if(!c||!c.chat||c.chat.length<2){setStatus('Error: Mindestens 2 Nachrichten nötig',true);return}
if(!core.charId||!core.store){setStatus('Error: Kein Charakter geladen',true);return}
if(!core._generateFn){setStatus('Error: Kein AI-Modell',true);return}

const chatSnapshot=c.chat.map(m=>({is_user:m.is_user,name:m.name,mes:m.mes}));
try{
const updates=await extractMemories(core._generateFn,chatSnapshot,core.charId,core.settings.extractContextMessages,core.store);
if(updates.length){
const{added,merged}=integrateEntityUpdates(core.store,updates);
updateEntityConnections(core.store);
await saveStore(core.store);
setStatus(`Test OK: ${updates.length} Updates (${added} neu, ${merged} merged)`);
let dbg=`Extracted ${updates.length} entity updates:\n`;
for(const u of updates)dbg+=`\n[${u.entityType}] ${u.entity}.${u.slot}: ${u.content}\n  importance: ${u.importance}\n`;
showDebug(dbg);
}else{
setStatus('Test: 0 Updates extrahiert');
showDebug('extractMemories returned empty. Check browser console.');
}
updateUI();
}catch(e){
console.error('[NM] TEST error',e);
setStatus('Test Error: '+e.message,true);
showDebug('Error: '+e.message+'\n\nStack: '+e.stack);
}
}

// ============================================================
// UI: Settings HTML
// ============================================================

function buildSettingsHTML(){
const s=core.settings;
return`
<div id="nm_settings" class="nm-panel">
<div class="inline-drawer">
<div class="inline-drawer-toggle inline-drawer-header">
<b data-i18n="NeuroMemory">NeuroMemory v3</b>
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
<span id="nm_promptHint" class="nm-prompt-hint">Standard-Prompt</span>
</div>
</div>
</div>

<div id="nm_status" class="nm-status"></div>

<hr>
<h4>Retrieval</h4>
<label>Top-K Entities <input type="number" id="nm_topK" value="${s.topK}" min="1" max="50" class="text_pole nm-input"></label>
<label>Max Context Tokens <input type="number" id="nm_maxContextTokens" value="${s.maxContextTokens}" min="50" max="2000" class="text_pole nm-input"></label>
<label>Injection Depth <input type="number" id="nm_injectionDepth" value="${s.injectionDepth}" min="0" max="100" class="text_pole nm-input"></label>

<hr>
<h4>Relevanz-Filter</h4>
<label>Filter-Kontext Nachrichten <input type="number" id="nm_filterContextMessages" value="${s.filterContextMessages}" min="1" max="10" class="text_pole nm-input"></label>
<label>Filter-Snippet Tokens <input type="number" id="nm_filterSnippetTokens" value="${s.filterSnippetTokens}" min="50" max="500" class="text_pole nm-input"></label>

<hr>
<h4>Extraction</h4>
<label>Extract every N messages <input type="number" id="nm_extractEveryN" value="${s.extractEveryN}" min="1" max="20" class="text_pole nm-input"></label>
<label>Context messages <input type="number" id="nm_extractContextMessages" value="${s.extractContextMessages}" min="2" max="10" class="text_pole nm-input"></label>

<hr>
<h4>Memory Behavior</h4>
<label>Half-life (days) <input type="number" id="nm_halfLifeDays" value="${s.halfLifeDays}" min="1" max="365" class="text_pole nm-input"></label>
<label>Emotion factor <input type="number" id="nm_emotionFactor" value="${s.emotionFactor}" min="0" max="2" step="0.1" class="text_pole nm-input"></label>
<label>Consolidate every N msg <input type="number" id="nm_consolidateEveryN" value="${s.consolidateEveryN}" min="1" max="100" class="text_pole nm-input"></label>
<label>Max Slot-Einträge <input type="number" id="nm_maxEntries" value="${s.maxEntries}" min="10" max="5000" class="text_pole nm-input"></label>
<label>Activation hops <input type="number" id="nm_activationHops" value="${s.activationHops}" min="1" max="5" class="text_pole nm-input"></label>
<label>Activation threshold <input type="number" id="nm_activationThreshold" value="${s.activationThreshold}" min="0.01" max="0.5" step="0.01" class="text_pole nm-input"></label>
<label>Digest alle N Einträge <input type="number" id="nm_digestEveryN" value="${s.digestEveryN}" min="5" max="100" class="text_pole nm-input"></label>
<label class="checkbox_label" style="margin-top:4px">
<input type="checkbox" id="nm_proactivePrompt" ${s.proactivePrompt?'checked':''}>
<span style="font-size:.9em">Proaktive Memory-Nutzung</span>
</label>

<hr>
<h4>v3: Tier-System</h4>
<label>Core-Schwelle (Importance) <input type="number" id="nm_coreImportanceThreshold" value="${s.coreImportanceThreshold}" min="0.5" max="1" step="0.05" class="text_pole nm-input"></label>
<label>Significant-Schwelle <input type="number" id="nm_significantImportanceThreshold" value="${s.significantImportanceThreshold}" min="0.3" max="0.9" step="0.05" class="text_pole nm-input"></label>

<hr>
<h4>v3: Konsolidierung</h4>
<label>Modus <select id="nm_consolidationMode" class="text_pole nm-input">
<option value="smart" ${s.consolidationMode==='smart'?'selected':''}>Smart (Batch)</option>
<option value="legacy" ${s.consolidationMode==='legacy'?'selected':''}>Legacy (Paarweise)</option>
</select></label>
<label>Batch-Kompression ab Einträgen <input type="number" id="nm_maxSlotEntriesBeforeCompress" value="${s.maxSlotEntriesBeforeCompress}" min="4" max="20" class="text_pole nm-input"></label>
<label>Wisdom-Extraktion ab Plot-Einträgen <input type="number" id="nm_wisdomExtractionThreshold" value="${s.wisdomExtractionThreshold}" min="5" max="30" class="text_pole nm-input"></label>

<hr>
<h4>v3: Assoziatives Erinnern</h4>
<label class="checkbox_label" style="margin-top:4px">
<input type="checkbox" id="nm_associativeRecallEnabled" ${s.associativeRecallEnabled?'checked':''}>
<span style="font-size:.9em">Assoziatives Erinnern aktiviert</span>
</label>
<label>Min. Emotion für Trigger <input type="number" id="nm_associativeRecallMinEmotion" value="${s.associativeRecallMinEmotion}" min="0.1" max="0.9" step="0.1" class="text_pole nm-input"></label>
<label>Max. Assoziative Recalls <input type="number" id="nm_associativeRecallMaxCount" value="${s.associativeRecallMaxCount}" min="1" max="5" class="text_pole nm-input"></label>
<label>Temporales Fenster <input type="number" id="nm_temporalWindow" value="${s.temporalWindow}" min="0" max="5" class="text_pole nm-input"></label>

<hr>
<h4>Debug &amp; Data</h4>
<div id="nm_stats" class="nm-stats"></div>
<div class="nm-buttons">
<button id="nm_testExtraction" class="menu_button">Test Extraction</button>
<button id="nm_showEntities" class="menu_button">Entity Browser</button>
<button id="nm_showLastInjected" class="menu_button">Last Injected</button>
<button id="nm_export" class="menu_button">Export</button>
<button id="nm_import" class="menu_button">Import</button>
<button id="nm_clearAll" class="menu_button redWarning">Clear All</button>
</div>
<div id="nm_cardImportRow" style="display:none;margin:4px 0;padding:4px 0">
<button id="nm_importCard" class="menu_button nm-import-card-btn">📥 Aus Character Card importieren</button>
<span style="font-size:.75em;opacity:.6;display:block;margin-top:2px">Backstory als Entity-Daten extrahieren</span>
</div>

<div id="nm_lorebookImportRow" style="display:none;margin:4px 0;padding:4px 0">
<button id="nm_importLorebook" class="menu_button nm-import-card-btn">🧠 Smart-Import aus Lorebook</button>
<span style="font-size:.75em;opacity:.6;display:block;margin-top:2px">KI analysiert Lorebook-Einträge und erstellt Entity-Slots</span>
</div>

<div class="inline-drawer nm-textimport-drawer">
<div class="inline-drawer-toggle inline-drawer-header nm-add-toggle">
<span>📋 Text importieren</span>
<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
</div>
<div class="inline-drawer-content">
<textarea id="nm_importText" class="text_pole nm-add-textarea" rows="5" placeholder="Beliebigen Text einfügen — Session-Zusammenfassung, Lore, Notizen..."></textarea>
<div style="display:flex;gap:6px;align-items:center;margin-top:4px">
<button id="nm_doTextImport" class="menu_button">📋 Importieren</button>
<span style="font-size:.75em;opacity:.6">KI extrahiert Entity-Daten</span>
</div>
</div>
</div>

<div class="inline-drawer nm-add-drawer">
<div class="inline-drawer-toggle inline-drawer-header nm-add-toggle">
<span>+ Manuell hinzufügen</span>
<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
</div>
<div class="inline-drawer-content">
<div class="nm-add-row">
<input id="nm_newEntityName" class="text_pole" placeholder="Entity-Name (z.B. Veyra)" style="flex:1">
<select id="nm_newEntityType" class="text_pole nm-add-select" style="width:auto">
<option value="person">👤 Person</option>
<option value="location">📍 Location</option>
<option value="item">🗡️ Item</option>
<option value="faction">⚔️ Faction</option>
<option value="concept">📚 Concept</option>
</select>
</div>
<div class="nm-add-row">
<select id="nm_newSlotName" class="text_pole nm-add-select" style="flex:1"></select>
</div>
<textarea id="nm_newSlotContent" class="text_pole nm-add-textarea" rows="3" placeholder="Inhalt..."></textarea>
<div class="nm-add-row">
<label class="nm-add-imp-label">Wichtigkeit:
<input type="range" id="nm_newImportance" min="0" max="1" step="0.1" value="0.8" class="nm-imp-range">
<span id="nm_impValue">0.8</span>
</label>
</div>
<div class="nm-add-row">
<label class="nm-add-emo-label">😔 <input type="range" id="nm_newValence" min="-1" max="1" step="0.1" value="0" class="nm-emo-range"> 😊 <span id="nm_valenceValue">0.0</span></label>
<label class="nm-add-emo-label">⚡ <input type="range" id="nm_newIntensity" min="0" max="1" step="0.1" value="0" class="nm-emo-range"> <span id="nm_intensityValue">0.0</span></label>
</div>
<div style="display:flex;align-items:center;gap:6px;margin-top:4px">
<label class="checkbox_label" style="font-size:.85em">
<input type="checkbox" id="nm_newPinned">
<span>📌 Anpinnen</span>
</label>
<button id="nm_addEntry" class="menu_button" style="margin-left:auto">+ Hinzufügen</button>
</div>
</div>
</div>

<div id="nm_debugOutput" class="nm-debug"></div>

</div></div></div>`;
}

// ============================================================
// Event Bindings
// ============================================================

function bindEvents(){
const on=(id,ev,fn)=>{const el=document.getElementById(id);if(el)el.addEventListener(ev,fn)};

on('nm_enabled','change',e=>{core.settings.enabled=e.target.checked;saveSettings()});
const nums=['topK','maxContextTokens','injectionDepth','filterContextMessages','filterSnippetTokens',
'extractEveryN','extractContextMessages',
'halfLifeDays','emotionFactor','consolidateEveryN','maxEntries','activationHops','activationThreshold','digestEveryN',
'coreImportanceThreshold','significantImportanceThreshold','maxSlotEntriesBeforeCompress','wisdomExtractionThreshold',
'associativeRecallMinEmotion','associativeRecallMaxCount','temporalWindow'];
for(const n of nums){
on(`nm_${n}`,'change',e=>{
const v=parseFloat(e.target.value);
if(!isNaN(v)){core.settings[n]=v;saveSettings()}
});
}

on('nm_proactivePrompt','change',e=>{core.settings.proactivePrompt=e.target.checked;saveSettings()});
on('nm_consolidationMode','change',e=>{core.settings.consolidationMode=e.target.value;saveSettings()});
on('nm_associativeRecallEnabled','change',e=>{core.settings.associativeRecallEnabled=e.target.checked;saveSettings()});
on('nm_testExtraction','click',()=>doTestExtraction());
on('nm_showEntities','click',()=>{_browserFilter={type:'all',search:''};_browserShowCount=50;showEntityBrowser()});
on('nm_importCard','click',()=>doImportFromCard());
on('nm_doTextImport','click',()=>doImportFromText());
on('nm_importLorebook','click',()=>doImportFromLorebook());
on('nm_showLastInjected','click',()=>showLastInjected());
on('nm_export','click',()=>doExport());
on('nm_import','click',()=>doImport());
on('nm_clearAll','click',()=>doClear());
on('nm_addEntry','click',()=>doAddEntry());

// Slot-Select aktualisieren bei Entity-Typ-Wechsel
on('nm_newEntityType','change',()=>updateSlotSelect());
updateSlotSelect();

// Slider-Anzeige
const bindSlider=(rangeId,valId)=>{
const r=document.getElementById(rangeId),v=document.getElementById(valId);
if(r&&v)r.addEventListener('input',()=>{v.textContent=parseFloat(r.value).toFixed(1)});
};
bindSlider('nm_newImportance','nm_impValue');
bindSlider('nm_newValence','nm_valenceValue');
bindSlider('nm_newIntensity','nm_intensityValue');

// Extraction-Prompt Editor
const promptEl=document.getElementById('nm_extractPrompt');
if(promptEl){
const isCustom=!!(core.settings.extractionPrompt&&core.settings.extractionPrompt.trim());
promptEl.value=isCustom?core.settings.extractionPrompt:DEFAULT_EXTRACT_SYSTEM;
promptEl.addEventListener('input',()=>{
const val=promptEl.value.trim();
const isDefault=val===DEFAULT_EXTRACT_SYSTEM.trim();
const saveVal=isDefault?'':val;
core.settings.extractionPrompt=saveVal;
setExtractionPrompt(saveVal);
saveSettings();
const hint=document.getElementById('nm_promptHint');
if(hint)hint.textContent=isDefault?'Standard-Prompt':'Benutzerdefinierter Prompt aktiv';
});
}
on('nm_resetPrompt','click',()=>{
const promptEl=document.getElementById('nm_extractPrompt');
if(promptEl){
promptEl.value=DEFAULT_EXTRACT_SYSTEM;
core.settings.extractionPrompt='';
setExtractionPrompt('');
saveSettings();
}
});
}

function updateSlotSelect(){
const typeEl=document.getElementById('nm_newEntityType');
const slotEl=document.getElementById('nm_newSlotName');
if(!typeEl||!slotEl)return;
const type=typeEl.value;
const schema=ENTITY_SCHEMAS[type]||{};
slotEl.innerHTML='';
for(const[name,def]of Object.entries(schema)){
const opt=document.createElement('option');
opt.value=name;
opt.textContent=`${def.label} (${def.mode})`;
slotEl.appendChild(opt);
}
}

// ============================================================
// UI Update
// ============================================================

function updateUI(){
const statsEl=document.getElementById('nm_stats');
if(!statsEl)return;
const s=core.getStats();
if(!s){statsEl.innerHTML='<i>Kein Charakter geladen</i>';return}
const icons={person:'👤',location:'📍',item:'🗡️',faction:'⚔️',concept:'📚'};
let typeParts=[];
for(const[t,c]of Object.entries(s.byType)){if(c>0)typeParts.push(`${icons[t]||''}${c}`)}
statsEl.innerHTML=`
<div class="nm-stat-row"><b>Entities:</b> ${s.totalEntities} | <b>Slot-Einträge:</b> ${s.totalSlotEntries}</div>
<div class="nm-stat-row"><b>Typen:</b> ${typeParts.join(' · ')}</div>
<div class="nm-stat-row"><b>Schema:</b> v${s.schemaVersion} | <b>Last injected:</b> ${s.lastInjectedCount} Entities</div>`;
const cardRow=document.getElementById('nm_cardImportRow');
if(cardRow)cardRow.style.display=core.store&&!core.store.meta?.cardImported?'':'none';
const lbRow=document.getElementById('nm_lorebookImportRow');
if(lbRow)lbRow.style.display=core.store?'':'none';
}

// ============================================================
// Entity Browser
// ============================================================

let _browserFilter={type:'all',search:''};
let _browserShowCount=50;
let _searchDebounceTimer=null;

function renderEntityBrowser(filter){
if(!filter)filter=_browserFilter;
if(!core.store)return'';
let ents=Object.values(core.store.entities).sort((a,b)=>(b.mentionCount||0)-(a.mentionCount||0));

// Filter
if(filter.type!=='all')ents=ents.filter(e=>e.type===filter.type);
if(filter.search){
const q=filter.search.toLowerCase();
ents=ents.filter(e=>{
if(e.name.toLowerCase().includes(q))return true;
for(const slot of Object.values(e.slots)){
if(slot.mode==='SINGLE'&&slot.value&&slot.value.toLowerCase().includes(q))return true;
if(slot.mode==='ARRAY'&&slot.entries.some(en=>en.content.toLowerCase().includes(q)))return true;
}return false;
});
}

const total=Object.keys(core.store.entities).length;
const types=['all','person','location','item','faction','concept'];
const typeLabels={all:'Alle',person:'👤 Person',location:'📍 Location',item:'🗡️ Item',faction:'⚔️ Faction',concept:'📚 Concept'};
let filterBtns=types.map(t=>`<button class="nm-filter-btn${filter.type===t?' active':''}" data-action="filter" data-type="${t}">${typeLabels[t]}</button>`).join('');

// Digest
let digestHtml='';
if(core.store.digest?.text){
const digestDate=new Date(core.store.digest.generatedAt).toLocaleDateString('de-DE');
digestHtml=`<div class="nm-digest-block"><div class="nm-digest-header"><span class="nm-digest-label">📝 Character Summary</span><button class="nm-action-btn" data-action="regen-digest" style="font-size:1em">🔄</button><span class="nm-digest-date">${digestDate}</span></div><div class="nm-digest-text">${escHtml(core.store.digest.text)}</div></div>`;
}else{
digestHtml=`<div class="nm-digest-empty"><button class="menu_button" data-action="regen-digest" style="font-size:.8em;padding:3px 8px">📝 Digest generieren</button></div>`;
}

let html=`<div class="nm-browser-controls">
<input id="nm_entSearch" class="text_pole nm-search-input" placeholder="Suchen..." value="${escHtml(filter.search)}">
<div class="nm-type-filters">${filterBtns}</div>
</div>
${digestHtml}
<h3>Entities (${ents.length}/${total})</h3><div class="nm-entity-list">`;

const showCount=Math.min(ents.length,_browserShowCount);
for(const ent of ents.slice(0,showCount)){
const icon=ENTITY_TYPE_ICONS[ent.type]||'';
const schema=ENTITY_SCHEMAS[ent.type]||{};
let slotCount=0;
for(const s of Object.values(ent.slots)){
if(s.mode==='SINGLE'&&s.value)slotCount++;
else if(s.mode==='ARRAY')slotCount+=s.entries.length;
}

html+=`<div class="nm-entity-item nm-entity-type-${ent.type}" data-entid="${escHtml(ent.id)}">
<div class="nm-entity-header" data-action="toggle-entity" data-entid="${escHtml(ent.id)}">
<span class="nm-entity-icon">${icon}</span>
<span class="nm-entity-name">${escHtml(ent.name)}</span>
<span class="nm-entity-type-label">${ent.type}</span>
<span class="nm-entity-count">${slotCount} Einträge</span>
<span class="nm-entity-mentions">×${ent.mentionCount||0}</span>
<div class="nm-entity-actions">
<button class="nm-action-btn nm-del-btn" data-action="delete-entity" data-entid="${escHtml(ent.id)}" title="Entity löschen">✕</button>
</div>
<div class="nm-entity-chevron">▶</div>
</div>
<div class="nm-entity-slots" style="display:none">`;

// Slots rendern
for(const[slotName,slotDef]of Object.entries(schema)){
const slot=ent.slots[slotName];
if(!slot)continue;

if(slot.mode==='SINGLE'){
const hasValue=!!slot.value;
const sTier=slot.tier||'episodic';
const sTierBadge=hasValue?`<span class="nm-tier-badge" style="background:${TIER_COLORS[sTier]||'#6bcb77'};color:#000;font-size:.7em;padding:1px 4px;border-radius:3px;margin-left:4px">${TIER_LABELS[sTier]||'EPI'}</span>`:'';
html+=`<div class="nm-slot-section nm-slot-single">
<div class="nm-slot-header"><span class="nm-slot-label">${slotDef.label}</span><span class="nm-slot-mode">SINGLE</span>${sTierBadge}
${hasValue?`<button class="nm-action-btn" data-action="edit-single" data-entid="${escHtml(ent.id)}" data-slot="${slotName}" title="Bearbeiten">✏️</button>`:''}
${hasValue&&slot.pinned?'<span class="nm-pin-badge">📌</span>':''}
</div>`;
if(hasValue){
html+=`<div class="nm-slot-value">${escHtml(slot.value)}</div>`;
}else{
html+=`<div class="nm-slot-empty">— leer —</div>`;
}
html+=`</div>`;
}else{
html+=`<div class="nm-slot-section nm-slot-array">
<div class="nm-slot-header"><span class="nm-slot-label">${slotDef.label}</span><span class="nm-slot-mode">ARRAY · ${slot.entries.length}</span></div>`;
for(const entry of slot.entries){
const pinBadge=entry.pinned?'📌 ':'';
const emoInt=(entry.emotionalIntensity||0);
const emoBadge=emoInt>=0.75?'⚡⚡ ':emoInt>=0.5?'⚡ ':'';
const tier=entry.tier||'episodic';
const tierBadge=`<span class="nm-tier-badge" style="background:${TIER_COLORS[tier]||'#6bcb77'};color:#000;font-size:.7em;padding:1px 4px;border-radius:3px;margin-right:4px">${TIER_LABELS[tier]||'EPI'}</span>`;
const arcBadge=entry.storyArc?`<span class="nm-arc-badge" style="font-size:.7em;opacity:.7;margin-right:4px">🎭${escHtml(entry.storyArc)}</span>`:'';
html+=`<div class="nm-slot-entry" data-entryid="${escHtml(entry.id)}">
<div class="nm-entry-content">${tierBadge}${arcBadge}${pinBadge}${emoBadge}${escHtml(entry.content)}</div>
<div class="nm-entry-actions">
<button class="nm-action-btn" data-action="pin-entry" data-entid="${escHtml(ent.id)}" data-slot="${slotName}" data-entryid="${escHtml(entry.id)}" title="${entry.pinned?'Unpin':'Pin'}">${entry.pinned?'📌':'📍'}</button>
<button class="nm-action-btn" data-action="edit-entry" data-entid="${escHtml(ent.id)}" data-slot="${slotName}" data-entryid="${escHtml(entry.id)}" title="Bearbeiten">✏️</button>
<button class="nm-action-btn nm-del-btn" data-action="delete-entry" data-entid="${escHtml(ent.id)}" data-slot="${slotName}" data-entryid="${escHtml(entry.id)}" title="Löschen">✕</button>
</div></div>`;
}
html+=`</div>`;
}
}
html+=`</div></div>`;
}

if(ents.length>showCount){
html+=`<button class="menu_button nm-load-more" data-action="load-more" style="width:100%;margin:8px 0">▼ ${ents.length-showCount} weitere Entities</button>`;
}
html+=`</div>`;
return html;
}

function showEntityBrowser(){
if(!core.store){setStatus('Kein Charakter geladen',true);return}
document.getElementById('nm_modal_overlay')?.remove();
const overlay=document.createElement('div');
overlay.id='nm_modal_overlay';
overlay.className='nm-modal-overlay';
const dialog=document.createElement('div');
dialog.className='nm-modal-dialog';
const header=document.createElement('div');
header.className='nm-modal-header';
header.innerHTML=`<span class="nm-modal-title">🧠 Entity Browser</span><button class="nm-modal-close" id="nm_modal_close" title="Schließen">✕</button>`;
const panel=document.createElement('div');
panel.className='nm-browser-panel';
panel.innerHTML=renderEntityBrowser();
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
panel.querySelector('#nm_entSearch')?.focus();
}

function attachBrowserEvents(panel){
const searchEl=panel.querySelector('#nm_entSearch');
if(searchEl&&!searchEl._nmBound){
searchEl._nmBound=true;
searchEl.addEventListener('input',()=>{
if(_searchDebounceTimer)clearTimeout(_searchDebounceTimer);
_searchDebounceTimer=setTimeout(()=>{
_browserFilter.search=searchEl.value;
_browserShowCount=50;
panel.innerHTML=renderEntityBrowser();
attachBrowserEvents(panel);
const newSearch=panel.querySelector('#nm_entSearch');
if(newSearch){newSearch.focus();newSearch.setSelectionRange(newSearch.value.length,newSearch.value.length)}
},300);
});
}

panel.onclick=async e=>{
const btn=e.target.closest('[data-action]');
if(!btn||!core.store)return;
e.stopPropagation();
const action=btn.dataset.action;
const entId=btn.dataset.entid;
const slotName=btn.dataset.slot;
const entryId=btn.dataset.entryid;

if(action==='filter'){
_browserFilter.type=btn.dataset.type;
_browserShowCount=50;
panel.innerHTML=renderEntityBrowser();
attachBrowserEvents(panel);
return;
}

if(action==='load-more'){
_browserShowCount+=50;
panel.innerHTML=renderEntityBrowser();
attachBrowserEvents(panel);
return;
}

if(action==='toggle-entity'){
const entItem=btn.closest('.nm-entity-item');
const slotsDiv=entItem?.querySelector('.nm-entity-slots');
const chevron=btn.querySelector('.nm-entity-chevron');
if(slotsDiv){
const show=slotsDiv.style.display==='none';
slotsDiv.style.display=show?'':'none';
if(chevron)chevron.textContent=show?'▼':'▶';
}
return;
}

if(action==='regen-digest'){
await doGenerateDigest();
panel.innerHTML=renderEntityBrowser();
attachBrowserEvents(panel);
return;
}

if(action==='delete-entity'){
const ent=core.store.entities[entId];
if(!ent)return;
if(!confirm(`Entity "${ent.name}" löschen?`))return;
removeEntity(core.store,entId);
await saveStore(core.store);
updateUI();
panel.innerHTML=renderEntityBrowser();
attachBrowserEvents(panel);
return;
}

if(action==='pin-entry'){
const ent=core.store.entities[entId];
if(!ent)return;
const slot=ent.slots[slotName];
if(!slot||slot.mode!=='ARRAY')return;
const entry=slot.entries.find(e=>e.id===entryId);
if(!entry)return;
entry.pinned=!entry.pinned;
await saveStore(core.store);
panel.innerHTML=renderEntityBrowser();
attachBrowserEvents(panel);
return;
}

if(action==='edit-single'){
const entItem=btn.closest('.nm-slot-section');
const valEl=entItem?.querySelector('.nm-slot-value');
if(!valEl)return;
const oldText=valEl.textContent;
valEl.innerHTML=`<textarea class="nm-edit-textarea text_pole">${escHtml(oldText)}</textarea>
<div class="nm-edit-actions">
<button class="menu_button" data-action="save-single" data-entid="${escHtml(entId)}" data-slot="${slotName}">✓ Speichern</button>
<button class="menu_button" data-action="cancel-edit">✗ Abbrechen</button>
</div>`;
const ta=valEl.querySelector('textarea');
if(ta){ta.focus();ta.setSelectionRange(ta.value.length,ta.value.length)}
return;
}

if(action==='save-single'){
const ta=btn.closest('.nm-slot-section')?.querySelector('.nm-edit-textarea');
if(!ta)return;
const newContent=ta.value.trim();
if(newContent){
updateSlotValue(core.store,entId,slotName,newContent,{keywords:extractKeywords(newContent)});
}
await saveStore(core.store);
panel.innerHTML=renderEntityBrowser();
attachBrowserEvents(panel);
return;
}

if(action==='edit-entry'){
const entryEl=btn.closest('.nm-slot-entry');
const contentEl=entryEl?.querySelector('.nm-entry-content');
if(!contentEl)return;
const oldText=contentEl.textContent.replace(/^[📌⚡ ]+/,'');
contentEl.innerHTML=`<textarea class="nm-edit-textarea text_pole">${escHtml(oldText)}</textarea>
<div class="nm-edit-actions">
<button class="menu_button" data-action="save-entry" data-entid="${escHtml(entId)}" data-slot="${slotName}" data-entryid="${escHtml(entryId)}">✓</button>
<button class="menu_button" data-action="cancel-edit">✗</button>
</div>`;
const ta=contentEl.querySelector('textarea');
if(ta){ta.focus();ta.setSelectionRange(ta.value.length,ta.value.length)}
return;
}

if(action==='save-entry'){
const ta=btn.closest('.nm-slot-entry')?.querySelector('.nm-edit-textarea');
if(!ta)return;
const newContent=ta.value.trim();
if(newContent){
updateSlotEntry(core.store,entId,slotName,entryId,{content:newContent,keywords:extractKeywords(newContent)});
}
await saveStore(core.store);
panel.innerHTML=renderEntityBrowser();
attachBrowserEvents(panel);
return;
}

if(action==='cancel-edit'){
panel.innerHTML=renderEntityBrowser();
attachBrowserEvents(panel);
return;
}

if(action==='delete-entry'){
const ent=core.store.entities[entId];
if(!ent)return;
const slot=ent.slots[slotName];
if(!slot||slot.mode!=='ARRAY')return;
const entry=slot.entries.find(e=>e.id===entryId);
if(!entry)return;
if(!confirm(`Eintrag löschen?\n"${entry.content.substring(0,80)}"`))return;
removeSlotEntry(core.store,entId,slotName,entryId);
await saveStore(core.store);
updateUI();
panel.innerHTML=renderEntityBrowser();
attachBrowserEvents(panel);
return;
}
};
}

function showLastInjected(){
const results=core.getLastInjected();
if(!results.length){showDebug('Keine Entities injiziert.');return}

// Exakten injizierten Text generieren (wie er an die KI geht)
const relevanceMap=core.lastRelevanceMap;
const exactText=formatEntityContext(results,core.settings.maxContextTokens,core.store,relevanceMap,core.settings.topK);

let html='<h3>Last Injected ('+results.length+' Entities)</h3>';

// Relevanz-Farben
const relColors={high:'#4caf50',medium:'#ff9800',low:'#78909c'};
const relLabels={high:'HIGH',medium:'MED',low:'LOW'};

// Entity-Liste mit Scores + Relevanz
for(const r of results){
const ent=r.entity;
const icon=ENTITY_TYPE_ICONS[ent.type]||'';
// Relevanz aus Map holen
let rel='—';
let relColor='#666';
if(relevanceMap){
const key=ent.name.toLowerCase();
let found=relevanceMap.get(key);
if(!found){
for(const a of(ent.aliases||[])){
found=relevanceMap.get(a.toLowerCase());
if(found)break;
}}
if(found){rel=relLabels[found.relevance]||found.relevance;relColor=relColors[found.relevance]||'#666'}
}
const recallTag=r.isAssociativeRecall?` 🔗 RECALL via ${escHtml(r.recallTrigger||'')}`:'';
html+=`<div class="nm-entity-item nm-entity-type-${ent.type}">
<div class="nm-entity-header"><span>${icon} ${escHtml(ent.name)}</span> <span style="color:${relColor};font-weight:bold;margin:0 6px">${rel}</span> score:${r.score.toFixed(3)} act:${r.activation.toFixed(3)}${recallTag}</div></div>`;
}

// Exakter injizierter Text
html+=`<h3>Exakter Injection-Text (${exactText.length} chars, ~${estimateTokens(exactText)} tokens)</h3>`;
html+=`<pre class="nm-injection-preview">${escHtml(exactText)}</pre>`;

showPopup('Last Injected Entities',html);
}

// ============================================================
// Manual Add Entry
// ============================================================

async function doAddEntry(){
const nameEl=document.getElementById('nm_newEntityName');
const name=nameEl?.value.trim();
if(!name){setStatus('Entity-Name eingeben',true);return}
if(!core.store||!core.charId){setStatus('Kein Charakter geladen',true);return}

const type=document.getElementById('nm_newEntityType')?.value||'concept';
const slotName=document.getElementById('nm_newSlotName')?.value||'notes';
const content=document.getElementById('nm_newSlotContent')?.value.trim()||'';
if(!content){setStatus('Inhalt eingeben',true);return}

const importance=parseFloat(document.getElementById('nm_newImportance')?.value||'0.8');
const valence=parseFloat(document.getElementById('nm_newValence')?.value||'0');
const intensity=parseFloat(document.getElementById('nm_newIntensity')?.value||'0');
const pinned=document.getElementById('nm_newPinned')?.checked||false;

// Entity finden oder erstellen
let ent=getEntityByName(core.store,name);
if(!ent){
ent=createEntityNode(name,core.charId,type);
addEntity(core.store,ent);
console.log(`[NM] manual: created entity ${name} (${type})`);
}

const schema=ENTITY_SCHEMAS[ent.type]||{};
const slotDef=schema[slotName];
if(!slotDef){setStatus(`Slot ${slotName} nicht für ${ent.type}`,true);return}

const slot=ent.slots[slotName];
if(!slot){setStatus('Slot nicht gefunden',true);return}

const keywords=extractKeywords(content);
if(slot.mode==='SINGLE'){
updateSlotValue(core.store,ent.id,slotName,content,{
keywords,importance,emotionalValence:valence,emotionalIntensity:intensity,
pinned,userCreated:true,
});
}else{
const entry=createSlotEntry(content,{
keywords,importance,emotionalValence:valence,emotionalIntensity:intensity,
pinned,userCreated:true,
});
addSlotEntry(core.store,ent.id,slotName,entry);
}

await saveStore(core.store);
updateUI();

// Formular leeren
if(nameEl)nameEl.value='';
const contentEl=document.getElementById('nm_newSlotContent');if(contentEl)contentEl.value='';
const pinnedCb=document.getElementById('nm_newPinned');if(pinnedCb)pinnedCb.checked=false;
setStatus(`✓ ${ent.name}.${slotName} aktualisiert`);

const panel=document.querySelector('.nm-browser-panel');
if(panel){panel.innerHTML=renderEntityBrowser();attachBrowserEvents(panel)}
}

// ============================================================
// Import Functions (Card, Lorebook, Text)
// ============================================================

async function doImportFromCard(){
const c=getCtx();
if(!c||!core.store||!core.charId){setStatus('Kein Charakter geladen',true);return}
if(c.groupId){setStatus('Import nicht für Gruppen',true);return}
const char=c.characters[c.characterId];
if(!char){setStatus('Charakter nicht gefunden',true);return}
const cardText=[char.description,char.personality,char.scenario].filter(Boolean).join('\n\n').trim();
if(!cardText){setStatus('Keine Card-Daten',true);return}
if(!core._generateFn){setStatus('Kein AI-Modell',true);return}

setStatus('Importiere aus Character Card...');
const origPrompt=getExtractionPrompt();
setExtractionPrompt(CARD_EXTRACT_SYSTEM);
try{
const fakeChat=[{is_user:true,name:'System',mes:'Analyze this character description:'},{is_user:false,name:char.name,mes:cardText}];
const updates=await extractMemories(core._generateFn,fakeChat,core.charId,2,core.store);
setExtractionPrompt(origPrompt);
if(!updates.length){setStatus('Keine Entity-Updates extrahiert',true);return}
// Hohe Stabilität für Card-Imports
const{added,merged}=integrateEntityUpdates(core.store,updates);
// Stabilitaet nachtraeglich erhoehen
for(const ent of Object.values(core.store.entities)){
for(const slot of Object.values(ent.slots)){
if(slot.mode==='SINGLE'&&slot.value)slot.stability=Math.max(slot.stability||1,2.0);
else if(slot.mode==='ARRAY')for(const e of slot.entries)e.stability=Math.max(e.stability||1,2.0);
}}
updateEntityConnections(core.store);
core.store.meta.cardImported=true;
await saveStore(core.store);
updateUI();
setStatus(`✓ ${updates.length} Updates aus Card (${added} neu, ${merged} merged)`);
}catch(e){
setExtractionPrompt(origPrompt);
setStatus('Import Error: '+e.message,true);
}
}

async function doImportFromText(){
const textEl=document.getElementById('nm_importText');
const text=textEl?.value.trim();
if(!text){setStatus('Text eingeben',true);return}
if(!core.store||!core.charId||!core._generateFn){setStatus('Kein Charakter/AI-Modell',true);return}

setStatus('Importiere aus Text...');
const fakeChat=[{is_user:true,name:'System',mes:'Analyze this text:'},{is_user:false,name:core.charName||'Character',mes:text}];
try{
const updates=await extractMemories(core._generateFn,fakeChat,core.charId,2,core.store);
if(!updates.length){setStatus('Keine Updates extrahiert',true);return}
integrateEntityUpdates(core.store,updates);
updateEntityConnections(core.store);
await saveStore(core.store);
updateUI();
if(textEl)textEl.value='';
setStatus(`✓ ${updates.length} Entity-Updates importiert`);
}catch(e){setStatus('Import Error: '+e.message,true)}
}

async function doImportFromLorebook(){
if(!core.store||!core.charId||!core._generateFn){setStatus('Kein Charakter/AI-Modell',true);return}
let selected_world_info,wiLoadFn;
try{
const wi=await import('/scripts/world-info.js');
selected_world_info=wi.selected_world_info;
wiLoadFn=wi.loadWorldInfo;
}catch(e){
const c=getCtx();
wiLoadFn=c?.loadWorldInfo?.bind(c);
selected_world_info=[];
}
if(!selected_world_info?.length){setStatus('Kein Lorebook aktiv',true);return}

setStatus('Smart-Import aus Lorebook...');
let totalUpdates=0;
const origPrompt=getExtractionPrompt();
setExtractionPrompt(LOREBOOK_EXTRACT_SYSTEM);

for(const bookName of selected_world_info){
let data;
try{data=await wiLoadFn(bookName)}catch(e){continue}
if(!data?.entries)continue;
const entries=Object.values(data.entries).filter(e=>!e.disable&&e.content?.trim().length>5);
if(!entries.length)continue;

const BATCH_SIZE=6;
const batches=[];
for(let i=0;i<entries.length;i+=BATCH_SIZE)batches.push(entries.slice(i,i+BATCH_SIZE));

for(let bi=0;bi<batches.length;bi++){
const batch=batches[bi];
setStatus(`📚 ${bookName}: Batch ${bi+1}/${batches.length}...`);
const batchText=batch.map(e=>{
const title=e.comment||e.key?.[0]||'Entry';
return`[${title}]\n${e.content}`;
}).join('\n\n---\n\n');

const fakeChat=[{is_user:true,name:'System',mes:'Analyze the following lorebook entries:'},{is_user:false,name:'Lorebook',mes:batchText}];
try{
const updates=await extractMemories(core._generateFn,fakeChat,core.charId,2,core.store);
if(updates.length){
integrateEntityUpdates(core.store,updates);
totalUpdates+=updates.length;
// Hohe Stabilitaet + ggf. pinnen fuer constant entries
const allConstant=batch.every(e=>e.constant);
for(const ent of Object.values(core.store.entities)){
for(const slot of Object.values(ent.slots)){
if(slot.mode==='SINGLE'&&slot.value)slot.stability=Math.max(slot.stability||1,3.0);
else if(slot.mode==='ARRAY'){
for(const e of slot.entries){
e.stability=Math.max(e.stability||1,3.0);
if(allConstant)e.pinned=true;
}}}}
}
}catch(e){console.error(`[NM] lorebook batch ${bi+1} error:`,e)}
}
}
setExtractionPrompt(origPrompt);
if(!totalUpdates){setStatus('Keine Updates extrahiert',true);return}
updateEntityConnections(core.store);
await saveStore(core.store);
updateUI();
setStatus(`✓ ${totalUpdates} Entity-Updates aus Lorebook importiert`);
}

async function doGenerateDigest(){
if(!core.store||!core._generateFn){setStatus('Kein Charakter/AI',true);return}
setStatus('Generiere Digest...');
try{
const{generateDigest}=await import('./src/consolidation.js');
const digestText=await generateDigest(core._generateFn,core.store);
if(digestText){
core.store.digest={text:digestText,generatedAt:Date.now(),entryCount:countTotalEntries(core.store)};
await saveStore(core.store);
setStatus('✓ Digest generiert');
}else{
setStatus('Zu wenig Daten (mind. 2 Entities)',true);
}
}catch(e){setStatus('Digest Error: '+e.message,true)}
}

async function doExport(){
const charId=getCharId();
if(!charId){showDebug('No character loaded');return}
const json=await exportStore(charId);
const blob=new Blob([json],{type:'application/json'});
const url=URL.createObjectURL(blob);
const a=document.createElement('a');
a.href=url;a.download=`neuromemory_v3_${charId}.json`;
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
showDebug(`Imported: ${Object.keys(store.entities).length} entities`);
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
const result=await c.callGenericPopup('ALLE Entity-Daten für diesen Charakter löschen? Kann nicht rückgängig gemacht werden.',c.POPUP_TYPE.CONFIRM);
if(result!==c.POPUP_RESULT.AFFIRMATIVE)return;
}
await deleteStore(core.charId);
await core.loadCharacter(core.charId,core.charName);
updateUI();
showDebug('Alle Entity-Daten gelöscht');
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
function escHtmlAttr(s){
return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ============================================================
// Message Lifecycle Hooks
// ============================================================

async function onMessageDeleted(msgIdx){
// v2: Entity-Daten sind nicht an einzelne Messages gebunden
// Slot-Entries haben keine sourceMessageIds-basierte Zuordnung
// Loeschung wird durch Decay/Consolidation gehandhabt
console.log('[NM] MESSAGE_DELETED, idx:',msgIdx,'(no action in v2 — handled by decay)');
}

async function onMessageSwiped(msgIdx){
console.log('[NM] MESSAGE_SWIPED, idx:',msgIdx,'(no action in v2)');
}

async function onMessageEdited(msgIdx){
if(!core.store||!core.settings.enabled||!core._generateFn)return;
console.log('[NM] MESSAGE_EDITED, idx:',msgIdx);
const c=getCtx();
if(!c||!c.chat||!c.chat[msgIdx])return;
const start=Math.max(0,msgIdx-1);
const end=Math.min(c.chat.length,msgIdx+2);
const chatSlice=c.chat.slice(start,end).map(m=>({is_user:m.is_user,name:m.name,mes:m.mes}));
try{
const updates=await extractMemories(core._generateFn,chatSlice,core.charId,chatSlice.length,core.store);
if(updates.length){
integrateEntityUpdates(core.store,updates);
updateEntityConnections(core.store);
await saveStore(core.store);
updateUI();
setStatus(`${updates.length} Updates aus editierter Nachricht`);
}
}catch(e){console.error('[NM] MESSAGE_EDITED extraction error',e)}
}

// ============================================================
// Generate Function (reasoning_content Handling)
// ============================================================

async function nmGenerate(opts){
const ctx=getCtx();
if(!ctx)throw new Error('No SillyTavern context');

if(ctx.mainApi==='openai'){
const settings=ctx.chatCompletionSettings;
const model=ctx.getChatCompletionModel(settings);

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
throw new Error(`API error: ${response.status}`);
}

const data=await response.json();
if(data.error)throw new Error(data.error.message||'API error');

const msg=data?.choices?.[0]?.message;
if(!msg)return'';

let text=msg.content||'';
const reasoning=msg.reasoning_content||'';
if(reasoning)text='<think>'+reasoning+'</think>'+text;
return text;
}

return ctx.generateQuietPrompt(opts);
}

// ============================================================
// Init
// ============================================================

jQuery(async function(){
try{
console.log('[NM] init start (v3.0)');
const c=getCtx();
if(!c){console.error('[NM] Could not get context');return}

const settingsContainer=document.getElementById('extensions_settings2');
if(settingsContainer){
settingsContainer.insertAdjacentHTML('beforeend',buildSettingsHTML());
bindEvents();
}

setContextGetter(getCtx);
loadSettings();
syncUIFromSettings();
core.setGenerateFn(nmGenerate);

c.eventSource.on(c.eventTypes.CHAT_CHANGED,onChatChanged);
c.eventSource.on(c.eventTypes.CHAT_LOADED,onChatChanged);
c.eventSource.on(c.eventTypes.MESSAGE_SENT,onUserMessageSent);
c.eventSource.on(c.eventTypes.MESSAGE_RECEIVED,onMessageReceived);
c.eventSource.on(c.eventTypes.GENERATION_STARTED,onGenerateBefore);
if(c.eventTypes.MESSAGE_DELETED)c.eventSource.on(c.eventTypes.MESSAGE_DELETED,onMessageDeleted);
if(c.eventTypes.MESSAGE_SWIPED)c.eventSource.on(c.eventTypes.MESSAGE_SWIPED,onMessageSwiped);
if(c.eventTypes.MESSAGE_EDITED)c.eventSource.on(c.eventTypes.MESSAGE_EDITED,onMessageEdited);

const charId=getCharId(c);
if(charId){
await core.loadCharacter(charId,getCharName(c));
}
updateUI();

console.log('[NM] NeuroMemory v3.0 initialized');
}catch(e){console.error('[NM] INIT ERROR',e)}
});
