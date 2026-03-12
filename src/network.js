import{clamp}from'./utils.js';

// Spreading Activation Network
// Nodes sind Memory- und Entity-IDs, Kanten kommen aus deren connections-Arrays

export function spreadingActivation(store,initialActivations,opts={}){
const{maxHops=3,decayPerHop=0.5,threshold=0.15}=opts;
const act=new Map(initialActivations);// id->activation

for(let hop=0;hop<maxHops;hop++){
const updates=new Map;
for(const[nodeId,activation]of act){
if(activation<threshold)continue;
// Sammle Verbindungen aus Memories und Entities
const node=store.memories[nodeId]||store.entities[nodeId];
if(!node||!node.connections)continue;
for(const conn of node.connections){
const spread=activation*conn.weight*decayPerHop;
if(spread<threshold*0.5)continue;
const cur=updates.get(conn.targetId)||0;
updates.set(conn.targetId,Math.max(cur,spread));
}}
// Merge Updates
let changed=false;
for(const[id,val]of updates){
const old=act.get(id)||0;
if(val>old){act.set(id,clamp(val));changed=true}
}
if(!changed)break;
}
return act;
}

// Verbindungen zwischen Memories aktualisieren basierend auf Entity-Overlap
export function updateMemoryConnections(store){
const mems=Object.values(store.memories);
const n=mems.length;
for(let i=0;i<n;i++){
const mi=mems[i];
// Verbindungen zu Entities
for(const eName of mi.entities){
const entId=Object.keys(store.entities).find(k=>{
const e=store.entities[k];
return e.name===eName||e.aliases.includes(eName);
});
if(entId){
const has=mi.connections.find(c=>c.targetId===entId&&c.type==='entity');
if(!has)mi.connections.push({targetId:entId,weight:0.8,type:'entity'});
}}
// Verbindungen zwischen Memories mit gemeinsamen Entities
for(let j=i+1;j<n;j++){
const mj=mems[j];
const shared=mi.entities.filter(e=>mj.entities.includes(e));
if(shared.length>0){
const w=clamp(shared.length*0.3,0.1,0.9);
const hasIJ=mi.connections.find(c=>c.targetId===mj.id&&c.type==='entity_overlap');
if(!hasIJ)mi.connections.push({targetId:mj.id,weight:w,type:'entity_overlap'});
const hasJI=mj.connections.find(c=>c.targetId===mi.id&&c.type==='entity_overlap');
if(!hasJI)mj.connections.push({targetId:mi.id,weight:w,type:'entity_overlap'});
}
// Temporale Naehe (innerhalb 5 Nachrichten)
if(mi.sourceMessageIds&&mj.sourceMessageIds){
const di=mi.sourceMessageIds[0]||0,dj=mj.sourceMessageIds[0]||0;
if(Math.abs(di-dj)<=5){
const tw=clamp(1-Math.abs(di-dj)*0.15,0.1,0.7);
const hasT=mi.connections.find(c=>c.targetId===mj.id&&c.type==='temporal');
if(!hasT)mi.connections.push({targetId:mj.id,weight:tw,type:'temporal'});
}}
}}
// Begrenze Verbindungen pro Node
for(const m of mems){
if(m.connections.length>30){
m.connections.sort((a,b)=>b.weight-a.weight);
m.connections=m.connections.slice(0,30);
}}
}
