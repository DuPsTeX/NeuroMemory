import{now,hrs,expDecay,cosineSim,tokenize,extractKeywords}from'./utils.js';
import{getAllEntities,removeSlotEntry,updateSlotEntry,getAllSlotEntries,countTotalEntries}from'./store.js';
import{updateEntityConnections}from'./network.js';

const DIGEST_SYSTEM=`You are a character memory narrator. Given entity-organized memories about fictional characters, write a cohesive 2-3 sentence narrative summary. Focus on character essence, key relationships, and emotional state. Write in third person, present tense. Pure prose — no lists, no bullet points. Respond with ONLY the summary text, no additional formatting.`;

export async function generateDigest(generateFn,store){
const ents=getAllEntities(store);
if(ents.length<2)return null;
const lines=[];
for(const ent of ents){
if(ent.name==='_unassigned')continue;
const parts=[`[${ent.type}: ${ent.name}]`];
for(const[name,slot]of Object.entries(ent.slots)){
if(slot.mode==='SINGLE'&&slot.value&&(slot.importance||0)>=0.4){
parts.push(`  ${name}: ${slot.value}`);
}else if(slot.mode==='ARRAY'){
const top=slot.entries.filter(e=>(e.importance||0)>=0.5||(e.emotionalIntensity||0)>=0.7||e.pinned)
.sort((a,b)=>(b.importance||0)-(a.importance||0)).slice(0,3);
for(const e of top)parts.push(`  * ${name}: ${e.content}`);
}}
if(parts.length>1)lines.push(parts.join('\n'));
if(lines.length>=8)break;
}
if(lines.length<2)return null;
const prompt=`${DIGEST_SYSTEM}\n\nEntities:\n${lines.join('\n\n')}\n\nNarrative Summary:`;
try{
const raw=await generateFn({quietPrompt:prompt,skipWIAN:true,removeReasoning:true,responseLength:200});
return raw?.trim()||null;
}catch(e){console.warn('[NM] digest generation failed',e);return null}
}

const CONSOLIDATE_SYSTEM=`You are a memory consolidation system. Given two entries from the same slot, decide:
- "UPDATE": entries overlap or complement each other → merge into one
- "DELETE": new entry contradicts old → old should be removed
- "NOOP": entries are unrelated or duplicates → do nothing

Respond ONLY with JSON: {"operation":"UPDATE"|"DELETE"|"NOOP","merged":"merged content if UPDATE, empty string otherwise"}`;

// ============================================================
// Ebbinghaus-Decay auf alle Slot-Eintraege anwenden
// ============================================================

export function applyDecay(store,halfLifeHours=720,emotionFactor=0.5){
const t=now();
let removed=0;

for(const ent of Object.values(store.entities)){
for(const[slotName,slot]of Object.entries(ent.slots)){
if(slot.mode==='SINGLE'&&slot.value){
if(slot.pinned)continue;
const effStab=(slot.stability||1)*(1+(slot.emotionalIntensity||0)*emotionFactor);
slot.retrievability=expDecay(hrs(t-(slot.lastReinforcedAt||slot.updatedAt||t)),effStab,halfLifeHours);
if(slot.retrievability<0.05&&!slot.userCreated){
slot.value=null;
slot.keywords=[];
removed++;
}
}else if(slot.mode==='ARRAY'){
const toRemove=[];
for(const entry of slot.entries){
if(entry.pinned)continue;
const effStab=(entry.stability||1)*(1+(entry.emotionalIntensity||0)*emotionFactor);
entry.retrievability=expDecay(hrs(t-(entry.lastReinforcedAt||entry.createdAt||t)),effStab,halfLifeHours);
if(entry.retrievability<0.05&&!entry.userCreated){
toRemove.push(entry.id);
}}
for(const id of toRemove){
removeSlotEntry(store,ent.id,slotName,id);
removed++;
}
}}}
return removed;
}

// ============================================================
// Aehnliche Eintraege innerhalb eines ARRAY-Slots finden
// ============================================================

function findSimilarInSlot(entries,entry,threshold=0.4){
const eTokens=tokenize(entry.content);
const results=[];
for(const other of entries){
if(other.id===entry.id)continue;
const sim=cosineSim(eTokens,tokenize(other.content));
if(sim>=threshold)results.push({entry:other,similarity:sim});
}
return results.sort((a,b)=>b.similarity-a.similarity);
}

// ============================================================
// LLM-basierte Konsolidierung pro ARRAY-Slot pro Entity
// ============================================================

export async function consolidateWithLLM(generateFn,store,batchSize=10){
let ops=0;
let checked=0;

for(const ent of Object.values(store.entities)){
if(checked>=batchSize)break;
for(const[slotName,slot]of Object.entries(ent.slots)){
if(slot.mode!=='ARRAY'||slot.entries.length<2)continue;
if(checked>=batchSize)break;

// Neueste Eintraege zuerst pruefen
const sorted=[...slot.entries].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
for(const entry of sorted.slice(0,3)){
if(checked>=batchSize)break;
const similar=findSimilarInSlot(slot.entries,entry,0.4);
if(!similar.length)continue;

const top=similar[0];
checked++;
const prompt=`${CONSOLIDATE_SYSTEM}\n\nSlot: ${slotName} (Entity: ${ent.name})\nExisting entry: "${top.entry.content}"\nNew entry: "${entry.content}"\n\nDecide:`;

let raw;
try{
raw=await generateFn({quietPrompt:prompt,skipWIAN:true,removeReasoning:true,responseLength:150});
}catch(e){console.warn('[NM] consolidation gen failed',e);continue}

let result;
try{
const json=raw.trim().match(/\{[\s\S]*\}/);
if(json)result=JSON.parse(json[0]);
else continue;
}catch(e){continue}

if(result.operation==='UPDATE'&&result.merged){
updateSlotEntry(store,ent.id,slotName,top.entry.id,{
content:result.merged.slice(0,500),
importance:Math.max(top.entry.importance||0,entry.importance||0),
stability:Math.max(top.entry.stability||1,entry.stability||1)+0.2,
lastReinforcedAt:now(),
keywords:[...new Set([...(top.entry.keywords||[]),...(entry.keywords||[])])].slice(0,10),
});
removeSlotEntry(store,ent.id,slotName,entry.id);
ops++;
console.log(`[NM] consolidated ${ent.name}.${slotName}: "${result.merged.substring(0,50)}"`);
}else if(result.operation==='DELETE'){
removeSlotEntry(store,ent.id,slotName,entry.id);
ops++;
}
}}}
return ops;
}

// ============================================================
// Volle Konsolidierungsrunde
// ============================================================

export async function runConsolidation(generateFn,store,settings){
const{halfLifeHours=720,emotionFactor=0.5,maxEntries=500,consolidationBatch=10,digestEveryN=15}=settings;

// 1. Decay anwenden
const forgotten=applyDecay(store,halfLifeHours,emotionFactor);

// 2. LLM-Konsolidierung
const merged=await consolidateWithLLM(generateFn,store,consolidationBatch);

// 3. Entity-Verbindungen aktualisieren
updateEntityConnections(store);

// 4. Limit enforcen: zu viele Eintraege → aelteste/schwachste loeschen
const totalEntries=countTotalEntries(store);
if(totalEntries>maxEntries){
// Alle ARRAY-Eintraege sammeln, nach Retrievability sortieren, ueberschuessige loeschen
const allEntries=[];
for(const ent of Object.values(store.entities)){
for(const[slotName,slot]of Object.entries(ent.slots)){
if(slot.mode!=='ARRAY')continue;
for(const entry of slot.entries){
if(!entry.pinned&&!entry.userCreated){
allEntries.push({entityId:ent.id,slotName,entry});
}}}}
allEntries.sort((a,b)=>(a.entry.retrievability||0)-(b.entry.retrievability||0));
const excess=allEntries.slice(0,totalEntries-maxEntries);
for(const{entityId,slotName,entry}of excess){
removeSlotEntry(store,entityId,slotName,entry.id);
}
}

store.meta.lastConsolidation=now();

// 5. Digest auto-generieren
const entryCount=countTotalEntries(store);
const lastCount=store.digest?.entryCount||0;
if(!store.digest||(entryCount-lastCount)>=digestEveryN){
const digestText=await generateDigest(generateFn,store);
if(digestText)store.digest={text:digestText,generatedAt:now(),entryCount};
}

const total=countTotalEntries(store);
console.log(`[NM] consolidation: ${forgotten} forgotten, ${merged} merged, ${total} total entries`);
return{forgotten,merged,total};
}
