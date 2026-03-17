import{loadStore,saveStore,createEmpty}from'./store.js';
import{extractMemories,integrateMemories}from'./extraction.js';
import{retrieveMemories,formatMemoryContext,reinforceMemories,selectiveReinforce,extractConversationThemes,buildDynamicHint}from'./retrieval.js';
import{updateMemoryConnections}from'./network.js';
import{runConsolidation}from'./consolidation.js';
import{now}from'./utils.js';

// Zentraler Controller - orchestriert alle Subsysteme
export class NeuroMemoryCore{
constructor(){
this.store=null;
this.charId=null;
this.charName='';
this.settings=defaultSettings();
this.messageCounter=0;
this.lastInjected=[];
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
console.log(`[NM] Loaded store for ${charName}: ${Object.keys(this.store.memories).length} memories, ${Object.keys(this.store.entities).length} entities`);
}

async unload(){
if(this.store&&this.charId)await saveStore(this.store);
this.store=null;this.charId=null;
}

// Nach AI-Antwort: Memories extrahieren
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
const newMems=await extractMemories(
this._generateFn,chat,this.charId,
this.settings.extractContextMessages
);
console.log('[NM] extractMemories returned:',newMems.length,'memories');
if(newMems.length){
integrateMemories(this.store,newMems);
updateMemoryConnections(this.store);// Memory-zu-Memory Verbindungen aufbauen (fuer Spreading Activation)
await saveStore(this.store);
console.log(`[NM] Extracted and saved ${newMems.length} memories`);
for(const m of newMems)console.log(`[NM]   -> [${m.type}] ${m.content.substring(0,80)}`);
}else{
console.log('[NM] No new memories extracted from this exchange');
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

// Vor Generation: relevante Memories abrufen
retrieveForMessage(message,chatMessages){
if(!this.settings.enabled||!this.store)return{context:'',hint:''};

// Themen aus letzten Nachrichten extrahieren fuer besseres Retrieval
const themes=chatMessages?extractConversationThemes(chatMessages):[];
const queryWithThemes=themes.length?message+' '+themes.join(' '):message;

const results=retrieveMemories(this.store,queryWithThemes,{
topK:this.settings.topK,
maxHops:this.settings.activationHops,
decayPerHop:0.5,
activationThreshold:this.settings.activationThreshold,
halfLifeHours:this.settings.halfLifeDays*24,
emotionFactor:this.settings.emotionFactor,
});

// Gepinnte Memories immer einschliessen (falls nicht bereits im Ergebnis)
const resultIds=new Set(results.map(r=>r.memory.id));
for(const m of Object.values(this.store.memories)){
if(m.pinned&&!resultIds.has(m.id)){
results.push({memory:m,score:1.0,activation:1.0,retrievability:m.retrievability});
}
}

if(!results.length)return{context:'',hint:''};

// Leichtes Reinforcement (accessCount+lastAccessed), volles Reinforcement kommt nach KI-Antwort
reinforceMemories(results);
this.lastInjected=results;

const context=formatMemoryContext(results,this.settings.maxContextTokens,this.store);
const hint=this.settings.proactivePrompt?buildDynamicHint(results,this.store):'';
if(themes.length)console.log('[NM] conversation themes:',themes.join(', '));
return{context,hint};
}

// Selective Reinforcement nach KI-Antwort
applySelectiveReinforcement(responseText){
if(!this.lastInjected.length||!responseText)return;
selectiveReinforce(this.lastInjected,responseText);
const used=this.lastInjected.filter(r=>r._used).length;
const total=this.lastInjected.length;
console.log(`[NM] selective reinforcement: ${used}/${total} memories were used by AI`);
}

// Statistiken
getStats(){
if(!this.store)return null;
const mems=Object.values(this.store.memories);
const ents=Object.values(this.store.entities);
return{
totalMemories:mems.length,
totalEntities:ents.length,
byType:{
episodic:mems.filter(m=>m.type==='episodic').length,
semantic:mems.filter(m=>m.type==='semantic').length,
emotional:mems.filter(m=>m.type==='emotional').length,
relational:mems.filter(m=>m.type==='relational').length,
},
bySubtype:{
person:mems.filter(m=>m.subtype==='person').length,
appearance:mems.filter(m=>m.subtype==='appearance').length,
plot:mems.filter(m=>m.subtype==='plot').length,
},
avgImportance:mems.length?mems.reduce((s,m)=>s+m.importance,0)/mems.length:0,
avgRetrievability:mems.length?mems.reduce((s,m)=>s+m.retrievability,0)/mems.length:0,
lastConsolidation:this.store.meta.lastConsolidation,
lastInjectedCount:this.lastInjected.length,
};
}

getLastInjected(){return this.lastInjected}

async save(){if(this.store)await saveStore(this.store)}
}

export function defaultSettings(){
return{
enabled:true,
topK:10,
maxContextTokens:500,
maxMemories:500,
extractEveryN:1,
extractContextMessages:4,
maxExtractPerExchange:5,
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
};
}
