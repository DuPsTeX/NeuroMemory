// ============================================================
// Timeline & Story-Arcs: Temporale Ordnung und Kontext
// ============================================================

// Zeitlinie fuer eine Entity abrufen (chronologisch sortierte Plot-Entries)
export function getTimeline(entity,slotName='plot'){
const slot=entity.slots[slotName];
if(!slot||slot.mode!=='ARRAY'||!slot.entries.length)return[];
return[...slot.entries].sort((a,b)=>(a.sequenceIndex||a.createdAt||0)-(b.sequenceIndex||b.createdAt||0));
}

// Vorherige Events im selben Slot finden (Kausal-Kontext)
export function findPrecedingEvents(entity,slotName,entry,windowSize=2){
const timeline=getTimeline(entity,slotName);
const idx=timeline.findIndex(e=>e.id===entry.id);
if(idx<=0)return[];
return timeline.slice(Math.max(0,idx-windowSize),idx);
}

// Story-Arcs aus einem Slot extrahieren (gruppiert nach storyArc)
export function getStoryArcs(entity,slotName='plot'){
const timeline=getTimeline(entity,slotName);
const arcs=new Map;// arcName → entries[]
const unassigned=[];
for(const entry of timeline){
if(entry.storyArc){
if(!arcs.has(entry.storyArc))arcs.set(entry.storyArc,[]);
arcs.get(entry.storyArc).push(entry);
}else{
unassigned.push(entry);
}
}
return{arcs,unassigned};
}

// Naechsten sequenceIndex fuer einen Slot berechnen
export function nextSequenceIndex(entity,slotName){
const slot=entity.slots[slotName];
if(!slot||slot.mode!=='ARRAY'||!slot.entries.length)return 1;
return Math.max(...slot.entries.map(e=>e.sequenceIndex||0))+1;
}

// Temporales Fenster: Wenn ein Entry gescored wird, vorherige mitliefern
export function getTemporalContext(entity,scoredEntries,windowSize=2){
const extra=[];
const seenIds=new Set(scoredEntries.map(e=>e.id));
for(const scored of scoredEntries){
// Finde in welchem Slot der Entry ist
for(const[slotName,slot]of Object.entries(entity.slots)){
if(slot.mode!=='ARRAY')continue;
if(!slot.entries.some(e=>e.id===scored.id))continue;
const preceding=findPrecedingEvents(entity,slotName,scored,windowSize);
for(const prev of preceding){
if(!seenIds.has(prev.id)){
extra.push(prev);
seenIds.add(prev.id);
}
}
break;// Gefunden, nicht weiter suchen
}
}
return extra;
}
