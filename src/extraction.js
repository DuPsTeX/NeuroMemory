import{uid,now,tokenize,cosineSim,extractKeywords}from'./utils.js';
import{extractEntitiesFromText,createEntityNode,updateEntityMention,createSlotEntry,getSlotSchema,initSlots,ENTITY_SCHEMAS}from'./entities.js';
import{addEntity,getEntity,getEntityByName,addSlotEntry,updateSlotValue,getAllEntities}from'./store.js';
import{eid}from'./utils.js';

export const DEFAULT_EXTRACT_SYSTEM=`You are an entity-centric memory extraction system for a roleplay conversation.
Analyze the conversation excerpt and extract information organized BY ENTITY.

Return a JSON array of entity updates. Each object:
- "entity": string (name of the person, place, item, faction, or concept)
- "entityType": "person"|"location"|"item"|"faction"|"concept"
- "slot": string (which slot to update — see allowed slots below)
- "content": string (the information, 1-2 sentences max)
- "emotionalValence": number (-1.0 to 1.0)
- "emotionalIntensity": number (0.0 to 1.0)
- "importance": number (0.0 to 1.0)
- "relatedEntities": string[] (other entity names mentioned in this content)

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
- Extract only NEW information not already obvious
- Maximum 8 updates per exchange
- Be concise, no fluff
- For SINGLE slots, always include ALL known details (will replace previous value)
- Respond ONLY with a valid JSON array, no markdown, no explanation`;

let _extractSystem=DEFAULT_EXTRACT_SYSTEM;
export function setExtractionPrompt(p){_extractSystem=p&&p.trim()?p.trim():DEFAULT_EXTRACT_SYSTEM;}
export function getExtractionPrompt(){return _extractSystem;}

export function buildExtractionPrompt(messages,maxMessages=4){
const recent=messages.slice(-maxMessages);
let prompt='Extract entity information from this conversation excerpt:\n\n';
for(const m of recent){
const role=m.is_user?'User':'Character';
prompt+=`${role} (${m.name}): ${m.mes}\n\n`;
}
return prompt;
}

export async function extractMemories(generateFn,messages,charId,maxMessages=4){
if(messages.length<2){
console.log('[NM] extractMemories: skip, messages.length=',messages.length);
return[];
}
const prompt=buildExtractionPrompt(messages,maxMessages);
console.log('[NM] extraction prompt built, length:',prompt.length,'chars');
let raw;
try{
console.log('[NM] calling generateFn (quietPrompt)...');
raw=await generateFn({quietPrompt:`${_extractSystem}\n\n${prompt}`,skipWIAN:true,removeReasoning:false,responseLength:8192});
console.log('[NM] generateFn returned, raw length:',raw?.length||0);
console.log('[NM] raw response (first 500):',raw?.substring(0,500));
}catch(e){
console.error('[NM] extraction generation FAILED:',e.message||e);
return[];
}
if(!raw||!raw.trim()){
console.warn('[NM] extraction returned empty/null response');
return[];
}
return parseEntityUpdates(raw,charId);
}

// JSON aus einem Text-Block extrahieren
function findJSON(text){
if(!text)return null;
let s=text.trim();
const cbMatch=s.match(/```(?:json)?\s*([\s\S]*?)```/);
if(cbMatch){s=cbMatch[1].trim()}
const arrMatch=s.match(/\[[\s\S]*\]/);
if(arrMatch)return arrMatch[0];
const objMatch=s.match(/\{[\s\S]*\}/);
if(objMatch)return'['+objMatch[0]+']';
return null;
}

export function parseEntityUpdates(raw,charId){
if(!raw)return[];

// Reasoning-Tags entfernen
let searchText=raw;
const thinkMatch=raw.match(/<think>([\s\S]*?)<\/think>/);
const contentAfterThink=thinkMatch?raw.replace(/<think>[\s\S]*?<\/think>/,'').trim():raw;

let json=findJSON(contentAfterThink);
if(!json&&thinkMatch){
console.log('[NM] no JSON in content, searching reasoning block...');
json=findJSON(thinkMatch[1]);
}
if(!json)json=findJSON(raw);
if(!json){
console.error('[NM] could not find JSON in response');
return[];
}

let arr;
try{arr=JSON.parse(json)}catch(e){
console.error('[NM] JSON parse failed:',e.message);
return[];
}
if(!Array.isArray(arr))return[];

const validTypes=Object.keys(ENTITY_SCHEMAS);
const results=[];
for(const item of arr.slice(0,8)){
if(!item.entity||!item.content||typeof item.content!=='string')continue;
const entityType=validTypes.includes(item.entityType)?item.entityType:'concept';
const schema=ENTITY_SCHEMAS[entityType];
let slot=item.slot;
// Slot validieren — fallback auf notes
if(!schema[slot])slot='notes';

results.push({
entity:item.entity.trim(),
entityType,
slot,
content:item.content.slice(0,500),
emotionalValence:typeof item.emotionalValence==='number'?Math.max(-1,Math.min(1,item.emotionalValence)):0,
emotionalIntensity:typeof item.emotionalIntensity==='number'?Math.max(0,Math.min(1,item.emotionalIntensity)):0,
importance:typeof item.importance==='number'?Math.max(0,Math.min(1,item.importance)):0.5,
relatedEntities:Array.isArray(item.relatedEntities)?item.relatedEntities.map(String).slice(0,10):[],
});
}
return results;
}

// Entity-Updates in den Store integrieren (ersetzt altes integrateMemories)
export function integrateEntityUpdates(store,updates,opts={}){
const{sourceMessageIds=[]}=opts;
let added=0,merged=0;

for(const upd of updates){
// 1. Entity finden oder erstellen
let ent=getEntityByName(store,upd.entity);
if(!ent){
ent=createEntityNode(upd.entity,store.characterId,upd.entityType);
addEntity(store,ent);
console.log(`[NM] new entity: ${ent.name} (${upd.entityType})`);
}else{
updateEntityMention(ent);
// Entity-Typ upgraden wenn concept → spezifischer
if(ent.type==='concept'&&upd.entityType!=='concept'){
ent.type=upd.entityType;
// Slots initialisieren fuer neuen Typ
const newSlots=upgradeEntitySlots(upd.entityType,ent.slots);
ent.slots=newSlots;
}
}

// 2. Slot validieren (fuer den aktuellen Entity-Typ)
const slotSchema=getSlotSchema(ent.type,upd.slot);
let slotName=upd.slot;
if(!slotSchema){
slotName='notes';
}

const slot=ent.slots[slotName];
if(!slot)continue;

const keywords=extractKeywords(upd.content);

// 3. Integration
if(slot.mode==='SINGLE'){
// SINGLE: ueberschreiben (natuerliche Dedup!)
// Nur ueberschreiben wenn neuer Content laenger/besser oder Slot leer
if(!slot.value||upd.content.length>=slot.value.length*0.5){
updateSlotValue(store,ent.id,slotName,upd.content,{
keywords,importance:upd.importance,
emotionalValence:upd.emotionalValence,emotionalIntensity:upd.emotionalIntensity,
});
merged++;
console.log(`[NM] ${slot.value?'updated':'set'} ${ent.name}.${slotName}`);
}
}else{
// ARRAY: Dedup-Check gegen bestehende Eintraege
const newTokens=tokenize(upd.content);
let isDuplicate=false;
for(const existing of slot.entries){
const sim=cosineSim(newTokens,tokenize(existing.content));
if(sim>=0.7){
// Aehnlich genug → merge wenn neuer Content laenger
if(upd.content.length>existing.content.length){
existing.content=upd.content.slice(0,500);
existing.keywords=[...new Set([...existing.keywords,...keywords])].slice(0,10);
existing.importance=Math.max(existing.importance,upd.importance);
existing.stability+=0.2;
existing.lastReinforcedAt=now();
existing.updatedAt=now();
console.log(`[NM] merged into ${ent.name}.${slotName}: "${upd.content.substring(0,50)}"`);
}else{
// Bestehender ist besser → nur Stability boost
existing.stability+=0.1;
existing.lastReinforcedAt=now();
}
isDuplicate=true;
merged++;
break;
}
}
if(!isDuplicate){
const entry=createSlotEntry(upd.content,{
keywords,importance:upd.importance,
emotionalValence:upd.emotionalValence,emotionalIntensity:upd.emotionalIntensity,
sourceMessageIds,relatedEntities:upd.relatedEntities,
});
addSlotEntry(store,ent.id,slotName,entry);
added++;
console.log(`[NM] added ${ent.name}.${slotName}: "${upd.content.substring(0,50)}"`);
}
}

// 4. Inter-Entity-Connections aus relatedEntities
for(const relName of upd.relatedEntities){
let relEnt=getEntityByName(store,relName);
if(!relEnt){
relEnt=createEntityNode(relName,store.characterId,'concept');
addEntity(store,relEnt);
}
// Bidirektionale Verbindung
const hasConn=ent.connections.find(c=>c.targetId===relEnt.id);
if(hasConn){hasConn.weight=Math.min(1,hasConn.weight+0.1)}
else ent.connections.push({targetId:relEnt.id,weight:0.5,type:'related'});
const hasRev=relEnt.connections.find(c=>c.targetId===ent.id);
if(hasRev){hasRev.weight=Math.min(1,hasRev.weight+0.1)}
else relEnt.connections.push({targetId:ent.id,weight:0.5,type:'related'});
}
}

console.log(`[NM] integration: ${added} added, ${merged} merged/updated`);
return{added,merged};
}

// Slots fuer neuen Typ initialisieren, bestehende Daten behalten
function upgradeEntitySlots(newType,existingSlots){
const fresh=initSlots(newType);
for(const[name,slot]of Object.entries(existingSlots)){
if(fresh[name]&&fresh[name].mode===slot.mode){
fresh[name]=slot;
}else if(fresh.notes&&slot.mode==='ARRAY'&&slot.entries?.length){
fresh.notes.entries.push(...slot.entries);
}
}
return fresh;
}
