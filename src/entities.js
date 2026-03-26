import{eid,now,tokenize}from'./utils.js';

// ============================================================
// Entity-Schema-Registry: definiert Typen und Slots
// ============================================================
export const ENTITY_SCHEMAS={
person:{
profile:{mode:'SINGLE',label:'Profil',desc:'Name, Rolle, Level, HP, MP, Klasse, Faehigkeiten'},
appearance:{mode:'SINGLE',label:'Aussehen',desc:'Physische Beschreibung'},
personality:{mode:'SINGLE',label:'Persoenlichkeit',desc:'Charakterzuege, Vorlieben, Eigenheiten'},
wisdom:{mode:'SINGLE',label:'Weisheit',desc:'Was der Charakter gelernt hat (auto-generiert)'},
relations:{mode:'ARRAY',label:'Beziehungen',desc:'Beziehungen zu anderen Entities'},
emotions:{mode:'ARRAY',label:'Emotionen',desc:'Emotional bedeutsame Erlebnisse'},
plot:{mode:'ARRAY',label:'Story',desc:'Plot-Ereignisse mit dieser Person'},
sexual:{mode:'ARRAY',label:'Intimitaet',desc:'Intime Aktivitaeten'},
notes:{mode:'ARRAY',label:'Notizen',desc:'Sonstige Fakten'},
},
location:{
description:{mode:'SINGLE',label:'Beschreibung',desc:'Aussehen, Atmosphaere, Lage'},
management:{mode:'SINGLE',label:'Leitung',desc:'Wer den Ort betreibt/kontrolliert'},
inventory:{mode:'ARRAY',label:'Inventar',desc:'Was es dort gibt/zu kaufen'},
plot:{mode:'ARRAY',label:'Story',desc:'Ereignisse an diesem Ort'},
notes:{mode:'ARRAY',label:'Notizen',desc:'Sonstige Fakten'},
},
item:{
description:{mode:'SINGLE',label:'Beschreibung',desc:'Aussehen, Eigenschaften'},
abilities:{mode:'SINGLE',label:'Faehigkeiten',desc:'Magische/spezielle Faehigkeiten'},
owner:{mode:'SINGLE',label:'Besitzer',desc:'Aktueller Besitzer/Traeger'},
plot:{mode:'ARRAY',label:'Story',desc:'Geschichte des Gegenstands'},
notes:{mode:'ARRAY',label:'Notizen',desc:'Sonstige Fakten'},
},
faction:{
description:{mode:'SINGLE',label:'Beschreibung',desc:'Was die Fraktion ist'},
members:{mode:'ARRAY',label:'Mitglieder',desc:'Bekannte Mitglieder'},
plot:{mode:'ARRAY',label:'Story',desc:'Ereignisse'},
notes:{mode:'ARRAY',label:'Notizen',desc:'Sonstige Fakten'},
},
concept:{
description:{mode:'SINGLE',label:'Beschreibung',desc:'Was es ist'},
notes:{mode:'ARRAY',label:'Notizen',desc:'Details, Regeln'},
},
};

// Slots die IMMER injiziert werden (Identitaets-Kern), Rest ist kontextuell
export const ALWAYS_SLOTS={
person:new Set(['profile']),
location:new Set(['description']),
item:new Set(['description','owner']),
faction:new Set(['description']),
concept:new Set(['description']),
};

// ============================================================
// Memory Tiers: Core > Significant > Episodic
// ============================================================
export const MEMORY_TIERS={core:'core',significant:'significant',episodic:'episodic'};
export const TIER_LABELS={core:'CORE',significant:'SIG',episodic:'EPI'};
export const TIER_COLORS={core:'#ff6b6b',significant:'#ffd93d',episodic:'#6bcb77'};

export function computeTier(entry,settings={}){
const imp=entry.importance||0;
const emo=entry.emotionalIntensity||0;
const stab=entry.stability||1;
const acc=entry.accessCount||0;
const coreImp=settings.coreImportanceThreshold||0.85;
const sigImp=settings.significantImportanceThreshold||0.6;
if(entry.pinned||entry.userCreated)return'core';
if(imp>=coreImp||emo>=0.8||stab>=5.0)return'core';
if(imp>=sigImp||emo>=0.5||stab>=2.5||acc>=5)return'significant';
return'episodic';
}

export const ENTITY_TYPE_ICONS={person:'👤',location:'📍',item:'🗡️',faction:'⚔️',concept:'📚'};
export const ENTITY_TYPE_LABELS={person:'Person',location:'Ort',item:'Gegenstand',faction:'Fraktion',concept:'Konzept'};

export function validEntityTypes(){return Object.keys(ENTITY_SCHEMAS)}

export function getSlotSchema(entityType,slotName){
const schema=ENTITY_SCHEMAS[entityType];
return schema?schema[slotName]||null:null;
}

export function getSlotNames(entityType){
const schema=ENTITY_SCHEMAS[entityType];
return schema?Object.keys(schema):[];
}

// Erstellt leere Slot-Objekte nach Schema
export function initSlots(entityType){
const schema=ENTITY_SCHEMAS[entityType];
if(!schema)return{};
const slots={};
for(const[name,def]of Object.entries(schema)){
if(def.mode==='SINGLE'){
slots[name]={mode:'SINGLE',value:null,keywords:[],importance:0,stability:1.0,retrievability:1.0,
emotionalValence:0,emotionalIntensity:0,updatedAt:0,accessCount:0,lastAccessedAt:0,lastReinforcedAt:0,
pinned:false,userCreated:false,tier:'episodic'};
}else{
slots[name]={mode:'ARRAY',entries:[]};
}}
return slots;
}

// Leeren Slot-Eintrag fuer ARRAY erstellen
export function createSlotEntry(content,opts={}){
const t=now();
return{
id:'s_'+Math.floor(Math.random()*0xFFFFFF).toString(16).padStart(6,'0'),
content:content.slice(0,500),
keywords:opts.keywords||[],
importance:opts.importance||0.5,
stability:opts.stability||1.0,
retrievability:1.0,
emotionalValence:opts.emotionalValence||0,
emotionalIntensity:opts.emotionalIntensity||0,
createdAt:t,updatedAt:t,accessCount:0,lastAccessedAt:t,lastReinforcedAt:t,
sourceMessageIds:opts.sourceMessageIds||[],
pinned:opts.pinned||false,
userCreated:opts.userCreated||false,
relatedEntities:opts.relatedEntities||[],
tier:opts.tier||'episodic',
sequenceIndex:opts.sequenceIndex||0,
storyArc:opts.storyArc||null,
};
}

// ============================================================
// Entity-Funktionen (teilweise aus v1 uebernommen)
// ============================================================

// Regelbasierte Entity-Extraktion (Fallback, kein LLM)
export function extractEntitiesFromText(text,knownEntities=[]){
const found=new Set;
for(const e of knownEntities){
const names=[e.name,...(e.aliases||[])];
for(const n of names){
if(n.length>1&&text.toLowerCase().includes(n.toLowerCase()))found.add(e.name);
}}
// Eigennamen-Heuristik
const sentences=text.split(/[.!?]+/);
for(const s of sentences){
const words=s.trim().split(/\s+/);
for(let i=1;i<words.length;i++){
const w=words[i].replace(/[^a-zA-ZäöüÄÖÜß]/g,'');
if(w.length>1&&/^[A-ZÄÖÜ]/.test(w)&&!/^(Der|Die|Das|Ein|Eine|Und|Oder|Aber|Ich|Du|Er|Sie|Es|Wir|The|And|But|For|With|This|That|They|Then|When|What|How|Who|Where|Why|Yes|No|Not|His|Her|Its|Our|Your|My)$/.test(w)){
found.add(w);
}}}
return[...found];
}

export function createEntityNode(name,charId,type='concept'){
return{
id:eid(name),name,aliases:[],type,
characterId:charId,
firstSeen:now(),lastSeen:now(),
mentionCount:1,
connections:[],
slots:initSlots(type),
};
}

export function updateEntityMention(entity){
entity.lastSeen=now();
entity.mentionCount++;
}

export function addEntityAlias(entity,alias){
if(!entity.aliases.includes(alias))entity.aliases.push(alias);
}

export function connectEntities(store,id1,id2,relType='related',weight=0.5){
const e1=store.entities[id1],e2=store.entities[id2];
if(!e1||!e2)return;
const ex1=e1.connections.find(c=>c.targetId===id2);
if(ex1){ex1.weight=Math.min(1,ex1.weight+0.1)}
else e1.connections.push({targetId:id2,weight,type:relType});
const ex2=e2.connections.find(c=>c.targetId===id1);
if(ex2){ex2.weight=Math.min(1,ex2.weight+0.1)}
else e2.connections.push({targetId:id1,weight,type:relType});
}
