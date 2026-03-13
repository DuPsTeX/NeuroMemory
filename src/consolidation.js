import{now,hrs,expDecay,cosineSim,tokenize,extractKeywords}from'./utils.js';
import{getAllMemories,removeMemory,updateMemory}from'./store.js';
import{updateMemoryConnections}from'./network.js';

const DIGEST_SYSTEM=`You are a character memory narrator. Given a list of memories about a fictional character, write a cohesive 2-3 sentence narrative summary. Focus on character essence, key relationships, and emotional state. Write in third person, present tense. Pure prose — no lists, no bullet points. Respond with ONLY the summary text, no additional formatting.`;

export async function generateDigest(generateFn,store){
const mems=getAllMemories(store).filter(m=>m.importance>=0.5||m.pinned).sort((a,b)=>b.importance-a.importance).slice(0,12);
if(mems.length<3)return null;
const memList=mems.map(m=>`[${m.type}] ${m.content}`).join('\n');
const prompt=`${DIGEST_SYSTEM}\n\nMemories:\n${memList}\n\nNarrative Summary:`;
try{
const raw=await generateFn({quietPrompt:prompt,skipWIAN:true,removeReasoning:true,responseLength:200});
return raw?.trim()||null;
}catch(e){console.warn('[NM] digest generation failed',e);return null}
}

const CONSOLIDATE_SYSTEM=`You are a memory consolidation system. Given two memories, decide the operation:
- "UPDATE": memories contain overlapping/complementary info → merge into one
- "DELETE": new memory contradicts old → old should be removed
- "NOOP": memories are duplicates or unrelated → do nothing

Respond ONLY with JSON: {"operation":"UPDATE"|"DELETE"|"NOOP","merged":"merged content if UPDATE, empty string otherwise"}`;

// Ebbinghaus-Decay auf alle Memories anwenden
export function applyDecay(store,halfLifeHours=720,emotionFactor=0.5){
const t=now();
const mems=getAllMemories(store);
const toRemove=[];
for(const m of mems){
if(m.pinned)continue;// Gepinnte Memories sind unvergesslich
const effStab=m.stability*(1+(m.emotionalIntensity||0)*emotionFactor);
m.retrievability=expDecay(hrs(t-m.lastReinforcedAt),effStab,halfLifeHours);
if(m.retrievability<0.05)toRemove.push(m.id);
}
for(const id of toRemove)removeMemory(store,id);
return toRemove.length;
}

// Finde aehnliche Memories via BM25-artigen Keyword-Vergleich
export function findSimilar(store,memory,threshold=0.4){
const mems=getAllMemories(store);
const mTokens=tokenize(memory.content);
const results=[];
for(const m of mems){
if(m.id===memory.id)continue;
const sim=cosineSim(mTokens,tokenize(m.content));
const entityOverlap=memory.entities.filter(e=>m.entities.includes(e)).length;
const combined=sim*0.7+(entityOverlap>0?0.3:0);
if(combined>=threshold)results.push({memory:m,similarity:combined});
}
return results.sort((a,b)=>b.similarity-a.similarity);
}

// LLM-basierte Konsolidierung
export async function consolidateWithLLM(generateFn,store,batchSize=10){
const mems=getAllMemories(store);
if(mems.length<2)return 0;

// Sortiere nach Erstellungszeitpunkt, neueste zuerst
const sorted=[...mems].sort((a,b)=>b.createdAt-a.createdAt);
const recent=sorted.slice(0,batchSize);
let ops=0;

for(const mem of recent){
const similar=findSimilar(store,mem,0.4);
if(!similar.length)continue;

const top=similar[0];
const prompt=`${CONSOLIDATE_SYSTEM}\n\nExisting memory: "${top.memory.content}"\nNew memory: "${mem.content}"\n\nDecide:`;

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
updateMemory(store,top.memory.id,{
content:result.merged.slice(0,300),
importance:Math.max(top.memory.importance,mem.importance),
stability:Math.max(top.memory.stability,mem.stability)+0.2,
lastReinforcedAt:now(),
keywords:[...new Set([...top.memory.keywords,...mem.keywords])].slice(0,10),
entities:[...new Set([...top.memory.entities,...mem.entities])].slice(0,10),
});
removeMemory(store,mem.id);
ops++;
}else if(result.operation==='DELETE'){
removeMemory(store,mem.id);
ops++;
}
}
return ops;
}

// Volle Konsolidierungsrunde
export async function runConsolidation(generateFn,store,settings){
const{halfLifeHours=720,emotionFactor=0.5,maxMemories=500,consolidationBatch=10,digestEveryN=15}=settings;
// 1. Decay anwenden
const forgotten=applyDecay(store,halfLifeHours,emotionFactor);
// 2. LLM-Konsolidierung
const merged=await consolidateWithLLM(generateFn,store,consolidationBatch);
// 3. Verbindungen aktualisieren
updateMemoryConnections(store);
// 4. Limit enforcen
const mems=getAllMemories(store);
if(mems.length>maxMemories){
// Gepinnte Memories nie loeschen, nur unpinnte nach Retrievability priorisieren
const unpinned=[...mems].filter(m=>!m.pinned).sort((a,b)=>a.retrievability-b.retrievability);
const excess=unpinned.slice(0,mems.length-maxMemories);
for(const m of excess)removeMemory(store,m.id);
}
store.meta.lastConsolidation=now();
// Digest auto-generieren falls noetig
const memCount=Object.keys(store.memories).length;
const lastCount=store.digest?.memCount||0;
if(!store.digest||(memCount-lastCount)>=digestEveryN){
const digestText=await generateDigest(generateFn,store);
if(digestText)store.digest={text:digestText,generatedAt:now(),memCount};
}
return{forgotten,merged,total:Object.keys(store.memories).length};
}
