import{now}from'./utils.js';

// Context-Getter wird von index.js gesetzt
let _getCtx=null;
export function setContextGetter(fn){_getCtx=fn}

const DB_NAME='NeuroMemory';
const SETTINGS_PREFIX='nm_store_';
let _lf=null;
function lf(){
if(!_lf){
if(typeof localforage!=='undefined')_lf=localforage.createInstance({name:DB_NAME});
else return null;
}return _lf;
}
function k(charId){return`nm_${charId}`}

// Speichert Store in extensionSettings (server-persistent via settings.json)
function saveToSettings(store){
const ctx=_getCtx?.();
if(!ctx?.extensionSettings)return false;
try{
ctx.extensionSettings[SETTINGS_PREFIX+store.characterId]=JSON.parse(JSON.stringify(store));
ctx.saveSettingsDebounced();
console.log('[NM] saved to extensionSettings:',Object.keys(store.memories).length,'memories');
return true;
}catch(e){console.warn('[NM] saveToSettings err',e);return false}
}

// Laedt Store aus extensionSettings
function loadFromSettings(charId){
const ctx=_getCtx?.();
if(!ctx?.extensionSettings)return null;
const s=ctx.extensionSettings[SETTINGS_PREFIX+charId];
if(s&&s.memories){
console.log('[NM] loaded from extensionSettings:',Object.keys(s.memories).length,'memories for',charId);
return s;
}
return null;
}

export async function loadStore(charId){
// Primaer: extensionSettings (server-seitig, 100% persistent)
const fromSettings=loadFromSettings(charId);
if(fromSettings)return fromSettings;

// Fallback: localforage (Migration alter Daten)
try{
const inst=lf();
if(inst){
const d=await inst.getItem(k(charId));
if(d&&d.memories){
console.log('[NM] migrating from localforage:',Object.keys(d.memories).length,'memories');
// Zu extensionSettings migrieren
saveToSettings(d);
return d;
}
}
}catch(e){console.warn('[NM] localforage load err',e)}

return createEmpty(charId,'');
}

export function createEmpty(charId,charName){
return{
characterId:charId,characterName:charName,
memories:{},entities:{},
meta:{totalMemories:0,lastConsolidation:now(),schemaVersion:1}
};
}

export async function saveStore(store){
store.meta.totalMemories=Object.keys(store.memories).length;
// Primaer: extensionSettings
saveToSettings(store);
// Backup: localforage
try{
const inst=lf();
if(inst)await inst.setItem(k(store.characterId),store);
}catch(e){console.warn('[NM] localforage backup err',e)}
}

export async function deleteStore(charId){
// extensionSettings
const ctx=_getCtx?.();
if(ctx?.extensionSettings){
delete ctx.extensionSettings[SETTINGS_PREFIX+charId];
ctx.saveSettingsDebounced();
}
// localforage
try{const inst=lf();if(inst)await inst.removeItem(k(charId))}catch(e){}
}

export function addMemory(store,mem){
store.memories[mem.id]=mem;
}

export function removeMemory(store,memId){
delete store.memories[memId];
for(const m of Object.values(store.memories)){
m.connections=m.connections.filter(c=>c.targetId!==memId);
}
for(const e of Object.values(store.entities)){
e.connections=e.connections.filter(c=>c.targetId!==memId);
}
}

export function updateMemory(store,memId,patch){
if(store.memories[memId])Object.assign(store.memories[memId],patch);
}

export function addEntity(store,ent){
store.entities[ent.id]=ent;
}

export function getEntity(store,entId){
return store.entities[entId]||null;
}

export function getAllMemories(store){
return Object.values(store.memories);
}

export function getAllEntities(store){
return Object.values(store.entities);
}

export async function exportStore(charId){
const s=await loadStore(charId);
return JSON.stringify(s,null,2);
}

export async function importStore(json){
const s=JSON.parse(json);
if(!s.characterId||!s.memories)throw new Error('Invalid store format');
await saveStore(s);
return s;
}
