import{loadStore,saveStore,createEmpty,getAllEntities,countTotalEntries}from'./store.js';
import{extractMemories,integrateEntityUpdates}from'./extraction.js';
import{retrieveEntities,formatEntityContext,reinforceEntities,selectiveReinforce,extractConversationThemes,buildDynamicHint,filterByRelevance}from'./retrieval.js';
import{updateEntityConnections}from'./network.js';
import{runConsolidation}from'./consolidation.js';
import{now}from'./utils.js';

// Zentraler Controller - orchestriert alle Subsysteme (v2 Entity-zentrisch)
export class NeuroMemoryCore{
constructor(){
this.store=null;
this.charId=null;
this.charName='';
this.settings=defaultSettings();
this.messageCounter=0;
this.lastInjected=[];
this.lastRelevanceMap=null;
this.generating=false;
this._generateFn=null;
}

setGenerateFn(fn){this._generateFn=fn}

async loadCharacter(charId,charName){
if(this.charId===charId&&this.store)return;
if(this.store&&this.charId)await saveStore(this.store);
this.charId=charId;
this.charName=charName||'';
this.store=await loadStore(charId);
if(!this.store.characterName&&charName)this.store.characterName=charName;
this.messageCounter=0;
const entCount=Object.keys(this.store.entities).length;
const slotCount=countTotalEntries(this.store);
console.log(`[NM] Loaded store for ${charName}: ${entCount} entities, ${slotCount} slot entries (v${this.store.meta?.schemaVersion||1})`);
}

async unload(){
if(this.store&&this.charId)await saveStore(this.store);
this.store=null;this.charId=null;
}

// Nach AI-Antwort: Entity-Updates extrahieren
async onMessageReceived(chat){
console.log('[NM] core.onMessageReceived called, chat.length:',chat?.length);
console.log('[NM] guards: enabled=',this.settings.enabled,', store=',!!this.store,', generateFn=',!!this._generateFn,', generating=',this.generating);

if(!this.settings.enabled){console.log('[NM] SKIP: disabled');return}
if(!this.store){console.log('[NM] SKIP: no store loaded');return}
if(!this._generateFn){console.log('[NM] SKIP: no generateFn');return}
if(this.generating){console.log('[NM] SKIP: already generating');return}

this.messageCounter++;
const willExtract=this.messageCounter%this.settings.extractEveryN===0;
console.log('[NM] counter:',this.messageCounter,', extractEveryN:',this.settings.extractEveryN,', willExtract:',willExtract);
if(!willExtract)return;

this.generating=true;
try{
console.log('[NM] calling extractMemories...');
const updates=await extractMemories(
this._generateFn,chat,this.charId,
this.settings.extractContextMessages,this.store
);
console.log('[NM] extractMemories returned:',updates.length,'updates');
if(updates.length){
const{added,merged}=integrateEntityUpdates(this.store,updates);
updateEntityConnections(this.store);
await saveStore(this.store);
console.log(`[NM] Integrated: ${added} added, ${merged} merged/updated`);
for(const u of updates)console.log(`[NM]   -> [${u.entityType}] ${u.entity}.${u.slot}: ${u.content.substring(0,60)}`);
}else{
console.log('[NM] No entity updates extracted from this exchange');
}
}catch(e){console.error('[NM] extraction error',e)}
finally{this.generating=false}

// Konsolidierung periodisch
if(this.messageCounter%this.settings.consolidateEveryN===0){
try{
console.log('[NM] running consolidation...');
const r=await runConsolidation(this._generateFn,this.store,this.settings);
await saveStore(this.store);
console.log(`[NM] Consolidation: ${r.forgotten} forgotten, ${r.merged} merged, ${r.total} total`);
}catch(e){console.error('[NM] consolidation error',e)}
}
}

// Vor Generation: relevante Entities abrufen + LLM-Relevanz-Filter ausfuehren
async retrieveForMessage(message,chatMessages){
if(!this.settings.enabled||!this.store)return{context:'',hint:''};

const themes=chatMessages?extractConversationThemes(chatMessages):[];
const queryWithThemes=themes.length?message+' '+themes.join(' '):message;

const results=retrieveEntities(this.store,queryWithThemes,{
topK:this.settings.topK,
maxHops:this.settings.activationHops,
decayPerHop:0.5,
activationThreshold:this.settings.activationThreshold,
halfLifeHours:this.settings.halfLifeDays*24,
emotionFactor:this.settings.emotionFactor,
});

// Gepinnte Entities immer einschliessen
const resultIds=new Set(results.map(r=>r.entity.id));
for(const ent of Object.values(this.store.entities)){
if(resultIds.has(ent.id))continue;
let hasPinned=false;
for(const slot of Object.values(ent.slots)){
if(slot.mode==='SINGLE'&&slot.pinned&&slot.value){hasPinned=true;break}
if(slot.mode==='ARRAY'&&slot.entries.some(e=>e.pinned)){hasPinned=true;break}
}
if(hasPinned){
results.push({entity:ent,score:1.0,activation:1.0,retrievability:1.0,slotScores:new Map});
}
}

if(!results.length)return{context:'',hint:''};

// Pre-Filter: begrenzte Kandidaten fuer LLM-Filter (topK * 2 fuer Dedup-Reserve)
const topK=this.settings.topK||15;
const candidateLimit=Math.min(results.length,topK*2);
const candidates=results.slice(0,candidateLimit);
console.log(`[NM] retrieval: ${results.length} total → ${candidates.length} candidates for filter (topK=${topK})`);

// LLM-Relevanz-Filter JETZT ausfuehren (vor Formatierung, mit aktuellem Kontext)
let relevanceMap=null;
if(this._generateFn&&candidates.length>=2){
try{
const historyCount=this.settings.filterContextMessages||3;
const snippetTokens=this.settings.filterSnippetTokens||150;
const recentChat=(chatMessages||[]).slice(-historyCount).map(m=>{
const role=m.is_user?'User':'AI';
const text=(m.mes||'').substring(0,snippetTokens*4);
return`${role}: ${text}`;
}).join('\n');
relevanceMap=await filterByRelevance(this._generateFn,candidates,message,recentChat,snippetTokens);
}catch(e){
console.warn('[NM] relevance filter failed:',e.message);
}
}
this.lastRelevanceMap=relevanceMap;

reinforceEntities(candidates);
const context=formatEntityContext(candidates,this.settings.maxContextTokens,this.store,relevanceMap,topK);

// lastInjected: nur die topK die tatsaechlich injiziert werden (nach Dedup)
this.lastInjected=candidates.slice(0,topK);

const hint=this.settings.proactivePrompt?buildDynamicHint(candidates.slice(0,topK),this.store):'';
if(themes.length)console.log('[NM] conversation themes:',themes.join(', '));
return{context,hint};
}


// Selective Reinforcement nach KI-Antwort
applySelectiveReinforcement(responseText){
if(!this.lastInjected.length||!responseText)return;
selectiveReinforce(this.lastInjected,responseText);
console.log(`[NM] selective reinforcement applied to ${this.lastInjected.length} entities`);
}

// Statistiken (v2 Entity-zentrisch)
getStats(){
if(!this.store)return null;
const ents=Object.values(this.store.entities);
const totalEntries=countTotalEntries(this.store);
const byType={person:0,location:0,item:0,faction:0,concept:0};
for(const e of ents)byType[e.type]=(byType[e.type]||0)+1;
return{
totalEntities:ents.length,
totalSlotEntries:totalEntries,
byType,
lastConsolidation:this.store.meta.lastConsolidation,
lastInjectedCount:this.lastInjected.length,
schemaVersion:this.store.meta?.schemaVersion||1,
};
}

getLastInjected(){return this.lastInjected}

async save(){if(this.store)await saveStore(this.store)}
}

export function defaultSettings(){
return{
enabled:true,
topK:10,
maxContextTokens:1500,
maxEntries:500,
extractEveryN:1,
extractContextMessages:4,
maxExtractPerExchange:8,
halfLifeDays:30,
emotionFactor:0.5,
consolidateEveryN:10,
consolidationBatch:10,
activationHops:3,
activationThreshold:0.15,
injectionPosition:0,// IN_PROMPT
injectionDepth:2,
injectionRole:0,// SYSTEM
extractionPrompt:'',// Leer = DEFAULT_EXTRACT_SYSTEM verwenden
digestEveryN:15,
proactivePrompt:false,
filterContextMessages:3,
filterSnippetTokens:150,
};
}
