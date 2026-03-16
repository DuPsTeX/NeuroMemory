import{BM25,tokenize,extractKeywords,now,hrs,expDecay,clamp}from'./utils.js';
import{spreadingActivation}from'./network.js';
import{extractEntitiesFromText}from'./entities.js';
import{getAllMemories,getAllEntities}from'./store.js';

// Multi-Signal Retrieval mit BM25 + Spreading Activation + Scoring
export function retrieveMemories(store,message,opts={}){
const{
topK=10,maxHops=3,decayPerHop=0.5,activationThreshold=0.15,
halfLifeHours=720,emotionFactor=0.5,
weights={activation:0.30,importance:0.20,retrievability:0.15,emotion:0.25,recency:0.10}
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
const result=scored.slice(0,topK);

// Memory Surprise: 15% Chance fuer spontane starke emotionale Erinnerung (wie ein Flashback)
if(Math.random()<0.15){
const candidates=mems.filter(m=>
!result.some(s=>s.memory.id===m.id)&&(m.emotionalIntensity||0)>=0.6
).sort((a,b)=>(b.emotionalIntensity||0)-(a.emotionalIntensity||0));
if(candidates.length){
result.push({memory:candidates[0],score:0.05,activation:0.05,
retrievability:candidates[0].retrievability,isSurprise:true});
console.log('[NM] Memory Surprise:',candidates[0].content.substring(0,60));
}
}

return result;
}

// Berechne aktuellen emotionalen Zustand aus den letzten emotional relevanten Memories
function computeEmotionalState(store){
if(!store)return null;
const mems=Object.values(store.memories)
.filter(m=>(m.emotionalIntensity||0)>0.2)
.sort((a,b)=>b.createdAt-a.createdAt).slice(0,10);
if(mems.length<2)return null;
const avg=mems.reduce((s,m)=>s+(m.emotionalValence||0),0)/mems.length;
const half=Math.floor(mems.length/2);
const recentAvg=mems.slice(0,half).reduce((s,m)=>s+(m.emotionalValence||0),0)/half;
const olderAvg=mems.slice(half).reduce((s,m)=>s+(m.emotionalValence||0),0)/(mems.length-half);
const trend=recentAvg-olderAvg;
const state=avg>0.5?'joyful':avg>0.2?'content':avg>-0.2?(mems.some(m=>(m.emotionalIntensity||0)>0.6)?'conflicted':'calm'):avg>-0.5?'troubled':'grieving';
const trendStr=trend>0.15?', trending hopeful':trend<-0.15?', darkening':'';
return`Current Emotional State: ${state}${trendStr}`;
}

// Emotion-Label fuer Prompt: ★★★ highly negative etc.
function emotionLabel(m){
if(!m.emotionalIntensity||m.emotionalIntensity<0.3)return'';
const valStr=m.emotionalValence>0.3?'positive':m.emotionalValence<-0.3?'negative':'mixed';
const intStr=m.emotionalIntensity>=0.75?'★★★ highly':m.emotionalIntensity>=0.5?'★★':' ★ slightly';
return` | ${intStr} ${valStr}`;
}

// Formatiere Memories als tiered Kontext-Block fuer Prompt-Injektion
export function formatMemoryContext(results,maxTokens=500,store=null){
if(!results.length)return'';

// Surprise-Memory separieren
const surprise=results.find(r=>r.isSurprise);
const mainResults=results.filter(r=>!r.isSurprise);

// In Tiers aufteilen
const defining=mainResults
.filter(r=>(r.memory.emotionalIntensity||0)>=0.5)
.sort((a,b)=>(b.memory.emotionalIntensity||0)-(a.memory.emotionalIntensity||0))
.slice(0,3);
const defIds=new Set(defining.map(r=>r.memory.id));

const recent=mainResults
.filter(r=>r.memory.type==='episodic'&&!defIds.has(r.memory.id))
.sort((a,b)=>b.memory.createdAt-a.memory.createdAt)
.slice(0,4);
const recIds=new Set(recent.map(r=>r.memory.id));

const background=mainResults.filter(r=>!defIds.has(r.memory.id)&&!recIds.has(r.memory.id));

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

// Block 2: Aktueller emotionaler Zustand
const emotState=computeEmotionalState(store);
if(emotState){
if(!add(`[${emotState}]\n\n`))return out;
}

// Block 3: Defining Memories (high emotional weight)
if(defining.length){
if(!add('[Defining Memories — High Emotional Weight]\n'))return out;
for(const r of defining){
const m=r.memory;
const intStr=(m.emotionalIntensity||0)>=0.75?'★★★':(m.emotionalIntensity||0)>=0.5?'★★ ':'★  ';
if(!add(`${intStr} ${m.content}${emotionLabel(m)}\n`))break;
}
if(!add('\n'))return out;
}

// Block 4: Recent Events (episodic, nicht defining)
if(recent.length){
if(!add('[Recent Events]\n'))return out;
for(const r of recent){
if(!add(`• ${r.memory.content}\n`))break;
}
if(!add('\n'))return out;
}

// Block 5: Background Knowledge (semantic + relational)
if(background.length){
if(!add('[Background Knowledge]\n'))return out;
for(const r of background){
const m=r.memory;
const emo=emotionLabel(m);
if(!add(`• ${m.content}${emo?` [${m.type}${emo}]`:''}\n`))break;
}
}

// Block 6: Sudden Recall (Memory Surprise — spontaner Flashback)
if(surprise){
const m=surprise.memory;
const intStr=(m.emotionalIntensity||0)>=0.75?'★★★':(m.emotionalIntensity||0)>=0.5?'★★ ':'★  ';
add(`\n[Sudden Recall]\n${intStr} Unvermutet taucht auf: "${m.content}"${emotionLabel(m)}\n`);
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

// Selective Reinforcement: Nur Memories boosten die die KI tatsaechlich benutzt hat
export function selectiveReinforce(results,responseText){
if(!responseText||!results.length)return;
const t=now();
const respLower=responseText.toLowerCase();
const respTokens=new Set(tokenize(responseText));
for(const r of results){
const m=r.memory;
// Check: Hat die KI Entities oder Keywords aus dieser Memory erwaehnt?
const entityHit=m.entities.some(e=>respLower.includes(e.toLowerCase()));
const keywordHits=(m.keywords||[]).filter(k=>respTokens.has(k)).length;
const contentWords=tokenize(m.content);
const contentOverlap=contentWords.filter(w=>respTokens.has(w)).length;
const used=entityHit||keywordHits>=2||contentOverlap>=3;
if(used){
// KI hat diese Memory aufgegriffen → extra Boost
m.stability=m.stability*1.2+0.05;
r._used=true;
console.log('[NM] selective: USED',m.content.substring(0,50));
}else{
// Injiziert aber ignoriert → leichter Abzug
m.stability=Math.max(0.5,m.stability*0.95);
r._used=false;
}
}
}

// Themen aus den letzten Nachrichten extrahieren (ohne LLM, rein heuristisch)
export function extractConversationThemes(messages,maxThemes=5){
if(!messages||messages.length<2)return[];
// Nimm die letzten 6 Nachrichten
const recent=messages.slice(-6);
const freq=new Map;
for(const msg of recent){
const tokens=tokenize(msg.mes||'');
for(const t of tokens){
if(t.length>2)freq.set(t,(freq.get(t)||0)+1);
}
}
// Top-Themen nach Haeufigkeit (nur Woerter die in mind. 2 Messages vorkommen)
return[...freq.entries()]
.filter(([,c])=>c>=2)
.sort((a,b)=>b[1]-a[1])
.slice(0,maxThemes)
.map(([w])=>w);
}

// Dynamic Injection Hint basierend auf injiziertem Kontext
export function buildDynamicHint(results,store){
if(!results.length)return'';
const parts=[];
// Emotionaler Zustand
const emotState=computeEmotionalState(store);
if(emotState){
const state=emotState.replace('Current Emotional State: ','');
parts.push(`The character's emotional state is ${state}`);
}
// Surprise Memory
const surprise=results.find(r=>r.isSurprise);
if(surprise){
parts.push(`An unexpected memory just surfaced — let it subtly color the response`);
}
// Dominante Memory-Typen
const types=results.map(r=>r.memory.type);
const hasEmotional=types.includes('emotional');
const hasRelational=types.includes('relational');
if(hasEmotional&&hasRelational){
parts.push(`Both emotional memories and relationship dynamics are active — weave them naturally`);
}else if(hasEmotional){
parts.push(`Emotionally charged memories are active — reflect the underlying feelings`);
}
// Intensive Memories
const intense=results.filter(r=>(r.memory.emotionalIntensity||0)>=0.7);
if(intense.length){
parts.push(`${intense.length} deeply impactful ${intense.length===1?'memory is':'memories are'} present — these should influence tone and behavior`);
}
if(!parts.length)return'[Memory Recall Active: Naturally weave relevant memories into your response without explicitly labeling them as "memories" or "recollections".]';
return`[Memory Recall Active: ${parts.join('. ')}. Weave these naturally into the response without labeling them as memories.]`;
}
