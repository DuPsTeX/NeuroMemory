import{BM25,tokenize,extractKeywords,now,hrs,expDecay,clamp}from'./utils.js';
import{spreadingActivation}from'./network.js';
import{extractEntitiesFromText,ENTITY_SCHEMAS,ENTITY_TYPE_ICONS,ALWAYS_SLOTS}from'./entities.js';
import{getAllEntities,getAllSlotEntries,getEntity}from'./store.js';

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
const result=scored.slice(0,topK);

// Memory Surprise: 15% Chance fuer spontane emotionale Entity
if(Math.random()<0.15){
const candidates=entities.filter(ent=>{
if(result.some(r=>r.entity.id===ent.id))return false;
for(const slot of Object.values(ent.slots)){
if(slot.mode==='SINGLE'&&(slot.emotionalIntensity||0)>=0.6)return true;
if(slot.mode==='ARRAY'&&slot.entries.some(e=>(e.emotionalIntensity||0)>=0.6))return true;
}return false;
});
if(candidates.length){
const pick=candidates[Math.floor(Math.random()*Math.min(candidates.length,5))];
result.push({entity:pick,score:0.05,activation:0.05,retrievability:0.5,isSurprise:true,slotScores:new Map});
console.log('[NM] Memory Surprise: entity',pick.name);
}
}

return result;
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
return best?best.substring(0,120):null;
}

// ============================================================
// Formatiere Entity-Kontext fuer Prompt-Injektion
// ============================================================

export function formatEntityContext(results,maxTokens=500,store=null){
if(!results.length)return'';

const surprise=results.find(r=>r.isSurprise);
const mainResults=results.filter(r=>!r.isSurprise);

let out='';
let approxTokens=0;
const add=(text)=>{
const t=Math.ceil(text.length/4);
if(approxTokens+t>maxTokens)return false;
out+=text;approxTokens+=t;return true;
};

// Block 1: Digest (Character Essence)
if(store?.digest?.text){
if(!add(`[Character Essence]\n${store.digest.text}\n\n`))return out;
}

// Block 2: Entities nach Typ sortiert, Score absteigend
const typeOrder=['person','location','item','faction','concept'];
const sorted=[...mainResults].sort((a,b)=>{
const ai=typeOrder.indexOf(a.entity.type);
const bi=typeOrder.indexOf(b.entity.type);
if(ai!==bi)return ai-bi;
return b.score-a.score;
});

// Top-Entities (score >= 0.6 oder Top 5) bekommen volle Slots,
// Rest bekommt nur kompakte Einzeiler
const FULL_THRESHOLD=0.6;
const MIN_FULL=3;
const MAX_FULL=6;
let fullCount=0;
for(const r of sorted){
if(r.score>=FULL_THRESHOLD)fullCount++;
}
fullCount=Math.max(MIN_FULL,Math.min(MAX_FULL,fullCount));

for(let i=0;i<sorted.length;i++){
const r=sorted[i];
const ent=r.entity;
const typeLabel=ent.type.charAt(0).toUpperCase()+ent.type.slice(1);
const isFull=i<fullCount;

if(isFull){
// === VOLLER OUTPUT: nur relevante Slots ===
if(!add(`[${typeLabel}: ${ent.name}]\n`))break;
const schema=ENTITY_SCHEMAS[ent.type]||{};
const alwaysSet=ALWAYS_SLOTS[ent.type]||new Set;
const ss=r.slotScores||new Map;
// Max Slot-Score fuer Normalisierung
let maxSS=0;
for(const v of ss.values())if(v>maxSS)maxSS=v;
const SLOT_THRESHOLD=0.3;

// SINGLE Slots — nur ALWAYS, pinned, oder relevant
for(const[slotName,slotDef]of Object.entries(schema)){
const slot=ent.slots[slotName];
if(!slot||slot.mode!=='SINGLE'||!slot.value)continue;
if(!alwaysSet.has(slotName)&&!slot.pinned){
const norm=maxSS>0?(ss.get(slotName)||0)/maxSS:0;
if(norm<SLOT_THRESHOLD)continue;
}
if(!add(`${slotDef.label||slotName}: ${slot.value}\n`))break;
}

// ARRAY Slots — nur wenn mindestens ein Entry relevant (oder ALWAYS/pinned)
for(const[slotName,slotDef]of Object.entries(schema)){
const slot=ent.slots[slotName];
if(!slot||slot.mode!=='ARRAY'||!slot.entries.length)continue;
const hasPinned=slot.entries.some(e=>e.pinned);
if(!alwaysSet.has(slotName)&&!hasPinned){
const anyRelevant=slot.entries.some(e=>{
const key=slotName+'|'+e.id;
return maxSS>0&&(ss.get(key)||0)/maxSS>=SLOT_THRESHOLD;
});
if(!anyRelevant)continue;
}
// Sortiere: pinned → BM25-Relevanz → Importance → Recency
const entries=[...slot.entries]
.map(e=>({entry:e,rel:maxSS>0?(ss.get(slotName+'|'+e.id)||0)/maxSS:0}))
.sort((a,b)=>{
if(a.entry.pinned!==b.entry.pinned)return b.entry.pinned?1:-1;
if(Math.abs(a.rel-b.rel)>0.1)return b.rel-a.rel;
return(b.entry.importance||0)-(a.entry.importance||0)||(b.entry.createdAt||0)-(a.entry.createdAt||0);
})
.slice(0,3);
for(const{entry}of entries){
const emo=emotionLabel(entry);
if(!add(`* ${slotDef.label||slotName}: ${entry.content}${emo}\n`))break;
}
}
add('\n');
}else{
// === KOMPAKTER OUTPUT: nur Name + wichtigster Inhalt ===
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

// Block 4: Sudden Recall (Surprise)
if(surprise){
const ent=surprise.entity;
// Finde den emotionalsten Eintrag
let bestEntry=null,bestInt=0;
for(const slot of Object.values(ent.slots)){
if(slot.mode==='SINGLE'&&(slot.emotionalIntensity||0)>bestInt){
bestEntry={content:slot.value,emotionalIntensity:slot.emotionalIntensity,emotionalValence:slot.emotionalValence};
bestInt=slot.emotionalIntensity;
}else if(slot.mode==='ARRAY'){
for(const e of slot.entries){
if((e.emotionalIntensity||0)>bestInt){bestEntry=e;bestInt=e.emotionalIntensity}
}}}
if(bestEntry){
const intStr=bestInt>=0.75?'★★★':bestInt>=0.5?'★★':'★';
add(`[Sudden Recall] ${intStr} "${bestEntry.content}"${emotionLabel(bestEntry)}\n`);
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

const surprise=results.find(r=>r.isSurprise);
if(surprise){
parts.push(`An unexpected memory just surfaced — let it subtly color the response`);
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
