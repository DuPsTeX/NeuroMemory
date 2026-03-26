import{BM25,tokenize,extractKeywords,now,hrs,expDecay,clamp,estimateTokens}from'./utils.js';
import{spreadingActivation}from'./network.js';
import{extractEntitiesFromText,ENTITY_SCHEMAS,ENTITY_TYPE_ICONS,ALWAYS_SLOTS,TIER_LABELS}from'./entities.js';
import{getAllEntities,getAllSlotEntries,getEntity}from'./store.js';
import{getTemporalContext}from'./timeline.js';

// ============================================================
// Multi-Signal Retrieval — Entity-zentrisch (v2)
// ============================================================

export function retrieveEntities(store,message,opts={}){
const{
topK=15,maxHops=3,decayPerHop=0.5,activationThreshold=0.15,
halfLifeHours=720,emotionFactor=0.5,
weights={activation:0.30,importance:0.20,retrievability:0.15,emotion:0.25,recency:0.10}
}=opts;

const entities=getAllEntities(store);
if(!entities.length)return[];

const allEntries=getAllSlotEntries(store);
if(!allEntries.length)return[];

const queryTokens=tokenize(message);
const queryKeywords=extractKeywords(message);
const queryEntityNames=extractEntitiesFromText(message,entities);

// Phase 1a: BM25 auf Keywords (gespeicherte Extraktions-Keywords)
const bm25k=new BM25;
for(const e of allEntries)bm25k.add(e.entityId+'|'+e.slotName+'|'+(e.entryId||'S'),e.keywords||[]);
const bm25KwResults=bm25k.search(queryKeywords,Math.min(allEntries.length,50));

// Phase 1b: BM25 auf Content-Text (Fallback DE/EN Mismatch)
const bm25c=new BM25;
for(const e of allEntries)bm25c.add(e.entityId+'|'+e.slotName+'|'+(e.entryId||'S'),tokenize(e.content||''));
const bm25ContentResults=bm25c.search(queryTokens,Math.min(allEntries.length,50));

// BM25-Scores auf Entity-Ebene UND Slot-Ebene aggregieren
const entityBm25=new Map;
const slotBm25=new Map; // entityId -> Map<slotKey, score>
function addBm25(id,score){
const parts=id.split('|');
const entId=parts[0],slotName=parts[1],entryId=parts[2];
entityBm25.set(entId,(entityBm25.get(entId)||0)+score);
if(!slotBm25.has(entId))slotBm25.set(entId,new Map);
const sm=slotBm25.get(entId);
const key=entryId==='S'?slotName:slotName+'|'+entryId;
sm.set(key,(sm.get(key)||0)+score);
}
for(const r of bm25KwResults)addBm25(r.id,r.score);
for(const r of bm25ContentResults)addBm25(r.id,r.score*0.6);

const maxBM25=entityBm25.size?Math.max(...entityBm25.values()):1;

// Phase 2: Entity-Match (Name/Alias im Message)
const matchedEntityIds=new Set;
const msgLower=message.toLowerCase();
for(const ent of entities){
if(msgLower.includes(ent.name.toLowerCase())){matchedEntityIds.add(ent.id);continue}
if(ent.aliases.some(a=>msgLower.includes(a.toLowerCase())))matchedEntityIds.add(ent.id);
}
for(const qe of queryEntityNames){
const ql=qe.toLowerCase();
for(const ent of entities){
if(ent.name.toLowerCase()===ql||ent.aliases.some(a=>a.toLowerCase()===ql))matchedEntityIds.add(ent.id);
}}

// Phase 3: Initiale Aktivierungen auf Entity-Ebene
const initialAct=new Map;
for(const[id,score]of entityBm25){
initialAct.set(id,clamp(score/(maxBM25||1)));
}
for(const id of matchedEntityIds){
const cur=initialAct.get(id)||0;
initialAct.set(id,clamp(Math.max(cur,0.7)));
}

// Fallback: kein Signal → Top-Entities nach Wichtigkeit
if(!initialAct.size){
const t0=now();
const entScores=entities.map(ent=>{
const slots=Object.values(ent.slots);
let maxImp=0,maxRet=0;
for(const s of slots){
if(s.mode==='SINGLE'&&s.value){
maxImp=Math.max(maxImp,s.importance||0);
const effStab=(s.stability||1)*(1+(s.emotionalIntensity||0)*emotionFactor);
maxRet=Math.max(maxRet,expDecay(hrs(t0-(s.lastReinforcedAt||s.updatedAt||t0)),effStab,halfLifeHours));
}else if(s.mode==='ARRAY'){
for(const e of s.entries){
maxImp=Math.max(maxImp,e.importance||0);
const effStab=(e.stability||1)*(1+(e.emotionalIntensity||0)*emotionFactor);
maxRet=Math.max(maxRet,expDecay(hrs(t0-(e.lastReinforcedAt||e.createdAt||t0)),effStab,halfLifeHours));
}}}
return{entity:ent,score:maxImp*0.5+maxRet*0.3+(ent.mentionCount>3?0.2:0.1)};
}).sort((a,b)=>b.score-a.score).slice(0,topK);
console.log('[NM] retrieval: no query signal, fallback top-'+entScores.length);
return entScores.map(es=>({entity:es.entity,score:es.score,activation:0.1,slotScores:new Map}));
}

// Phase 4: Spreading Activation ueber Entity-Connections
const activations=spreadingActivation(store,initialAct,{maxHops,decayPerHop,threshold:activationThreshold});

// Phase 5: Multi-Signal Scoring pro Entity
const t=now();
const scored=[];
for(const ent of entities){
const act=activations.get(ent.id)||0;
if(act<activationThreshold*0.5&&!entityBm25.has(ent.id))continue;

// Aggregiere Slot-Metriken
let maxImp=0,maxEmoInt=0,maxRet=0,bestRecency=Infinity;
for(const slot of Object.values(ent.slots)){
if(slot.mode==='SINGLE'&&slot.value){
maxImp=Math.max(maxImp,slot.importance||0);
maxEmoInt=Math.max(maxEmoInt,slot.emotionalIntensity||0);
const effStab=(slot.stability||1)*(1+(slot.emotionalIntensity||0)*emotionFactor);
maxRet=Math.max(maxRet,expDecay(hrs(t-(slot.lastReinforcedAt||slot.updatedAt||t)),effStab,halfLifeHours));
bestRecency=Math.min(bestRecency,t-(slot.lastAccessedAt||slot.updatedAt||t));
}else if(slot.mode==='ARRAY'){
for(const e of slot.entries){
maxImp=Math.max(maxImp,e.importance||0);
maxEmoInt=Math.max(maxEmoInt,e.emotionalIntensity||0);
const effStab=(e.stability||1)*(1+(e.emotionalIntensity||0)*emotionFactor);
maxRet=Math.max(maxRet,expDecay(hrs(t-(e.lastReinforcedAt||e.createdAt||t)),effStab,halfLifeHours));
bestRecency=Math.min(bestRecency,t-(e.lastAccessedAt||e.createdAt||t));
}}}

const recencyBoost=clamp(1/(1+hrs(bestRecency)/168));

const score=
(act||0)*weights.activation+
maxImp*weights.importance+
maxRet*weights.retrievability+
maxEmoInt*weights.emotion+
recencyBoost*weights.recency;

scored.push({entity:ent,score,activation:act,retrievability:maxRet,slotScores:slotBm25.get(ent.id)||new Map});
}

scored.sort((a,b)=>b.score-a.score);
// Score-Cutoff: Entities unter Minimum nicht injizieren
// topK wird NICHT hier angewendet — alle Kandidaten werden an den LLM-Filter weitergegeben
// Die finale Begrenzung auf topK passiert erst bei der Injection in formatEntityContext()
const MIN_INJECT_SCORE=0.3;
const result=scored.filter(r=>r.score>=MIN_INJECT_SCORE);

// Assoziatives Erinnern: Kontext-bewusste Erinnerungen statt Zufall
const resultIds=new Set(result.map(r=>r.entity.id));
const associativeRecalls=[];
for(const r of result){
if((r.activation||0)<0.5)continue;// Nur stark aktivierte Entities
for(const[slotName,slot]of Object.entries(r.entity.slots)){
if(slot.mode!=='ARRAY')continue;
for(const entry of slot.entries){
if((entry.emotionalIntensity||0)<0.4)continue;
for(const relName of(entry.relatedEntities||[])){
const relEnt=entities.find(e=>e.name.toLowerCase()===relName.toLowerCase()||
e.aliases.some(a=>a.toLowerCase()===relName.toLowerCase()));
if(!relEnt||resultIds.has(relEnt.id))continue;
associativeRecalls.push({
entity:relEnt,
trigger:r.entity.name,
triggerContent:entry.content,
emotionalIntensity:entry.emotionalIntensity,
});
resultIds.add(relEnt.id);
}
}
}
}
// Max 2 assoziative Recalls
for(const ar of associativeRecalls.sort((a,b)=>(b.emotionalIntensity||0)-(a.emotionalIntensity||0)).slice(0,2)){
result.push({
entity:ar.entity,score:0.05,activation:0.05,retrievability:0.5,
isAssociativeRecall:true,recallTrigger:ar.trigger,recallContent:ar.triggerContent,
slotScores:new Map,
});
console.log(`[NM] Associative Recall: ${ar.trigger} → ${ar.entity.name} ("${ar.triggerContent.substring(0,50)}")`);
}

return result;
}

// ============================================================
// LLM-basierter Relevanz-Filter
// ============================================================

const RELEVANCE_FILTER_SYSTEM=`You are a story-context analyst for a roleplay memory system.
Given the recent conversation history and a list of memory entities with their slots:
Rate EVERY entity and decide which slots are relevant for the AI to write a good continuation.

Return ONLY a JSON array with ALL entities rated:
[{"entity":"Name","relevance":"high"|"medium"|"low","slots":["profile","story",...]}]

Rules:
- You MUST rate ALL entities in the list — never omit any
- "high": Central to the current scene — actively present, speaking, or directly involved (full details needed)
- "medium": Useful background context — mentioned, related, or setting context (abbreviated)
- "low": Barely relevant — exists in the world but not part of the current moment (one-liner only)
- For each entity, list ONLY the slot names that matter right now
- Always include "profile" or "description" for high/medium entities
- For "low" entities, include at least ["profile"]
- Be selective with slots: a combat scene does not need romance slots, a shopping scene does not need combat stats
- Use the full conversation history to understand WHAT is happening, WHO is present, and WHAT topics are active
- Maximum response: the JSON array, nothing else`;

function _buildFilterPrompt(results,message,recentChat,snippetTokens){
const snippetChars=(snippetTokens||150)*4;
let prompt='';
if(recentChat){
prompt+=`Recent conversation:\n${recentChat}\n\n`;
}
prompt+=`Current message:\n"${message.slice(0,snippetChars)}"\n\nEntities:\n`;
for(const r of results){
const ent=r.entity;
const schema=ENTITY_SCHEMAS[ent.type]||{};
// Kompaktes Format: Name + Typ + max 2 wichtigste Slots (kurz!)
const slotInfo=[];
// Identitaets-Slot zuerst (profile/description)
const identitySlots=['profile','description'];
for(const sn of identitySlots){
const slot=ent.slots[sn];
if(slot?.mode==='SINGLE'&&slot.value){
slotInfo.push(`${sn}: "${slot.value.substring(0,80)}"`);
break;
}
}
// Ein weiterer relevanter Slot
for(const[slotName,slotDef]of Object.entries(schema)){
if(identitySlots.includes(slotName))continue;
if(slotInfo.length>=2)break;
const slot=ent.slots[slotName];
if(!slot)continue;
if(slot.mode==='SINGLE'&&slot.value){
slotInfo.push(`${slotName}: "${slot.value.substring(0,60)}"`);
}else if(slot.mode==='ARRAY'&&slot.entries.length){
slotInfo.push(`${slotName}(${slot.entries.length})`);
}
}
const slotNames=Object.entries(schema).filter(([n,d])=>{
const s=ent.slots[n];
if(!s)return false;
return(s.mode==='SINGLE'&&s.value)||(s.mode==='ARRAY'&&s.entries.length);
}).map(([n])=>n);
prompt+=`- ${ent.name} (${ent.type}) [${slotNames.join(',')}]: ${slotInfo.join(' | ')}\n`;
}
return prompt;
}

function _parseFilterResponse(raw,results){
if(!raw)return null;
let s=raw.trim();
const cbMatch=s.match(/```(?:json)?\s*([\s\S]*?)```/);
if(cbMatch)s=cbMatch[1].trim();
// Reasoning-Tags entfernen
s=s.replace(/<think>[\s\S]*?<\/think>/g,'').trim();
const arrMatch=s.match(/\[[\s\S]*\]/);
if(!arrMatch)return null;
try{
const arr=JSON.parse(arrMatch[0]);
if(!Array.isArray(arr))return null;
// In Map umwandeln: entityName → {relevance, slots}
const map=new Map;
for(const item of arr){
if(!item.entity)continue;
const rel=['high','medium','low'].includes(item.relevance)?item.relevance:'medium';
const slots=Array.isArray(item.slots)?item.slots:[];
map.set(item.entity.toLowerCase(),{relevance:rel,slots:new Set(slots)});
}
return map;
}catch(e){
console.error('[NM] relevance filter parse error:',e.message);
return null;
}
}

export async function filterByRelevance(generateFn,results,message,recentChat,snippetTokens){
if(!generateFn||results.length<2)return null;
const prompt=_buildFilterPrompt(results,message,recentChat,snippetTokens);
console.log('[NM] relevance filter: sending',results.length,'entities for analysis, history:',recentChat?'yes':'no');
try{
const raw=await generateFn({
quietPrompt:`${RELEVANCE_FILTER_SYSTEM}\n\n${prompt}`,
skipWIAN:true,removeReasoning:false,responseLength:2048
});
const map=_parseFilterResponse(raw,results);
if(map){
console.log('[NM] relevance filter: got',map.size,'relevant entities');
}else{
console.warn('[NM] relevance filter: could not parse response, using BM25 fallback');
}
return map;
}catch(e){
console.error('[NM] relevance filter error:',e.message);
return null;
}
}

// ============================================================
// Emotionaler Zustand aus Entity-Emotion-Slots
// ============================================================

function computeEmotionalState(store){
if(!store)return null;
const allEntries=[];
for(const ent of Object.values(store.entities)){
const emotSlot=ent.slots.emotions;
if(!emotSlot||emotSlot.mode!=='ARRAY')continue;
for(const e of emotSlot.entries){
if((e.emotionalIntensity||0)>0.2)allEntries.push(e);
}}
if(allEntries.length<2)return null;
allEntries.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
const top=allEntries.slice(0,10);
const avg=top.reduce((s,e)=>s+(e.emotionalValence||0),0)/top.length;
const half=Math.floor(top.length/2);
const recentAvg=top.slice(0,half).reduce((s,e)=>s+(e.emotionalValence||0),0)/half;
const olderAvg=top.slice(half).reduce((s,e)=>s+(e.emotionalValence||0),0)/(top.length-half);
const trend=recentAvg-olderAvg;
const state=avg>0.5?'joyful':avg>0.2?'content':avg>-0.2?(top.some(e=>(e.emotionalIntensity||0)>0.6)?'conflicted':'calm'):avg>-0.5?'troubled':'grieving';
const trendStr=trend>0.15?', trending hopeful':trend<-0.15?', darkening':'';
return`Emotional State: ${state}${trendStr}`;
}

// Emotion-Label fuer einzelne Eintraege
function emotionLabel(entry){
if(!entry.emotionalIntensity||entry.emotionalIntensity<0.3)return'';
const valStr=entry.emotionalValence>0.3?'positive':entry.emotionalValence<-0.3?'negative':'mixed';
const intStr=entry.emotionalIntensity>=0.75?'★★★ highly':entry.emotionalIntensity>=0.5?'★★':' ★ slightly';
return` | ${intStr} ${valStr}`;
}

// Bester Slot-Inhalt als Einzeiler (fuer kompakte Darstellung)
function _bestSlotSummary(ent){
// Bevorzugt profile/description (Identitaets-Kern)
const identitySlots=['profile','description'];
for(const sn of identitySlots){
const slot=ent.slots[sn];
if(slot?.mode==='SINGLE'&&slot.value)return slot.value.substring(0,200);
}
// Fallback: bester Slot nach Score
let best=null,bestScore=0;
for(const[name,slot]of Object.entries(ent.slots)){
if(slot.mode==='SINGLE'&&slot.value){
const s=(slot.importance||0.5)+(slot.value.length>20?0.2:0);
if(s>bestScore){bestScore=s;best=slot.value}
}else if(slot.mode==='ARRAY'){
for(const e of slot.entries){
const s=(e.importance||0.5)+(e.emotionalIntensity||0)*0.3;
if(s>bestScore){bestScore=s;best=e.content}
}}
}
return best?best.substring(0,200):null;
}

// ============================================================
// Entity-Dedup: Duplikate erkennen und zusammenfuehren
// ============================================================

function _extractNameParts(name){
// "Brunhilda (Bruni)" → ["brunhilda","bruni"]
// "Bademeisterin Ylva" → ["bademeisterin","ylva"]
const parts=[];
const paren=name.match(/\(([^)]+)\)/);
if(paren)parts.push(paren[1].toLowerCase().trim());
const base=name.replace(/\([^)]+\)/,'').trim();
parts.push(base.toLowerCase());
// Auch einzelne Woerter > 3 Zeichen (fuer "Bademeisterin Ylva" → "ylva")
for(const w of base.split(/\s+/)){
if(w.length>3)parts.push(w.toLowerCase());
}
return[...new Set(parts)];
}

function _areEntityDuplicates(a,b){
const partsA=_extractNameParts(a.name);
const partsB=_extractNameParts(b.name);
// Pruefe ob irgendein Name-Teil von A in B vorkommt oder umgekehrt
for(const pa of partsA){
if(pa.length<3)continue;
for(const pb of partsB){
if(pb.length<3)continue;
if(pa===pb)return true;
if(pa.length>4&&pb.includes(pa))return true;
if(pb.length>4&&pa.includes(pb))return true;
}}
// Auch Aliases pruefen
const allNamesA=[a.name.toLowerCase(),...(a.aliases||[]).map(x=>x.toLowerCase())];
const allNamesB=[b.name.toLowerCase(),...(b.aliases||[]).map(x=>x.toLowerCase())];
for(const na of allNamesA){
for(const nb of allNamesB){
if(na===nb)return true;
}}
return false;
}

function _deduplicateResults(results){
if(results.length<2)return results;
// Gruppiere Duplikate: erste gefundene Entity wird "Primary"
const groups=[];// Array von {primary, dupes:[]}
const used=new Set;
for(let i=0;i<results.length;i++){
if(used.has(i))continue;
const group={primary:results[i],dupes:[]};
for(let j=i+1;j<results.length;j++){
if(used.has(j))continue;
if(_areEntityDuplicates(results[i].entity,results[j].entity)){
group.dupes.push(results[j]);
used.add(j);
}}
groups.push(group);
used.add(i);
}
// Merge: Primary bekommt den hoechsten Score, Slots werden zusammengefuehrt
const merged=[];
for(const g of groups){
const best=g.primary;
if(!g.dupes.length){merged.push(best);continue}
// Hoechsten Score nehmen
for(const d of g.dupes){
if(d.score>best.score){best.score=d.score;best.activation=d.activation}
// Slots von Dupe in Primary mergen
for(const[slotName,slot]of Object.entries(d.entity.slots)){
const targetSlot=best.entity.slots[slotName];
if(!targetSlot)continue;
if(slot.mode==='SINGLE'&&slot.value){
if(!targetSlot.value||slot.value.length>targetSlot.value.length){
targetSlot.value=slot.value;
targetSlot.keywords=slot.keywords||targetSlot.keywords;
targetSlot.importance=Math.max(targetSlot.importance||0,slot.importance||0);
targetSlot.emotionalIntensity=Math.max(targetSlot.emotionalIntensity||0,slot.emotionalIntensity||0);
targetSlot.emotionalValence=slot.emotionalValence||targetSlot.emotionalValence;
}}
if(slot.mode==='ARRAY'&&slot.entries?.length){
// Entries anhaengen die noch nicht da sind (Content-Dedup)
for(const entry of slot.entries){
const isDup=targetSlot.entries?.some(e=>e.content===entry.content);
if(!isDup)targetSlot.entries.push(entry);
}}}
// SlotScores mergen
if(d.slotScores){
const bestSS=best.slotScores||new Map;
for(const[k,v]of d.slotScores){
bestSS.set(k,Math.max(bestSS.get(k)||0,v));
}
best.slotScores=bestSS;
}
// Dupe-Namen als Info merken
const dupeNames=g.dupes.map(d=>d.entity.name).join(', ');
best._dupeNames=dupeNames;
}
merged.push(best);
}
if(groups.some(g=>g.dupes.length)){
console.log(`[NM] dedup: ${results.length} → ${merged.length} entities`);
}
return merged;
}

// ============================================================
// Formatiere Entity-Kontext fuer Prompt-Injektion
// ============================================================

// Helper: Relevanz-Stufe aus Map holen (prueft Name + Aliases)
function _getRelevance(r,relevanceMap){
if(!relevanceMap)return'high';
const key=r.entity.name.toLowerCase();
if(relevanceMap.has(key))return relevanceMap.get(key).relevance;
for(const a of(r.entity.aliases||[])){
if(relevanceMap.has(a.toLowerCase()))return relevanceMap.get(a.toLowerCase()).relevance;
}
return'low';
}

// Helper: Erlaubte Slots aus Map holen
function _getAllowedSlots(r,relevanceMap){
if(!relevanceMap)return null;
const key=r.entity.name.toLowerCase();
if(relevanceMap.has(key))return relevanceMap.get(key).slots;
for(const a of(r.entity.aliases||[])){
if(relevanceMap.has(a.toLowerCase()))return relevanceMap.get(a.toLowerCase()).slots;
}
return new Set;
}

export function formatEntityContext(results,maxTokens=1500,store=null,relevanceMap=null,topK=15){
if(!results.length)return'';

// Dedup vor Formatierung
const dedupResults=_deduplicateResults(results);
const associativeRecalls=dedupResults.filter(r=>r.isAssociativeRecall);
let mainResults=dedupResults.filter(r=>!r.isAssociativeRecall);

// Log LLM-Filter Status
if(relevanceMap&&relevanceMap.size>0){
const counts={high:0,medium:0,low:0};
for(const r of mainResults){
const rel=_getRelevance(r,relevanceMap);
counts[rel]=(counts[rel]||0)+1;
}
console.log(`[NM] LLM filter: ${mainResults.length} entities — ${counts.high} high, ${counts.medium} medium, ${counts.low} low`);
}

let out='';
let approxTokens=0;
const add=(text)=>{
const t=estimateTokens(text);
if(approxTokens+t>maxTokens)return false;
out+=text;approxTokens+=t;return true;
};

// Block 1: Digest (Character Essence)
if(store?.digest?.text){
if(!add(`[Character Essence]\n${store.digest.text}\n\n`))return out;
}

// Block 2: Entities sortiert nach LLM-Relevanz (high→medium→low), dann Typ, dann Score
const typeOrder=['person','location','item','faction','concept'];
const relOrder={high:0,medium:1,low:2};
const sorted=[...mainResults].sort((a,b)=>{
if(relevanceMap){
const ra=_getRelevance(a,relevanceMap);
const rb=_getRelevance(b,relevanceMap);
if(ra!==rb)return(relOrder[ra]||2)-(relOrder[rb]||2);
}
const ai=typeOrder.indexOf(a.entity.type);
const bi=typeOrder.indexOf(b.entity.type);
if(ai!==bi)return ai-bi;
return b.score-a.score;
});

// TopK-Limit: nur die besten N Entities injizieren
const limited=sorted.slice(0,topK);
console.log(`[NM] formatEntityContext: ${sorted.length} candidates → ${limited.length} injected (topK=${topK})`);

for(const r of limited){
const ent=r.entity;
const typeLabel=ent.type.charAt(0).toUpperCase()+ent.type.slice(1);
const rel=relevanceMap?_getRelevance(r,relevanceMap):'high';
const allowedSlots=relevanceMap?_getAllowedSlots(r,relevanceMap):null;

if(rel==='high'){
// === HIGH: Alle erlaubten Slots, voller Content ===
if(!add(`[${typeLabel}: ${ent.name}]\n`))break;
const schema=ENTITY_SCHEMAS[ent.type]||{};
// SINGLE Slots
for(const[slotName,slotDef]of Object.entries(schema)){
const slot=ent.slots[slotName];
if(!slot||slot.mode!=='SINGLE'||!slot.value)continue;
if(allowedSlots&&!allowedSlots.has(slotName)&&!slot.pinned)continue;
if(!add(`${slotDef.label||slotName}: ${slot.value}\n`))break;
}
// ARRAY Slots
for(const[slotName,slotDef]of Object.entries(schema)){
const slot=ent.slots[slotName];
if(!slot||slot.mode!=='ARRAY'||!slot.entries.length)continue;
if(allowedSlots&&!allowedSlots.has(slotName)){
if(!slot.entries.some(e=>e.pinned))continue;
}
const entries=[...slot.entries]
.sort((a,b)=>{
if(a.pinned!==b.pinned)return b.pinned?1:-1;
return(b.importance||0)-(a.importance||0)||(b.createdAt||0)-(a.createdAt||0);
})
.slice(0,3);
for(const entry of entries){
const emo=emotionLabel(entry);
if(!add(`* ${slotDef.label||slotName}: ${entry.content}${emo}\n`))break;
}
}
add('\n');
}else if(rel==='medium'){
// === MEDIUM: Nur erlaubte Slots, Content gekuerzt ===
if(!add(`[${typeLabel}: ${ent.name}]\n`))break;
const schema=ENTITY_SCHEMAS[ent.type]||{};
for(const[slotName,slotDef]of Object.entries(schema)){
const slot=ent.slots[slotName];
if(!slot)continue;
if(allowedSlots&&!allowedSlots.has(slotName)&&!(slot.pinned||(slot.entries||[]).some(e=>e.pinned)))continue;
if(slot.mode==='SINGLE'&&slot.value){
if(!add(`${slotDef.label||slotName}: ${slot.value.substring(0,150)}\n`))break;
}else if(slot.mode==='ARRAY'&&slot.entries.length){
const top=slot.entries.sort((a,b)=>(b.importance||0)-(a.importance||0))[0];
if(!add(`* ${slotDef.label||slotName}: ${top.content.substring(0,150)}${emotionLabel(top)}\n`))break;
}
}
add('\n');
}else{
// === LOW: Nur Name + Einzeiler ===
const best=_bestSlotSummary(ent);
if(best){
if(!add(`[${typeLabel}: ${ent.name}] ${best}\n`))break;
}else{
if(!add(`[${typeLabel}: ${ent.name}]\n`))break;
}
}
}

// Block 3: Emotionaler Zustand
const emotState=computeEmotionalState(store);
if(emotState){
add(`[${emotState}]\n`);
}

// Block 4: Associative Recall (kontext-bewusst statt zufaellig)
for(const ar of associativeRecalls){
const content=ar.recallContent||'';
if(content){
add(`[Associative Recall: Being near ${ar.recallTrigger} reminds of — "${content}"]\n`);
}
}

return out;
}

// ============================================================
// Reinforcement: Entity-Slots wurden abgerufen
// ============================================================

export function reinforceEntities(results){
const t=now();
for(const r of results){
const ent=r.entity;
ent.lastSeen=t;
ent.mentionCount=(ent.mentionCount||0)+1;
// Alle Slots der Entity reinforcen
for(const slot of Object.values(ent.slots)){
if(slot.mode==='SINGLE'&&slot.value){
slot.accessCount=(slot.accessCount||0)+1;
slot.lastAccessedAt=t;
slot.lastReinforcedAt=t;
slot.stability=(slot.stability||1)*1.3+0.05;
slot.retrievability=1.0;
}else if(slot.mode==='ARRAY'){
for(const e of slot.entries){
e.accessCount=(e.accessCount||0)+1;
e.lastAccessedAt=t;
e.lastReinforcedAt=t;
e.stability=(e.stability||1)*1.3+0.05;
e.retrievability=1.0;
}}}
}
}

// Selective Reinforcement: Nur Slots boosten die die KI benutzt hat
export function selectiveReinforce(results,responseText){
if(!responseText||!results.length)return;
const t=now();
const respLower=responseText.toLowerCase();
const respTokens=new Set(tokenize(responseText));

for(const r of results){
const ent=r.entity;
const nameUsed=respLower.includes(ent.name.toLowerCase())||
ent.aliases.some(a=>respLower.includes(a.toLowerCase()));

for(const slot of Object.values(ent.slots)){
if(slot.mode==='SINGLE'&&slot.value){
const kw=(slot.keywords||[]).filter(k=>respTokens.has(k)).length;
const contentOverlap=tokenize(slot.value).filter(w=>respTokens.has(w)).length;
if(nameUsed||kw>=2||contentOverlap>=3){
slot.stability=(slot.stability||1)*1.2+0.05;
}else{
slot.stability=Math.max(0.5,(slot.stability||1)*0.95);
}
}else if(slot.mode==='ARRAY'){
for(const e of slot.entries){
const kw=(e.keywords||[]).filter(k=>respTokens.has(k)).length;
const contentOverlap=tokenize(e.content).filter(w=>respTokens.has(w)).length;
if(nameUsed||kw>=2||contentOverlap>=3){
e.stability=(e.stability||1)*1.2+0.05;
}else{
e.stability=Math.max(0.5,(e.stability||1)*0.95);
}
}}}
}
}

// ============================================================
// Themen-Extraktion (unveraendert)
// ============================================================

export function extractConversationThemes(messages,maxThemes=5){
if(!messages||messages.length<2)return[];
const recent=messages.slice(-6);
const freq=new Map;
for(const msg of recent){
const tokens=tokenize(msg.mes||'');
for(const t of tokens){
if(t.length>2)freq.set(t,(freq.get(t)||0)+1);
}}
return[...freq.entries()]
.filter(([,c])=>c>=2)
.sort((a,b)=>b[1]-a[1])
.slice(0,maxThemes)
.map(([w])=>w);
}

// ============================================================
// Dynamic Hint fuer Entity-Kontext
// ============================================================

export function buildDynamicHint(results,store){
if(!results.length)return'';
const parts=[];

const emotState=computeEmotionalState(store);
if(emotState){
parts.push(`The character's ${emotState.toLowerCase()}`);
}

const recalls=results.filter(r=>r.isAssociativeRecall);
if(recalls.length){
parts.push(`An associative memory was triggered — let it subtly color the response`);
}

// Entity-Typ-Hinweise
const types=new Set(results.map(r=>r.entity.type));
if(types.has('person'))parts.push('Character profiles are loaded — reference names, roles, appearance and stats when relevant');
if(types.has('location'))parts.push('Location details are loaded — use setting descriptions naturally');

// Intensive emotionale Eintraege
let intenseCount=0;
for(const r of results){
for(const slot of Object.values(r.entity.slots)){
if(slot.mode==='SINGLE'&&(slot.emotionalIntensity||0)>=0.7)intenseCount++;
else if(slot.mode==='ARRAY')intenseCount+=slot.entries.filter(e=>(e.emotionalIntensity||0)>=0.7).length;
}}
if(intenseCount>0){
parts.push(`${intenseCount} deeply impactful ${intenseCount===1?'memory is':'memories are'} present — these should influence tone and behavior`);
}

// Plot vorhanden?
const hasPlot=results.some(r=>r.entity.slots.plot?.entries?.length>0);
if(hasPlot)parts.push('Key story events are loaded — maintain continuity with established timeline');

if(!parts.length)return'[Memory Recall Active: Naturally weave relevant memories into your response without explicitly labeling them as "memories" or "recollections".]';
return`[Memory Recall Active: ${parts.join('. ')}. Weave these naturally into the response without labeling them as memories.]`;
}
