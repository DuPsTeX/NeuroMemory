import{BM25,tokenize,extractKeywords,now,hrs,expDecay,clamp}from'./utils.js';
import{spreadingActivation}from'./network.js';
import{extractEntitiesFromText}from'./entities.js';
import{getAllMemories,getAllEntities}from'./store.js';

// Multi-Signal Retrieval mit BM25 + Spreading Activation + Scoring
export function retrieveMemories(store,message,opts={}){
const{
topK=10,maxHops=3,decayPerHop=0.5,activationThreshold=0.15,
halfLifeHours=720,emotionFactor=0.5,
weights={activation:0.35,importance:0.20,retrievability:0.20,emotion:0.15,recency:0.10}
}=opts;

const mems=getAllMemories(store);
if(!mems.length)return[];

const entities=getAllEntities(store);
const queryTokens=tokenize(message);
const queryKeywords=extractKeywords(message);
const queryEntities=extractEntitiesFromText(message,entities);

// Phase 1a: BM25 auf Keywords (gespeicherte Extraktions-Keywords)
const bm25k=new BM25;
for(const m of mems)bm25k.add(m.id,m.keywords||[]);
const bm25KwResults=bm25k.search(queryKeywords,Math.min(mems.length,50));

// Phase 1b: BM25 auf Content-Text (Fallback fuer Sprach-Mismatch DE/EN)
const bm25c=new BM25;
for(const m of mems)bm25c.add(m.id,tokenize(m.content||''));
const bm25ContentResults=bm25c.search(queryTokens,Math.min(mems.length,50));

// Kombiniere beide BM25-Ergebnisse
const bm25Scores=new Map;
for(const r of bm25KwResults)bm25Scores.set(r.id,(bm25Scores.get(r.id)||0)+r.score);
for(const r of bm25ContentResults)bm25Scores.set(r.id,(bm25Scores.get(r.id)||0)+r.score*0.6);

// Normalisiere BM25 Scores
const allBm25=Array.from(bm25Scores.values());
const maxBM25=allBm25.length?Math.max(...allBm25):1;

// Phase 2: Entity-Match (case-insensitive)
const msgLower=message.toLowerCase();
const entityMatches=new Set;
for(const qe of queryEntities){
for(const ent of entities){
if(ent.name.toLowerCase()===qe.toLowerCase()||ent.aliases.some(a=>a.toLowerCase()===qe.toLowerCase())){
entityMatches.add(ent.id);
for(const m of mems){
if(m.entities.some(e=>e.toLowerCase()===ent.name.toLowerCase()))entityMatches.add(m.id);
}}}}
// Zusaetzlich: direkte Namensnennung im Message-Text
for(const ent of entities){
if(msgLower.includes(ent.name.toLowerCase())){
entityMatches.add(ent.id);
for(const m of mems){
if(m.entities.some(e=>e.toLowerCase()===ent.name.toLowerCase()))entityMatches.add(m.id);
}}}

// Phase 3: Initiale Aktivierungen
const initialAct=new Map;
for(const[id,score]of bm25Scores){
initialAct.set(id,clamp(score/(maxBM25||1)));
}
for(const id of entityMatches){
const cur=initialAct.get(id)||0;
initialAct.set(id,clamp(Math.max(cur,0.7)));
}

// Fallback: wenn kein Treffer (z.B. Sprach-Mismatch), Top-K nach Wichtigkeit/Retrievability
if(!initialAct.size){
const t0=now();
const fallback=mems.map(m=>{
const effStab=m.stability*(1+m.emotionalIntensity*emotionFactor);
const ret=expDecay(hrs(t0-m.lastReinforcedAt),effStab,halfLifeHours);
const recH=hrs(t0-m.lastAccessedAt);
const rec=clamp(1/(1+recH/168));
return{memory:m,score:m.importance*0.4+ret*0.4+rec*0.2,activation:0.1,retrievability:ret};
}).sort((a,b)=>b.score-a.score).slice(0,topK);
console.log('[NM] retrieval: no query signal, using fallback top-'+fallback.length);
return fallback;
}

// Phase 4: Spreading Activation
const activations=spreadingActivation(store,initialAct,{maxHops,decayPerHop,threshold:activationThreshold});

// Phase 5: Multi-Signal Scoring
const t=now();
const scored=[];
for(const m of mems){
const act=activations.get(m.id)||0;
if(act<activationThreshold*0.5&&!bm25Scores.has(m.id))continue;

const effStab=m.stability*(1+m.emotionalIntensity*emotionFactor);
const retrievability=expDecay(hrs(t-m.lastReinforcedAt),effStab,halfLifeHours);
const recencyH=hrs(t-m.lastAccessedAt);
const recencyBoost=clamp(1/(1+recencyH/168));// 168h=1 Woche Halbwertszeit

const score=
(act||0)*weights.activation+
m.importance*weights.importance+
retrievability*weights.retrievability+
m.emotionalIntensity*weights.emotion+
recencyBoost*weights.recency;

scored.push({memory:m,score,activation:act,retrievability});
}

scored.sort((a,b)=>b.score-a.score);
return scored.slice(0,topK);
}

// Formatiere Memories als Kontext-Block fuer Prompt-Injektion
// store: optional, wird fuer Digest-Prepend verwendet
export function formatMemoryContext(results,maxTokens=500,store=null){
if(!results.length)return'';
let out='';
// Digest voranstellen wenn vorhanden
if(store?.digest?.text){
out+=`[Character Summary]\n${store.digest.text}\n\n`;
}
out+='[Character Memory - Recalled associations]\n';
let approxTokens=Math.ceil(out.length/4);
for(const r of results){
const line=`- ${r.memory.content} [${r.memory.type}]\n`;
const lineTokens=Math.ceil(line.length/4);// Grobe Schaetzung
if(approxTokens+lineTokens>maxTokens)break;
out+=line;
approxTokens+=lineTokens;
}
return out;
}

// Reinforcement: Memory wurde abgerufen → Stabilitaet erhoehen
export function reinforceMemories(results){
const t=now();
for(const r of results){
const m=r.memory;
m.accessCount++;
m.lastAccessedAt=t;
m.lastReinforcedAt=t;
m.stability=m.stability*1.5+0.1;
m.retrievability=1.0;
}
}
