import{uid,now}from'./utils.js';
import{extractEntitiesFromText,createEntityNode,updateEntityMention}from'./entities.js';
import{addMemory,addEntity,getEntity}from'./store.js';
import{eid}from'./utils.js';

const EXTRACT_SYSTEM=`You are a memory extraction system. Analyze the conversation excerpt and extract discrete memories as a JSON array.

Each memory object must have:
- "content": string (concise fact or event, 1-2 sentences max)
- "type": "episodic"|"semantic"|"emotional"|"relational"
  - episodic: specific events that happened ("They visited the cave on day 3")
  - semantic: general facts/preferences ("Alice prefers tea over coffee")
  - emotional: emotionally significant moments ("Bob was deeply hurt by the betrayal")
  - relational: relationship dynamics ("Alice and Bob became close friends")
- "entities": string[] (named characters, places, objects mentioned)
- "keywords": string[] (3-8 important lowercase keywords)
- "emotionalValence": number (-1.0 negative to 1.0 positive, 0 neutral)
- "emotionalIntensity": number (0.0 neutral to 1.0 extreme emotion)
- "importance": number (0.0 trivial to 1.0 critical)

Rules:
- Extract only NEW information not obvious from context
- Maximum 5 memories per exchange
- Be concise, no fluff
- Keywords should be lowercase, single words
- Respond ONLY with a valid JSON array, no markdown, no explanation`;

export function buildExtractionPrompt(messages,maxMessages=4){
const recent=messages.slice(-maxMessages);
let prompt='Extract memories from this conversation excerpt:\n\n';
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
raw=await generateFn({quietPrompt:`${EXTRACT_SYSTEM}\n\n${prompt}`,skipWIAN:true,removeReasoning:false,responseLength:8192});
console.log('[NM] generateFn returned, raw length:',raw?.length||0);
console.log('[NM] raw response (first 500):',raw?.substring(0,500));
}catch(e){
console.error('[NM] extraction generation FAILED:',e.message||e);
console.error('[NM] full error:',e);
return[];
}
if(!raw||!raw.trim()){
console.warn('[NM] extraction returned empty/null response');
return[];
}
return parseExtractionResult(raw,charId,messages);
}

// JSON aus einem Text-Block extrahieren (sucht Array oder Objekt)
function findJSON(text){
if(!text)return null;
let s=text.trim();
// Markdown code blocks entfernen
const cbMatch=s.match(/```(?:json)?\s*([\s\S]*?)```/);
if(cbMatch){s=cbMatch[1].trim();console.log('[NM] stripped markdown code block')}
// Array finden
const arrMatch=s.match(/\[[\s\S]*\]/);
if(arrMatch)return arrMatch[0];
// Einzelnes Objekt? -> in Array wrappen
const objMatch=s.match(/\{[\s\S]*\}/);
if(objMatch){console.log('[NM] wrapped single object in array');return'['+objMatch[0]+']'}
return null;
}

export function parseExtractionResult(raw,charId,messages){
if(!raw){console.log('[NM] parseExtractionResult: raw is empty');return[]}

// Reasoning-Tags entfernen und Content + Reasoning separat durchsuchen
// DeepSeek-Reasoner gibt JSON oft im Reasoning-Block zurueck
let searchText=raw;
// Reasoning-Block extrahieren falls vorhanden
const thinkMatch=raw.match(/<think>([\s\S]*?)<\/think>/);
const contentAfterThink=thinkMatch?raw.replace(/<think>[\s\S]*?<\/think>/,'').trim():raw;

// Erst im Content suchen, dann im Reasoning
let json=findJSON(contentAfterThink);
if(!json&&thinkMatch){
console.log('[NM] no JSON in content, searching reasoning block...');
json=findJSON(thinkMatch[1]);
}
if(!json){
console.log('[NM] no JSON found in entire response, trying raw...');
json=findJSON(raw);
}
if(!json){
console.error('[NM] could not find JSON in response');
console.error('[NM] raw (first 500):',raw.slice(0,500));
return[];
}

let arr;
try{arr=JSON.parse(json)}catch(e){
console.error('[NM] JSON parse failed:',e.message);
console.error('[NM] attempted to parse:',json.slice(0,300));
console.error('[NM] original raw:',raw.slice(0,300));
return[];
}
if(!Array.isArray(arr)){console.warn('[NM] parsed result is not array:',typeof arr);return[]}

const t=now();
const lastMsgIdx=messages.length-1;
const results=[];
for(const item of arr.slice(0,5)){
if(!item.content||typeof item.content!=='string')continue;
const mem={
id:uid(),
characterId:charId,
type:['episodic','semantic','emotional','relational'].includes(item.type)?item.type:'semantic',
content:item.content.slice(0,300),
entities:Array.isArray(item.entities)?item.entities.map(String).slice(0,10):[],
keywords:Array.isArray(item.keywords)?item.keywords.map(s=>String(s).toLowerCase()).slice(0,8):[],
emotionalValence:typeof item.emotionalValence==='number'?Math.max(-1,Math.min(1,item.emotionalValence)):0,
emotionalIntensity:typeof item.emotionalIntensity==='number'?Math.max(0,Math.min(1,item.emotionalIntensity)):0.1,
importance:typeof item.importance==='number'?Math.max(0,Math.min(1,item.importance)):0.5,
stability:1.0,
retrievability:1.0,
accessCount:0,
createdAt:t,
lastAccessedAt:t,
lastReinforcedAt:t,
sourceMessageIds:[lastMsgIdx-1,lastMsgIdx],
connections:[]
};
results.push(mem);
}
return results;
}

export function integrateMemories(store,newMemories){
for(const mem of newMemories){
addMemory(store,mem);
// Entities anlegen/aktualisieren
for(const eName of mem.entities){
const entId=eid(eName);
let ent=getEntity(store,entId);
if(ent){
updateEntityMention(ent);
}else{
ent=createEntityNode(eName,store.characterId);
addEntity(store,ent);
}
// Memory-Entity Verbindung
if(!mem.connections.find(c=>c.targetId===entId)){
mem.connections.push({targetId:entId,weight:0.8,type:'entity'});
}
if(!ent.connections.find(c=>c.targetId===mem.id)){
ent.connections.push({targetId:mem.id,weight:0.8,type:'memory'});
}
}}
}
