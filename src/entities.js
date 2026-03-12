import{eid,now,tokenize}from'./utils.js';

// Regelbasierte Entity-Extraktion als Fallback
// Erkennt Eigennamen (Grossbuchstaben am Wortanfang, nicht am Satzanfang)
export function extractEntitiesFromText(text,knownEntities=[]){
const found=new Set;
// Bekannte Entities matchen
for(const e of knownEntities){
const names=[e.name,...(e.aliases||[])];
for(const n of names){
if(n.length>1&&text.toLowerCase().includes(n.toLowerCase()))found.add(e.name);
}}
// Eigennamen-Heuristik: Woerter mit Grossbuchstabe die nicht am Satzanfang stehen
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
mentionCount:1,connections:[]
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
