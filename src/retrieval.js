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

// Phase 1: BM25 Keyword-Suche
const bm25=new BM25;
for(const m of mems)bm25.add(m.id,m.keywords||[]);
const bm25Results=bm25.search(queryKeywords,Math.min(mems.length,50));
const bm25Scores=new Map(bm25Results.map(r=>[r.id,r.score]));

// Normalisiere BM25 Scores
const maxBM25=bm25Results.length?bm25Results[0].score:1;

// Phase 2: Entity-Match
const entityMatches=new Set;
for(const qe of queryEntities){
for(const ent of entities){
if(ent.name===qe||ent.aliases.includes(qe)){
entityMatches.add(ent.id);
// Alle Memories die diese Entity referenzieren
for(const m of mems){
if(m.entities.includes(ent.name))entityMatches.add(m.id);
}}}}

// Phase 3: Initiale Aktivierungen
const initialAct=new Map;
for(const[id,score]of bm25Scores){
initialAct.set(id,clamp(score/(maxBM25||1)));
}
for(const id of entityMatches){
const cur=initialAct.get(id)||0;
initialAct.set(id,clamp(Math.max(cur,0.7)));
}

if(!initialAct.size)return[];

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
export function formatMemoryContext(results,maxTokens=500){
if(!results.length)return'';
let out='[Character Memory - Recalled associations]\n';
let approxTokens=10;
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
