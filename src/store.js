import{now}from'./utils.js';
import{createEntityNode,initSlots,createSlotEntry,ENTITY_SCHEMAS,computeTier}from'./entities.js';

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

function saveToSettings(store){
const ctx=_getCtx?.();
if(!ctx?.extensionSettings)return false;
try{
ctx.extensionSettings[SETTINGS_PREFIX+store.characterId]=JSON.parse(JSON.stringify(store));
ctx.saveSettingsDebounced();
return true;
}catch(e){console.warn('[NM] saveToSettings err',e);return false}
}

function loadFromSettings(charId){
const ctx=_getCtx?.();
if(!ctx?.extensionSettings)return null;
const s=ctx.extensionSettings[SETTINGS_PREFIX+charId];
if(s&&(s.entities||s.memories))return s;
return null;
}

// ============================================================
// Store laden/speichern
// ============================================================

export async function loadStore(charId){
let data=loadFromSettings(charId);
if(!data){
try{
const inst=lf();
if(inst){
const d=await inst.getItem(k(charId));
if(d&&(d.memories||d.entities)){
console.log('[NM] loading from localforage');
data=d;
saveToSettings(d);
}
}
}catch(e){console.warn('[NM] localforage load err',e)}
}
if(!data)return createEmpty(charId,'');
// v1 → v2 Migration
if(!data.meta?.schemaVersion||data.meta.schemaVersion<2){
if(data.memories){
console.log('[NM] migrating v1 → v2...');
const v2=migrateV1toV2(data);
data=v2;
}
}
// v2 → v3 Migration
if((data.meta?.schemaVersion||1)<3){
console.log('[NM] migrating v2 → v3...');
migrateV2toV3(data);
await saveStore(data);
}
// Store-Dedup: Duplikat-Entities zusammenfuehren
const dedupCount=deduplicateStoreEntities(data);
if(dedupCount>0){
console.log(`[NM] store dedup: merged ${dedupCount} duplicate entities`);
await saveStore(data);
}
return data;
}

export function createEmpty(charId,charName){
return{
characterId:charId,characterName:charName,
entities:{},
meta:{totalSlotEntries:0,lastConsolidation:now(),schemaVersion:3},
digest:null,
};
}

export async function saveStore(store){
store.meta.totalSlotEntries=countTotalEntries(store);
saveToSettings(store);
try{
const inst=lf();
if(inst)await inst.setItem(k(store.characterId),store);
}catch(e){console.warn('[NM] localforage backup err',e)}
}

export async function deleteStore(charId){
const ctx=_getCtx?.();
if(ctx?.extensionSettings){
delete ctx.extensionSettings[SETTINGS_PREFIX+charId];
ctx.saveSettingsDebounced();
}
try{const inst=lf();if(inst)await inst.removeItem(k(charId))}catch(e){}
}

// ============================================================
// Entity CRUD
// ============================================================

export function addEntity(store,ent){
store.entities[ent.id]=ent;
}

export function removeEntity(store,entId){
delete store.entities[entId];
for(const e of Object.values(store.entities)){
e.connections=e.connections.filter(c=>c.targetId!==entId);
}
}

export function getEntity(store,entId){
return store.entities[entId]||null;
}

export function getEntityByName(store,name){
const lower=name.toLowerCase();
// Exakter Match (Name oder Alias)
for(const e of Object.values(store.entities)){
if(e.name.toLowerCase()===lower)return e;
if(e.aliases.some(a=>a.toLowerCase()===lower))return e;
}
// Fuzzy Match: Name in Klammern oder Teilname > 4 Zeichen
if(lower.length>4){
for(const e of Object.values(store.entities)){
const parts=_extractNameParts(e.name);
if(parts.some(p=>p.length>4&&(p.includes(lower)||lower.includes(p))))return e;
const aliasParts=(e.aliases||[]).flatMap(a=>_extractNameParts(a));
if(aliasParts.some(p=>p.length>4&&(p.includes(lower)||lower.includes(p))))return e;
}}
return null;
}

export function getAllEntities(store){
return Object.values(store.entities);
}

// ============================================================
// Slot CRUD
// ============================================================

export function updateSlotValue(store,entityId,slotName,value,metadata={}){
const ent=store.entities[entityId];
if(!ent)return false;
const slot=ent.slots[slotName];
if(!slot||slot.mode!=='SINGLE')return false;
slot.value=typeof value==='string'?value.slice(0,500):value;
slot.keywords=metadata.keywords||slot.keywords;
slot.importance=metadata.importance??slot.importance;
slot.stability=Math.max(slot.stability,(metadata.stability||1.0));
slot.retrievability=1.0;
slot.emotionalValence=metadata.emotionalValence??slot.emotionalValence;
slot.emotionalIntensity=metadata.emotionalIntensity??slot.emotionalIntensity;
slot.updatedAt=now();
slot.lastReinforcedAt=now();
if(metadata.pinned!==undefined)slot.pinned=metadata.pinned;
if(metadata.userCreated!==undefined)slot.userCreated=metadata.userCreated;
return true;
}

export function addSlotEntry(store,entityId,slotName,entry){
const ent=store.entities[entityId];
if(!ent)return false;
const slot=ent.slots[slotName];
if(!slot||slot.mode!=='ARRAY')return false;
slot.entries.push(entry);
return true;
}

export function removeSlotEntry(store,entityId,slotName,entryId){
const ent=store.entities[entityId];
if(!ent)return false;
const slot=ent.slots[slotName];
if(!slot||slot.mode!=='ARRAY')return false;
slot.entries=slot.entries.filter(e=>e.id!==entryId);
return true;
}

export function updateSlotEntry(store,entityId,slotName,entryId,patch){
const ent=store.entities[entityId];
if(!ent)return false;
const slot=ent.slots[slotName];
if(!slot||slot.mode!=='ARRAY')return false;
const entry=slot.entries.find(e=>e.id===entryId);
if(!entry)return false;
Object.assign(entry,patch);
return true;
}

export function getSlotValue(store,entityId,slotName){
const ent=store.entities[entityId];
if(!ent)return null;
const slot=ent.slots[slotName];
if(!slot)return null;
return slot.mode==='SINGLE'?slot.value:slot.entries;
}

// ============================================================
// Hilfsfunktionen
// ============================================================

export function getAllSlotEntries(store){
const results=[];
for(const ent of Object.values(store.entities)){
for(const[slotName,slot]of Object.entries(ent.slots)){
if(slot.mode==='SINGLE'&&slot.value){
results.push({entityId:ent.id,entityName:ent.name,entityType:ent.type,
slotName,entryId:null,content:slot.value,keywords:slot.keywords,
importance:slot.importance,retrievability:slot.retrievability,
emotionalIntensity:slot.emotionalIntensity,emotionalValence:slot.emotionalValence,
pinned:slot.pinned,lastAccessedAt:slot.lastAccessedAt,lastReinforcedAt:slot.lastReinforcedAt,
stability:slot.stability,accessCount:slot.accessCount,createdAt:slot.updatedAt});
}else if(slot.mode==='ARRAY'){
for(const entry of slot.entries){
results.push({entityId:ent.id,entityName:ent.name,entityType:ent.type,
slotName,entryId:entry.id,content:entry.content,keywords:entry.keywords,
importance:entry.importance,retrievability:entry.retrievability,
emotionalIntensity:entry.emotionalIntensity,emotionalValence:entry.emotionalValence,
pinned:entry.pinned,lastAccessedAt:entry.lastAccessedAt,lastReinforcedAt:entry.lastReinforcedAt,
stability:entry.stability,accessCount:entry.accessCount,createdAt:entry.createdAt});
}}}}
return results;
}

export function countTotalEntries(store){
let count=0;
for(const ent of Object.values(store.entities)){
for(const slot of Object.values(ent.slots)){
if(slot.mode==='SINGLE'&&slot.value)count++;
else if(slot.mode==='ARRAY')count+=slot.entries.length;
}}
return count;
}

// ============================================================
// Export/Import
// ============================================================

export async function exportStore(charId){
const s=await loadStore(charId);
return JSON.stringify(s,null,2);
}

export async function importStore(json){
const s=JSON.parse(json);
if(!s.characterId)throw new Error('Invalid store format');
if(s.memories&&(!s.meta?.schemaVersion||s.meta.schemaVersion<2)){
const v2=migrateV1toV2(s);
await saveStore(v2);
return v2;
}
if(!s.entities)throw new Error('Invalid v2 store format');
await saveStore(s);
return s;
}

// ============================================================
// Store-Dedup: Duplikat-Entities zusammenfuehren
// ============================================================

function _extractNameParts(name){
const parts=[];
const paren=name.match(/\(([^)]+)\)/);
if(paren)parts.push(paren[1].toLowerCase().trim());
const base=name.replace(/\([^)]+\)/,'').trim();
parts.push(base.toLowerCase());
for(const w of base.split(/\s+/)){
if(w.length>3)parts.push(w.toLowerCase());
}
return[...new Set(parts)];
}

function _entitiesAreDuplicates(a,b){
if(a.type!==b.type)return false;// Nur gleichen Typ mergen
const partsA=_extractNameParts(a.name);
const partsB=_extractNameParts(b.name);
for(const pa of partsA){
if(pa.length<3)continue;
for(const pb of partsB){
if(pb.length<3)continue;
if(pa===pb)return true;
if(pa.length>4&&pb.includes(pa))return true;
if(pb.length>4&&pa.includes(pb))return true;
}}
const allA=[a.name.toLowerCase(),...(a.aliases||[]).map(x=>x.toLowerCase())];
const allB=[b.name.toLowerCase(),...(b.aliases||[]).map(x=>x.toLowerCase())];
for(const na of allA){for(const nb of allB){if(na===nb)return true}}
return false;
}

function _mergeEntityInto(primary,dupe){
// Aliases: alle Namen des Dupes als Aliases merken
const allNames=new Set((primary.aliases||[]).map(a=>a.toLowerCase()));
allNames.add(primary.name.toLowerCase());
if(!allNames.has(dupe.name.toLowerCase())){
primary.aliases.push(dupe.name);
}
for(const a of(dupe.aliases||[])){
if(!allNames.has(a.toLowerCase()))primary.aliases.push(a);
}
// Timestamps + counts
primary.firstSeen=Math.min(primary.firstSeen||Infinity,dupe.firstSeen||Infinity);
primary.lastSeen=Math.max(primary.lastSeen||0,dupe.lastSeen||0);
primary.mentionCount=(primary.mentionCount||0)+(dupe.mentionCount||0);
// Connections mergen
const existingTargets=new Set(primary.connections.map(c=>c.targetId));
for(const c of(dupe.connections||[])){
if(c.targetId===primary.id)continue;// Keine Self-Connection
if(!existingTargets.has(c.targetId)){
primary.connections.push(c);
existingTargets.add(c.targetId);
}
}
// Slots mergen
for(const[slotName,dupeSlot]of Object.entries(dupe.slots)){
const pSlot=primary.slots[slotName];
if(!pSlot)continue;
if(dupeSlot.mode==='SINGLE'&&dupeSlot.value){
if(!pSlot.value||dupeSlot.value.length>pSlot.value.length){
pSlot.value=dupeSlot.value;
pSlot.keywords=dupeSlot.keywords||pSlot.keywords;
pSlot.importance=Math.max(pSlot.importance||0,dupeSlot.importance||0);
pSlot.emotionalIntensity=Math.max(pSlot.emotionalIntensity||0,dupeSlot.emotionalIntensity||0);
pSlot.emotionalValence=dupeSlot.emotionalValence||pSlot.emotionalValence;
pSlot.updatedAt=Math.max(pSlot.updatedAt||0,dupeSlot.updatedAt||0);
pSlot.lastReinforcedAt=Math.max(pSlot.lastReinforcedAt||0,dupeSlot.lastReinforcedAt||0);
}
}else if(dupeSlot.mode==='ARRAY'&&dupeSlot.entries?.length){
for(const entry of dupeSlot.entries){
// Content-Dedup: gleichen Inhalt nicht doppelt
const isDup=pSlot.entries.some(e=>e.content===entry.content);
if(!isDup)pSlot.entries.push(entry);
}
}
}
}

export function deduplicateStoreEntities(store){
if(!store?.entities)return 0;
const entities=Object.values(store.entities);
if(entities.length<2)return 0;

// Sortiere nach mentionCount (haeufigster zuerst = wird Primary)
entities.sort((a,b)=>(b.mentionCount||0)-(a.mentionCount||0));

const merged=new Set;// IDs die gemergt wurden
let mergeCount=0;

for(let i=0;i<entities.length;i++){
if(merged.has(entities[i].id))continue;
const primary=entities[i];
for(let j=i+1;j<entities.length;j++){
if(merged.has(entities[j].id))continue;
if(_entitiesAreDuplicates(primary,entities[j])){
console.log(`[NM] dedup: merging "${entities[j].name}" into "${primary.name}"`);
_mergeEntityInto(primary,entities[j]);
merged.add(entities[j].id);
mergeCount++;
}
}
}

// Gemergte Entities entfernen + Connections umleiten
if(mergeCount>0){
// Map: gemergte ID → primary ID
const redirectMap=new Map;
for(let i=0;i<entities.length;i++){
if(merged.has(entities[i].id))continue;
const primary=entities[i];
for(let j=i+1;j<entities.length;j++){
if(!merged.has(entities[j].id))continue;
if(_entitiesAreDuplicates(primary,entities[j])){
redirectMap.set(entities[j].id,primary.id);
}
}}
// Entities loeschen
for(const id of merged)delete store.entities[id];
// Connections umleiten
for(const ent of Object.values(store.entities)){
ent.connections=ent.connections.map(c=>{
if(redirectMap.has(c.targetId))c.targetId=redirectMap.get(c.targetId);
return c;
}).filter(c=>c.targetId!==ent.id);// Keine Self-Connections
// Duplikat-Connections entfernen
const seen=new Set;
ent.connections=ent.connections.filter(c=>{
if(seen.has(c.targetId))return false;
seen.add(c.targetId);return true;
});
}
}

return mergeCount;
}

// ============================================================
// v2 → v3 Migration: Tiers, Zeitlinie, Story-Arcs, Wisdom
// ============================================================

function migrateV2toV3(store){
let upgradedEntries=0;
let wisdomAdded=0;

for(const ent of Object.values(store.entities)){
// 1. Person-Entities: wisdom-Slot hinzufuegen falls fehlend
if(ent.type==='person'&&!ent.slots.wisdom){
ent.slots.wisdom={mode:'SINGLE',value:null,keywords:[],importance:0,stability:1.0,retrievability:1.0,
emotionalValence:0,emotionalIntensity:0,updatedAt:0,accessCount:0,lastAccessedAt:0,lastReinforcedAt:0,
pinned:false,userCreated:false,tier:'episodic'};
wisdomAdded++;
}

for(const[slotName,slot]of Object.entries(ent.slots)){
if(slot.mode==='SINGLE'){
// Tier hinzufuegen + berechnen
if(!slot.tier){
slot.tier=computeTier(slot);
upgradedEntries++;
}
}else if(slot.mode==='ARRAY'){
// sequenceIndex basierend auf createdAt setzen
const sorted=[...slot.entries].sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
for(let i=0;i<sorted.length;i++){
const entry=sorted[i];
if(entry.sequenceIndex===undefined||entry.sequenceIndex===0){
entry.sequenceIndex=i+1;
}
if(!entry.storyArc&&entry.storyArc!==null){
entry.storyArc=null;
}
if(!entry.tier){
entry.tier=computeTier(entry);
}
upgradedEntries++;
}
}
}
}

store.meta.schemaVersion=3;
console.log(`[NM] v2→v3 migration: ${upgradedEntries} entries upgraded, ${wisdomAdded} wisdom slots added`);
}

// ============================================================
// v1 → v2 Migration
// ============================================================

function migrateV1toV2(v1){
const v2=createEmpty(v1.characterId,v1.characterName||'');
if(v1.digest)v2.digest=v1.digest;

const v1Mems=v1.memories?Object.values(v1.memories):[];
const v1Ents=v1.entities?Object.values(v1.entities):[];

// Finde Entities die person-Memories haben
const personEntityNames=new Set;
for(const m of v1Mems){
if(m.subtype==='person'&&m.entities?.length){
for(const e of m.entities)personEntityNames.add(e.toLowerCase());
}}

// Entities uebernehmen
for(const oldEnt of v1Ents){
const isPerson=personEntityNames.has(oldEnt.name.toLowerCase());
const type=isPerson?'person':'concept';
const newEnt=createEntityNode(oldEnt.name,v2.characterId,type);
newEnt.id=oldEnt.id;
newEnt.aliases=oldEnt.aliases||[];
newEnt.firstSeen=oldEnt.firstSeen||now();
newEnt.lastSeen=oldEnt.lastSeen||now();
newEnt.mentionCount=oldEnt.mentionCount||1;
newEnt.connections=(oldEnt.connections||[]).filter(c=>c.targetId?.startsWith('e_'));
v2.entities[newEnt.id]=newEnt;
}

// Memories auf Slots verteilen
for(const m of v1Mems){
const entityName=m.entities?.[0];
if(!entityName){
// Orphan → _unassigned
const unId='e__unassigned';
if(!v2.entities[unId]){
const un=createEntityNode('_unassigned',v2.characterId,'concept');
un.id=unId;
v2.entities[unId]=un;
}
const entry=_memToEntry(m);
v2.entities[unId].slots.notes.entries.push(entry);
continue;
}

const entId='e_'+entityName.toLowerCase().replace(/[^a-z0-9]/g,'_').slice(0,32);
if(!v2.entities[entId]){
const isPerson=personEntityNames.has(entityName.toLowerCase());
const ent=createEntityNode(entityName,v2.characterId,isPerson?'person':'concept');
ent.id=entId;
v2.entities[entId]=ent;
}
const ent=v2.entities[entId];

// Slot bestimmen
let slotName='notes';
if(m.subtype==='person')slotName='profile';
else if(m.subtype==='plot')slotName='plot';
else if(m.type==='emotional')slotName='emotions';
else if(m.type==='relational')slotName='relations';
else if(m.type==='episodic')slotName='plot';

if(!ent.slots[slotName])slotName='notes';
if(!ent.slots[slotName])continue;

const slot=ent.slots[slotName];
if(slot.mode==='SINGLE'){
if(!slot.value||m.content.length>slot.value.length){
slot.value=m.content.slice(0,500);
slot.keywords=m.keywords||[];
slot.importance=Math.max(slot.importance,m.importance||0.5);
slot.stability=Math.max(slot.stability,m.stability||1.0);
slot.retrievability=m.retrievability||1.0;
slot.emotionalValence=m.emotionalValence||0;
slot.emotionalIntensity=m.emotionalIntensity||0;
slot.updatedAt=m.createdAt||now();
slot.lastReinforcedAt=m.lastReinforcedAt||now();
slot.pinned=slot.pinned||m.pinned||false;
}
}else{
slot.entries.push(_memToEntry(m));
}
}

const entCount=Object.keys(v2.entities).length;
const slotCount=countTotalEntries(v2);
console.log(`[NM] migration complete: ${v1Mems.length} memories → ${entCount} entities, ${slotCount} slot entries`);
return v2;
}

function _memToEntry(m){
const entry=createSlotEntry(m.content,{
keywords:m.keywords,importance:m.importance,stability:m.stability,
emotionalValence:m.emotionalValence,emotionalIntensity:m.emotionalIntensity,
pinned:m.pinned,userCreated:m.userCreated,sourceMessageIds:m.sourceMessageIds,
relatedEntities:m.entities?.slice(1)||[],
});
entry.retrievability=m.retrievability||1.0;
entry.createdAt=m.createdAt||now();
entry.lastAccessedAt=m.lastAccessedAt||now();
entry.lastReinforcedAt=m.lastReinforcedAt||now();
entry.accessCount=m.accessCount||0;
return entry;
}
