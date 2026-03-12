import{now}from'./utils.js';
const DB_NAME='NeuroMemory';
let _lf=null;
function lf(){
if(!_lf){
if(typeof localforage!=='undefined')_lf=localforage.createInstance({name:DB_NAME});
else throw new Error('localforage not available');
}return _lf;
}
function k(charId){return`nm_${charId}`}

export async function loadStore(charId){
try{
const d=await lf().getItem(k(charId));
if(d)return d;
}catch(e){console.warn('[NM] loadStore err',e)}
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
try{
store.meta.totalMemories=Object.keys(store.memories).length;
await lf().setItem(k(store.characterId),store);
}catch(e){console.error('[NM] saveStore err',e)}
}

export async function deleteStore(charId){
try{await lf().removeItem(k(charId))}catch(e){console.error('[NM] deleteStore err',e)}
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
