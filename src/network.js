import{clamp}from'./utils.js';

// Spreading Activation Network — UNVERAENDERT, arbeitet auf beliebigen Nodes mit connections[]
export function spreadingActivation(store,initialActivations,opts={}){
const{maxHops=3,decayPerHop=0.5,threshold=0.15}=opts;
const act=new Map(initialActivations);

for(let hop=0;hop<maxHops;hop++){
const updates=new Map;
for(const[nodeId,activation]of act){
if(activation<threshold)continue;
const node=store.entities[nodeId];
if(!node||!node.connections)continue;
for(const conn of node.connections){
const spread=activation*conn.weight*decayPerHop;
if(spread<threshold*0.5)continue;
const cur=updates.get(conn.targetId)||0;
updates.set(conn.targetId,Math.max(cur,spread));
}}
let changed=false;
for(const[id,val]of updates){
const old=act.get(id)||0;
if(val>old){act.set(id,clamp(val));changed=true}
}
if(!changed)break;
}
return act;
}

// Entity-Verbindungen aktualisieren basierend auf Slot-relatedEntities + Co-Occurrence
export function updateEntityConnections(store){
const ents=Object.values(store.entities);
const n=ents.length;

// Verbindungen aus relatedEntities in Slot-Eintraegen
for(const ent of ents){
for(const slot of Object.values(ent.slots)){
if(slot.mode!=='ARRAY')continue;
for(const entry of slot.entries){
if(!entry.relatedEntities?.length)continue;
for(const relName of entry.relatedEntities){
// Entity-ID finden
const relEnt=ents.find(e=>e.name.toLowerCase()===relName.toLowerCase()||
e.aliases.some(a=>a.toLowerCase()===relName.toLowerCase()));
if(!relEnt||relEnt.id===ent.id)continue;
const has=ent.connections.find(c=>c.targetId===relEnt.id);
if(has){has.weight=Math.min(1,has.weight+0.05)}
else ent.connections.push({targetId:relEnt.id,weight:0.4,type:'slot_ref'});
}
}
}
}

// Begrenzen
for(const e of ents){
if(e.connections.length>30){
e.connections.sort((a,b)=>b.weight-a.weight);
e.connections=e.connections.slice(0,30);
}
}
}
