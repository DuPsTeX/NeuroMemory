import{now,hrs,expDecay,cosineSim,tokenize,extractKeywords}from'./utils.js';
import{getAllEntities,removeSlotEntry,updateSlotEntry,getAllSlotEntries,countTotalEntries}from'./store.js';
import{updateEntityConnections}from'./network.js';
import{computeTier,ENTITY_SCHEMAS}from'./entities.js';

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

const BATCH_COMPRESS_SYSTEM=`You are a memory compression system. Given multiple entries from the same slot of an entity, compress them into fewer entries while preserving all important information.

Rules:
- Merge overlapping/similar entries into one
- Preserve timeline order (earlier events first)
- Keep emotional peaks and character-defining moments intact
- Never lose names, relationships, or plot-critical details
- Each output entry: max 2 sentences

Respond ONLY with a JSON array of compressed entries:
[{"content":"...", "importance":0.0-1.0, "emotionalIntensity":0.0-1.0, "emotionalValence":-1.0-1.0, "storyArc":"arc name or null"}]`;

const WISDOM_SYSTEM=`You are a character insight system. Given a character's plot history, extract what they have LEARNED — wisdom, growth, lessons, character development.

Write 1-2 sentences of pure insight. No plot summary — focus on how the character has changed or what they now understand. Write in third person, present tense.

Respond with ONLY the wisdom text, nothing else.`;

// ============================================================
// Tier-Promotion: Entries aufwerten basierend auf Metriken
// ============================================================

export function promoteTiers(store,settings={}){
let promoted=0;
for(const ent of Object.values(store.entities)){
for(const slot of Object.values(ent.slots)){
if(slot.mode==='SINGLE'&&slot.value){
const newTier=computeTier(slot,settings);
if(_tierRank(newTier)<_tierRank(slot.tier||'episodic')){
slot.tier=newTier;
promoted++;
}
}else if(slot.mode==='ARRAY'){
for(const entry of slot.entries){
const newTier=computeTier(entry,settings);
if(_tierRank(newTier)<_tierRank(entry.tier||'episodic')){
entry.tier=newTier;
promoted++;
}
}}
}}
if(promoted)console.log(`[NM] tier promotion: ${promoted} entries promoted`);
return promoted;
}

function _tierRank(tier){return tier==='core'?0:tier==='significant'?1:2}

// ============================================================
// Ebbinghaus-Decay mit Tier-Awareness
// ============================================================

export function applyDecay(store,halfLifeHours=720,emotionFactor=0.5){
const t=now();
let removed=0;

for(const ent of Object.values(store.entities)){
for(const[slotName,slot]of Object.entries(ent.slots)){
if(slot.mode==='SINGLE'&&slot.value){
const tier=slot.tier||'episodic';
if(tier==='core'||slot.pinned){slot.retrievability=1.0;continue}
const hlMult=tier==='significant'?3:1;
const effStab=(slot.stability||1)*(1+(slot.emotionalIntensity||0)*emotionFactor);
slot.retrievability=expDecay(hrs(t-(slot.lastReinforcedAt||slot.updatedAt||t)),effStab,halfLifeHours*hlMult);
if(slot.retrievability<0.05&&!slot.userCreated){
slot.value=null;
slot.keywords=[];
removed++;
}
}else if(slot.mode==='ARRAY'){
const toRemove=[];
for(const entry of slot.entries){
const tier=entry.tier||'episodic';
if(tier==='core'||entry.pinned){entry.retrievability=1.0;continue}
const hlMult=tier==='significant'?3:1;
const effStab=(entry.stability||1)*(1+(entry.emotionalIntensity||0)*emotionFactor);
entry.retrievability=expDecay(hrs(t-(entry.lastReinforcedAt||entry.createdAt||t)),effStab,halfLifeHours*hlMult);
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
// Konsolidierungs-Prioritaet pro Entity berechnen
// ============================================================

function _computeConsolidationPriority(ent){
let totalEntries=0,recentCount=0;
const recentThreshold=now()-48*60*60*1000;// 48h
for(const slot of Object.values(ent.slots)){
if(slot.mode!=='ARRAY')continue;
totalEntries+=slot.entries.length;
recentCount+=slot.entries.filter(e=>(e.createdAt||0)>recentThreshold).length;
}
return totalEntries*0.4+recentCount*0.3+(ent.mentionCount||0)*0.1;
}

// ============================================================
// Batch-Kompression: Slot mit >N Entries in einem LLM-Call komprimieren
// ============================================================

async function batchCompressSlot(generateFn,store,ent,slotName,slot,maxEntries){
if(slot.entries.length<=maxEntries)return 0;
// Core-Tier Entries nicht komprimieren — separat halten
const coreEntries=slot.entries.filter(e=>(e.tier||'episodic')==='core'||e.pinned||e.userCreated);
const compressible=slot.entries.filter(e=>(e.tier||'episodic')!=='core'&&!e.pinned&&!e.userCreated);
if(compressible.length<=maxEntries)return 0;

const targetCount=Math.ceil(compressible.length/2);
const sorted=[...compressible].sort((a,b)=>(a.sequenceIndex||a.createdAt||0)-(b.sequenceIndex||b.createdAt||0));
const entryText=sorted.map((e,i)=>`${i+1}. [imp:${(e.importance||0).toFixed(1)} emo:${(e.emotionalIntensity||0).toFixed(1)}] ${e.content}`).join('\n');

const prompt=`${BATCH_COMPRESS_SYSTEM}\n\nEntity: ${ent.name}\nSlot: ${slotName}\nCompress ${compressible.length} entries into ~${targetCount}:\n\n${entryText}`;

let raw;
try{
raw=await generateFn({quietPrompt:prompt,skipWIAN:true,removeReasoning:true,responseLength:2048});
}catch(e){console.warn('[NM] batch compress failed',e);return 0}

let arr;
try{
const json=raw.trim().match(/\[[\s\S]*\]/);
if(!json)return 0;
arr=JSON.parse(json[0]);
if(!Array.isArray(arr))return 0;
}catch(e){return 0}

// Ersetze komprimierbare Entries durch komprimierte
const oldCount=compressible.length;
// Entferne alte komprimierbare
for(const e of compressible)removeSlotEntry(store,ent.id,slotName,e.id);
// Fuege komprimierte hinzu
const t=now();
let seqBase=Math.max(0,...coreEntries.map(e=>e.sequenceIndex||0))+1;
for(const item of arr.slice(0,targetCount)){
if(!item.content)continue;
slot.entries.push({
id:'s_'+Math.floor(Math.random()*0xFFFFFF).toString(16).padStart(6,'0'),
content:String(item.content).slice(0,500),
keywords:extractKeywords(item.content),
importance:typeof item.importance==='number'?Math.max(0,Math.min(1,item.importance)):0.5,
stability:1.5,// Komprimierte Entries sind stabiler
retrievability:1.0,
emotionalValence:typeof item.emotionalValence==='number'?item.emotionalValence:0,
emotionalIntensity:typeof item.emotionalIntensity==='number'?item.emotionalIntensity:0,
createdAt:t,updatedAt:t,accessCount:0,lastAccessedAt:t,lastReinforcedAt:t,
sourceMessageIds:[],pinned:false,userCreated:false,relatedEntities:[],
tier:'significant',// Komprimierte bleiben laenger
sequenceIndex:seqBase++,
storyArc:item.storyArc||null,
});
}

const newCount=slot.entries.length-coreEntries.length;
console.log(`[NM] batch compressed ${ent.name}.${slotName}: ${oldCount} → ${newCount} entries`);
return oldCount-newCount;
}

// ============================================================
// Wisdom-Extraktion: Episodisches → Semantisches Wissen
// ============================================================

async function extractWisdom(generateFn,store,ent,threshold=10){
if(ent.type!=='person')return false;
const plotSlot=ent.slots.plot;
if(!plotSlot||plotSlot.mode!=='ARRAY'||plotSlot.entries.length<threshold)return false;
const wisdomSlot=ent.slots.wisdom;
if(!wisdomSlot||wisdomSlot.mode!=='SINGLE')return false;
// Nur alle 10 neuen Entries regenerieren
const lastWisdomAt=wisdomSlot.updatedAt||0;
const newPlotEntries=plotSlot.entries.filter(e=>(e.createdAt||0)>lastWisdomAt);
if(newPlotEntries.length<Math.floor(threshold/2))return false;

const sorted=[...plotSlot.entries].sort((a,b)=>(a.sequenceIndex||a.createdAt||0)-(b.sequenceIndex||b.createdAt||0));
const plotText=sorted.slice(-15).map(e=>e.content).join('\n- ');

const prompt=`${WISDOM_SYSTEM}\n\nCharacter: ${ent.name}\nRecent plot events:\n- ${plotText}`;

let raw;
try{
raw=await generateFn({quietPrompt:prompt,skipWIAN:true,removeReasoning:true,responseLength:200});
}catch(e){console.warn('[NM] wisdom extraction failed',e);return false}

if(raw?.trim()){
wisdomSlot.value=raw.trim().slice(0,500);
wisdomSlot.importance=0.9;
wisdomSlot.stability=3.0;
wisdomSlot.tier='core';
wisdomSlot.updatedAt=now();
wisdomSlot.lastReinforcedAt=now();
wisdomSlot.keywords=extractKeywords(raw);
console.log(`[NM] wisdom extracted for ${ent.name}: "${raw.trim().substring(0,60)}"`);
return true;
}
return false;
}

// ============================================================
// LLM-basierte Konsolidierung (paarweise, legacy-kompatibel)
// ============================================================

export async function consolidateWithLLM(generateFn,store,batchSize=10){
let ops=0;
let checked=0;

// Prioritaets-basierte Reihenfolge
const entities=[...Object.values(store.entities)].sort((a,b)=>_computeConsolidationPriority(b)-_computeConsolidationPriority(a));

for(const ent of entities){
if(checked>=batchSize)break;
for(const[slotName,slot]of Object.entries(ent.slots)){
if(slot.mode!=='ARRAY'||slot.entries.length<2)continue;
if(checked>=batchSize)break;

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
const newTier=_tierRank(top.entry.tier||'episodic')<_tierRank(entry.tier||'episodic')?top.entry.tier:entry.tier;
updateSlotEntry(store,ent.id,slotName,top.entry.id,{
content:result.merged.slice(0,500),
importance:Math.max(top.entry.importance||0,entry.importance||0),
stability:Math.max(top.entry.stability||1,entry.stability||1)+0.2,
lastReinforcedAt:now(),
keywords:[...new Set([...(top.entry.keywords||[]),...(entry.keywords||[])])].slice(0,10),
tier:newTier||'episodic',
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
// Volle Konsolidierungsrunde (v3 mit Tiers, Batch, Wisdom)
// ============================================================

export async function runConsolidation(generateFn,store,settings){
const halfLifeHours=(settings.halfLifeDays||30)*24;
const{emotionFactor=0.5,maxEntries=500,consolidationBatch=10,digestEveryN=15}=settings;
const consolidationMode=settings.consolidationMode||'smart';
const maxSlotEntries=settings.maxSlotEntriesBeforeCompress||8;
const wisdomThreshold=settings.wisdomExtractionThreshold||10;

// 0. Tier-Promotion
promoteTiers(store,settings);

// 1. Decay anwenden (Tier-aware)
const forgotten=applyDecay(store,halfLifeHours,emotionFactor);

// 2. Konsolidierung
let merged=0;
if(consolidationMode==='smart'){
// Smart: Batch-Kompression fuer uebervolle Slots
const entities=[...Object.values(store.entities)].sort((a,b)=>_computeConsolidationPriority(b)-_computeConsolidationPriority(a));
for(const ent of entities.slice(0,5)){// Top-5 Entities pro Run
for(const[slotName,slot]of Object.entries(ent.slots)){
if(slot.mode!=='ARRAY')continue;
if(slot.entries.length>maxSlotEntries){
const compressed=await batchCompressSlot(generateFn,store,ent,slotName,slot,maxSlotEntries);
merged+=compressed;
}
}}
// Fallback: paarweise fuer den Rest
merged+=await consolidateWithLLM(generateFn,store,Math.max(3,consolidationBatch-merged));
}else{
// Legacy-Modus
merged=await consolidateWithLLM(generateFn,store,consolidationBatch);
}

// 3. Entity-Verbindungen aktualisieren
updateEntityConnections(store);

// 4. Limit enforcen — Core-Tier Entries geschuetzt
const totalEntries=countTotalEntries(store);
if(totalEntries>maxEntries){
const allEntries=[];
for(const ent of Object.values(store.entities)){
for(const[slotName,slot]of Object.entries(ent.slots)){
if(slot.mode!=='ARRAY')continue;
for(const entry of slot.entries){
if(!entry.pinned&&!entry.userCreated&&(entry.tier||'episodic')!=='core'){
allEntries.push({entityId:ent.id,slotName,entry});
}}}}
allEntries.sort((a,b)=>(a.entry.retrievability||0)-(b.entry.retrievability||0));
const excess=allEntries.slice(0,totalEntries-maxEntries);
for(const{entityId,slotName,entry}of excess){
removeSlotEntry(store,entityId,slotName,entry.id);
}
}

store.meta.lastConsolidation=now();

// 5. Wisdom-Extraktion fuer Person-Entities
if(consolidationMode==='smart'){
for(const ent of Object.values(store.entities)){
await extractWisdom(generateFn,store,ent,wisdomThreshold);
}
}

// 6. Digest auto-generieren
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
