// Alive OS / SENSDECIDE 3000 — v0.01
// Deterministic Sourcebook S retrieval. No network calls, embeddings, or O+ dependency.
// Compatible with parseS(markdown) and retrieve(entries, question) from the original Worker.
// Optional: retrieve(entries, question, {history: [{role:'user',content:'...'}]}).
// History is supplied by the server; this module does not store conversations.

const ID = /\b(?:HG\.SB\.\d{2}\.\d{2}\.[A-Z]\d{3}|CA-\d{2})\b/gi;
const ids = s => [...new Set((s.match(ID)||[]).map(x=>x.toUpperCase()))];
const STOP = new Set(`a an the of in on to for is are it that this what how why when where can could would should do does did and or with from by as at be about me my i you your have has had was were will just explain please tell am been being their they them there these those our we us he she his her him hers its who whom which some any all much many also than then now very really always never every only still even too more most less not no so if but because out up down get got getting thing things something someone people person say says said feel feeling feels think know want need make made use using like way going go good bad one two`.split(/\s+/));
const norm = s => s.toLowerCase().normalize('NFKC').replace(/[‘’]/g,"'");
function stem(w) {
  if(w.length>5 && w.endsWith('ies')) return w.slice(0,-3)+'y';
  if(w.length>6 && w.endsWith('ing')) return w.slice(0,-3).replace(/([b-df-hj-np-tv-z])\1$/,'$1');
  if(w.length>5 && w.endsWith('ed')) return w.slice(0,-2).replace(/([b-df-hj-np-tv-z])\1$/,'$1');
  if(w.length>4 && w.endsWith('s')&&!w.endsWith('ss')) return w.slice(0,-1);
  return w;
}
const tokens = s => (norm(s).match(/[a-z][a-z0-9]*/g)||[]).filter(w=>w.length>2&&!STOP.has(w)).map(stem);
const unique = s => [...new Set(tokens(s))];
const cache = new WeakMap();
const H = /^(#{1,6})\s+(.+)$/gm;
const FIELD = /^\*\*(Definition|Mechanism(?: and use)?|Use(?: and boundary)?|Boundary(?: and counterexample)?|Recognition conditions|Emergent distinction|Explanation)\.\*\*/im;

// Source-grounded editorial recognition cues. These are retrieval hints, never diagnoses.
// Each group must match at least one pattern; all groups in a route must match.
// IDs are validated against the actual parsed book. Broader coverage comes from the text index.
const ROUTES = [
 {g:[/exhaust|burn(?:ed|t)? out|burnout|overwork|overwhelm|drain|can.t (?:keep|sustain)|struggl/,/prais|reliab|competent|doing (?:fine|great|well)|depend on me|boss|manager|workload|everyone thinks/],i:['HG.SB.01.02.B010','HG.SB.01.02.B004','HG.SB.02.04.D004']},
 {g:[/always|only|never|every time|first|one who|all the effort/,/reach(?:es|ing)? out|text(?:ing|s)?|message|contact|initiat|check(?:s|ing)? in|friendship|arrang(?:e|ing) (?:visits|plans)/],i:['HG.SB.02.04.B007','HG.SB.02.04.G003']},
 {g:[/lonel|isolat|left out|belong|invisible|disconnected|unseen/,/friend|partner|relationship|family|group|marriage|husband|wife|together/],i:['HG.SB.02.04.C003','HG.SB.02.04.A006','HG.SB.02.04.B007']},
 {g:[/apolog|sorry|promise/,/again|repeat|keep|nothing chang|same thing|no change|still happen/],i:['HG.SB.02.04.D002','HG.SB.02.06.H002','HG.SB.02.06.H003']},
 {g:[/owe|guilt|obligat|indebt|ungrateful|selfish/,/help|gift|care|friend|family|partner|parent|say no|refus/],i:['HG.SB.02.04.G001','HG.SB.02.04.G002','HG.SB.02.04.G003']},
 {g:[/no reply|not repl(?:y|ied)|hasn.t (?:texted|responded|replied)|won.t (?:text|respond|reply)|silence|silent|ignored|left on read|didn.t (?:text|respond|reply)/,/friend|partner|text|message|relationship|angry|hate|care|think/],i:['HG.SB.02.04.D005','HG.SB.01.02.D004']},
 {g:[/prov(?:e|ing) myself|prove my worth|prove i|need to prove|constant proof/,/work|boss|manager|job|performance|approval/],i:['HG.SB.01.02.C008','HG.SB.02.05.C003','HG.SB.02.06.C001']},
 {g:[/misunderstood|misread|don.t understand me|doesn.t understand me|nobody understands|see what i do|never listen|not heard/],i:['HG.SB.01.01.B003','HG.SB.01.01.B005']},
 {g:[/used to be|old version of me|still see me|changed but|treat me like|who i used to/],i:['HG.SB.02.01.D006','HG.SB.01.01.B003']},
 {g:[/lazy|my fault|bad at|personal failure|incompetent|not good enough/,/workload|job|boss|system|rules|staff|resources|too much|exhaust|overwork|shift/],i:['HG.SB.02.05.D004','HG.SB.02.06.I001','HG.SB.01.02.B004']},
 {g:[/can.t afford|cannot afford|no time|no money|no transport|can.t leave|can.t take time|can.t access|not enough time/],i:['HG.SB.02.03.A003','HG.SB.01.02.B004']},
 {g:[/case (?:is |was |marked )?closed|ticket|complaint|referral|portal|application|denial|appeal/,/still|nothing chang|can.t|cannot|no one|no help|unable|unresolved|no authority/],i:['HG.SB.02.06.H002','HG.SB.02.06.H007','CA-29']},
 {g:[/explain|understand|report|know why/,/no authority|can.t fix|cannot fix|nothing changes|no one can|no power|who can change/],i:['HG.SB.02.06.H007','CA-30']},
 {g:[/help|support|advice|care/,/wrong kind|don.t need|doesn.t help|not what i need|makes it worse|not listening/],i:['HG.SB.02.04.A006','HG.SB.02.04.A005','HG.SB.02.04.D003']},
 {g:[/keep (?:explaining|repeating|telling)|repeat myself|over and over|same information/,/form|office|system|service|support|ai|chatbot|assistant|department/],i:['HG.SB.02.06.G002','HG.SB.02.06.B003','HG.SB.02.06.H008']},
 {g:[/clutter|messy room|messy house|piles of|mess at home/],i:['HG.SB.02.03.B005','HG.SB.02.03.B003']},
 {g:[/take (?:a |some )?time|need space|process (?:it|things)|respond immediately|reply immediately/,/partner|friend|relationship|argument|family|text/],i:['HG.SB.02.04.E001','HG.SB.02.04.E004']},
 {g:[/trust|promise|rely|reliable/,/proof|record|institution|company|service|public|evidence/],i:['HG.SB.01.03.D006','HG.SB.01.03.B001']},
];

export function parseS(markdown) {
 if(typeof markdown!=='string') throw new TypeError('Sourcebook S must be Markdown text');
 const headings=[...markdown.matchAll(H)];
 const entries=[]; let domain='',family='',inAppendix=false;
 for(let j=0;j<headings.length;j++){
  const h=headings[j], level=h[1].length, title=h[2].trim();
  if(level===2){inAppendix=/^Constellations Appendix\b/i.test(title);domain='';family='';}
  if(level===3&&/^Domain \d{2}\.\d{2}/.test(title)){domain=title.replace(/^Domain /,'');family='';}
  if(level===4&&/^Family \d{2}\.\d{2}\.[A-Z]/.test(title))family=title.replace(/^Family /,'');
  const m=level===5?title.match(/^(HG\.SB\.\d{2}\.\d{2}\.[A-Z]\d{3}) — (.+)$/):level===4&&inAppendix?title.match(/^(CA-\d{2}) — (.+)$/):null;
  if(!m)continue;
  const text=markdown.slice(h.index+h[0].length,headings[j+1]?.index??markdown.length).trim().replace(/\n\s*---\s*$/,'').trim();
  const constellation=m[1].startsWith('CA-');
  const related=constellation?ids((text.match(/\*\*Related concepts\.\*\*[^\n]*/i)||[])[0]||''):ids([...text.matchAll(/^Related:\s*(.+)$/gm)].map(x=>x[1]).join(' '));
  const contributing=constellation?ids((text.match(/\*\*Contributing concepts\.\*\*([\s\S]*?)(?=\n\*\*Mechanism\.\*\*|$)/i)||[])[1]||''):[];
  const relatedConstellations=constellation?ids((text.match(/\*\*Related constellations\.\*\*[^\n]*/i)||[])[0]||''):[];
  entries.push({id:m[1],title:m[2],text,domain:constellation?'':domain,family:constellation?'':family,related,contributing,relatedConstellations});
 }
 if(new Set(entries.map(e=>e.id)).size!==entries.length)throw new Error('Duplicate Sourcebook S record identifiers');
 return entries;
}
function index(entries){
 if(cache.has(entries))return cache.get(entries);
 const byId=new Map(),postings=new Map(),docLen=new Map(),reverse=new Map(); let total=0;
 for(const e of entries){
  byId.set(e.id,e);
  const words=tokens(e.text.replace(/^Related:.*$/gm,''));
  const tf=new Map(); for(const w of words)tf.set(w,(tf.get(w)||0)+1);
  const titles=new Set(unique(e.title)), families=new Set(unique(e.family+' '+e.domain));
  const len=Math.max(1,words.length);docLen.set(e.id,len);total+=len;
  for(const w of new Set([...tf.keys(),...titles,...families])){
   if(!postings.has(w))postings.set(w,[]);
   postings.get(w).push({id:e.id,tf:tf.get(w)||0,title:titles.has(w),family:families.has(w)});
  }
  for(const id of [...e.contributing,...e.related]){
   if(e.id.startsWith('CA-')){if(!reverse.has(id))reverse.set(id,[]);reverse.get(id).push(e.id);}
  }
 }
 const ix={byId,postings,docLen,reverse,avg:total/Math.max(1,entries.length),n:entries.length};
 cache.set(entries,ix);return ix;
}
function lexical(ix,query,weight,scores){
 for(const w of unique(query).slice(0,80)){
  const ps=ix.postings.get(w);if(!ps)continue;
  const idf=Math.log(1+(ix.n-ps.length+.5)/(ps.length+.5));
  for(const p of ps){
   const tf=p.tf, len=ix.docLen.get(p.id);
   const body=tf?tf*2.2/(tf+1.2*(.35+.65*len/ix.avg)):0;
   const add=weight*idf*(body+3.2*Number(p.title)+.35*Number(p.family));
   scores.set(p.id,(scores.get(p.id)||0)+add);
  }
 }
}
function extract(e,budget){
 if(e.text.length<=budget)return {text:e.text,truncated:false};
 // Retain actual paragraphs, prioritizing definition, mechanism, recognition, and boundary.
 const paragraphs=e.text.split(/\n\s*\n/).filter(Boolean);
 const candidates=paragraphs.map((p,i)=>({p,i,priority:FIELD.test(p)?(/Boundary|Recognition conditions|Definition|Mechanism/.test(p.slice(0,70))?4:3):i===0?4:i===1?3:/^Related|^\*\*Related|^\*\*Applied example/.test(p)?0:1}));
 // Keep a field heading with its next paragraph when the heading is standalone.
 for(let i=0;i<candidates.length-1;i++)if(/^\*\*[^*]+\*\*\s*$/.test(candidates[i].p))candidates[i+1].priority=Math.max(candidates[i+1].priority,candidates[i].priority);
 const picked=[];let used=0;const marker='\n\n[Sourcebook excerpt; omitted passages remain in S.md.]';
 for(const c of candidates.sort((a,b)=>b.priority-a.priority||a.i-b.i)){
  if(used+c.p.length+2<=budget-marker.length){picked.push(c);used+=c.p.length+2;}
 }
 if(!picked.length){const end=e.text.lastIndexOf('. ',budget-marker.length-2);return {text:e.text.slice(0,end>100?end+1:budget-marker.length)+marker,truncated:true};}
 return {text:picked.sort((a,b)=>a.i-b.i).map(x=>x.p).join('\n\n')+marker,truncated:true};
}

export function retrieve(entries,question,options={}){
 if(typeof question!=='string'||!question.trim()||!entries.length)return [];
 const ix=index(entries), q=norm(question).trim();
 const explicit=ids(question).filter(id=>ix.byId.has(id));
 // Exact IDs override general ranking; no unsolicited graph expansion for explicit lookups.
 const exactTitles=entries.filter(e=>q===norm(e.title)||q.includes('explain '+norm(e.title))||q.includes('define '+norm(e.title))).map(e=>e.id);
 const exact=[...new Set([...explicit,...exactTitles])];
 if(!exact.length&&/^(?:hi|hello|hey|thanks|thank you|ok|okay|yes|no|bye|good morning|good night)[.!?\s]*$/.test(q))return [];
 const scores=new Map(), cue=new Map();
 const currentTerms=unique(q);
 const matched=new Map();
 for(const w of currentTerms.slice(0,80))for(const p of ix.postings.get(w)||[])if(p.tf||p.title)matched.set(p.id,(matched.get(p.id)||0)+1);
 lexical(ix,q,1,scores);
 // Use only recent user turns, and only for a dependent follow-up. Current corrections win.
 const dependent=/^(?:and|but|so|what about|what if|then|how (?:can|do|should|would) i|why (?:does|is|would)|they|he|she|it|that|this)\b/.test(q)&&unique(q).length<=18;
 const correction=/\b(?:actually|i meant|not what i meant|correction|instead|different topic|forget that)\b/.test(q);
 const history=dependent&&!correction&&Array.isArray(options.history)?options.history.filter(m=>m?.role==='user'&&typeof m.content==='string').slice(-2).map(m=>m.content.slice(0,1600)):[];
 for(const prior of history)lexical(ix,prior,.18,scores);
 const cueText=[...history,q].join(' ');
 for(const route of ROUTES){
  const current=route.g.every(r=>r.test(q));
  if(!current&&(!history.length||!route.g.every(r=>r.test(cueText))))continue;
  route.i.forEach((id,j)=>{if(ix.byId.has(id)){const boost=(current?24:9)-j*3;cue.set(id,Math.max(cue.get(id)||0,boost));}});
 }
 for(const [id,boost] of cue)scores.set(id,(scores.get(id)||0)+boost);
 const ranked=[...scores].filter(([id,s])=>s>=5.5&&(cue.has(id)||(matched.get(id)||0)>=2||(currentTerms.length===1&&norm(ix.byId.get(id).title).includes(q)))).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
 const chosen=exact.slice(0,3);
 if(!chosen.length&&ranked.length){
  const top=ranked[0][1];
  for(const [id,score] of ranked){
   if(chosen.length>=3||score<Math.max(5.5,top*.48))break;
   if(cue.size&&!cue.has(id)&&score<top*.82)continue;
   if(chosen.length&&id.endsWith('000')&&chosen.some(c=>c.startsWith(id.slice(0,-3))))continue;
   chosen.push(id);
  }
  // One extra relation at most. Prefer a constellation with multiple independently
  // selected supporting entries, or a directly linked high-relevance record.
  const graph=new Map();
  for(const id of chosen){const e=ix.byId.get(id);for(const link of [...e.related,...e.contributing,...e.relatedConstellations,...(ix.reverse.get(id)||[])]){if(!chosen.includes(link)&&ix.byId.has(link))graph.set(link,(graph.get(link)||0)+1);}}
  const extension=[...graph].map(([id,n])=>({id,n,score:scores.get(id)||0})).filter(x=>x.score>=Math.max(6,top*.36)||(x.n>=2&&x.score>=3)).sort((a,b)=>b.score+b.n*3-a.score-a.n*3||a.id.localeCompare(b.id))[0];
  if(extension&&chosen.length<4)chosen.push(extension.id);
 }
 // Bounded reference payload, independent of the model's conversational output limit.
 const maxChars=Math.min(7200,Math.max(1800,Number.isFinite(options.maxChars)?Math.floor(options.maxChars):6400));
 let remaining=maxChars; const out=[];
 for(let j=0;j<chosen.length;j++){
  const e=ix.byId.get(chosen[j]); const overhead=e.id.length+e.title.length+48;
  const budget=Math.min(3000,Math.floor((remaining-overhead)/(chosen.length-j)));
  if(budget<350)break;
  const excerpt=extract(e,budget);out.push({id:e.id,title:e.title,...excerpt});remaining-=excerpt.text.length+overhead;
 }
 return out;
}
