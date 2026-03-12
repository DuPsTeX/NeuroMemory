const _S=Math.log,_F=Math.floor,_R=Math.random,_P=Math.pow,_E=Math.exp,_M=Math.max,_N=Math.min;
export function uid(){return'm_'+_F(_R()*0xFFFFFF).toString(16).padStart(6,'0')}
export function eid(n){return'e_'+n.toLowerCase().replace(/[^a-z0-9]/g,'_').slice(0,32)}
export function now(){return Date.now()}
export function hrs(ms){return ms/3600000}

// BM25
const K1=1.2,B=0.75,K=1;
export class BM25{
constructor(){this._d=[];this._dl=0;this._df=new Map;this._n=0}
add(id,tokens){
this._d.push({id,t:tokens,l:tokens.length});
this._n++;this._dl+=tokens.length;
const s=new Set(tokens);
for(const t of s)this._df.set(t,(this._df.get(t)||0)+1);
}
search(query,topK=10){
if(!this._n)return[];
const avgDl=this._dl/this._n,scores=new Map;
for(const q of query){
const df=this._df.get(q)||0;
const idf=_S((this._n-df+0.5)/(df+0.5)+K);
for(const doc of this._d){
const tf=doc.t.filter(t=>t===q).length;
const norm=tf*(K1+1)/(tf+K1*(1-B+B*(doc.l/avgDl)));
const sc=(scores.get(doc.id)||0)+idf*norm;
scores.set(doc.id,sc);
}}
return[...scores.entries()].sort((a,b)=>b[1]-a[1]).slice(0,topK).map(([id,score])=>({id,score}));
}
clear(){this._d=[];this._dl=0;this._df=new Map;this._n=0}
}

// Tokenizer
const STOP_WORDS=new Set(['der','die','das','ein','eine','und','oder','aber','in','auf','an','mit',
'von','zu','ist','hat','war','sind','wird','den','dem','des','ich','du','er','sie','es','wir',
'the','a','an','and','or','but','in','on','at','with','of','to','is','has','was','are','will',
'i','you','he','she','it','we','they','my','your','his','her','its','our','their',
'nicht','kein','keine','keinen','keinem','no','not','been','have','had','be','do','does','did',
'for','from','als','auch','so','da','dann','wenn','dass','ob','this','that','these','those']);

export function tokenize(text){
return text.toLowerCase()
.replace(/[^\p{L}\p{N}\s]/gu,' ')
.split(/\s+/)
.filter(w=>w.length>1&&!STOP_WORDS.has(w));
}

export function extractKeywords(text,maxK=15){
const tokens=tokenize(text);
const freq=new Map;
for(const t of tokens)freq.set(t,(freq.get(t)||0)+1);
return[...freq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,maxK).map(([w])=>w);
}

export function cosineSim(a,b){
const sa=new Set(a),sb=new Set(b);
let inter=0;
for(const x of sa)if(sb.has(x))inter++;
const denom=Math.sqrt(sa.size)*Math.sqrt(sb.size);
return denom?inter/denom:0;
}

export function clamp(v,lo=0,hi=1){return _M(lo,_N(hi,v))}
export function expDecay(t,stability,factor=720){return _E(-t/(stability*factor))}
