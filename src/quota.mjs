// Alive OS v0.01 — shared hay ledger. Internal server module; never expose its RPC routes publicly.
// Cloudflare SQLite-backed Durable Object, singleton name: aliveos-global-v0.01.
// All amounts are integer milli-Neurons (1 Neuron = 1000 units).
// Rates: https://developers.cloudflare.com/workers-ai/platform/pricing/ (checked 2026-11-26).
// Accounting is local and estimated, not Cloudflare's authoritative account meter.
export const VERSION = '0.01';
export const QUOTA = Object.freeze({ dailyNeurons: 9500, exchanges: 6, receiptNeurons: 400,
  receiptMaxOutput: 800, chatMaxOutput: 600, inputOverhead: 512, staleMs: 300000 });
export const RATES = Object.freeze({
  '@cf/google/gemma-4-26b-a4b-it': Object.freeze({input:9091, output:27273}),
});
const CAP = QUOTA.dailyNeurons * 1000, HOLD = QUOTA.receiptNeurons * 1000;
const validCount = n => Number.isSafeInteger(n) && n >= 0 && n <= 10000000;
const dayAt = now => new Date(now).toISOString().slice(0,10);
const resetAt = day => new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString();
const json = (data,status=200) => Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const idOK = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{32,128}$/.test(id);
const deny = (reason,status=429) => ({ok:false,reason,status});

export function usageUnits(model,input,output) {
  const rate = RATES[model];
  if (!rate || !validCount(input) || !validCount(output)) throw new Error('Unpriced model or invalid token counts');
  return Math.ceil((input*rate.input+output*rate.output)/1000);
}
// Conservative estimate for text-only requests: UTF-8 byte count + template overhead.
// Not an exact tokenizer or a guaranteed provider-side upper bound. Full prompt required.
export function reserveUnits(model,messages,maxOutput,kind='chat') {
  const ceiling = kind==='receipt' ? QUOTA.receiptMaxOutput : QUOTA.chatMaxOutput;
  if (!Array.isArray(messages) || messages.length<1 || messages.length>20 ||
      !Number.isInteger(maxOutput) || maxOutput<1 || maxOutput>ceiling ||
      messages.some(m=>!['system','user','assistant'].includes(m?.role)||typeof m.content!=='string'))
    throw new Error('Invalid inference envelope');
  const input = new TextEncoder().encode(JSON.stringify(messages)).length + QUOTA.inputOverhead;
  const units = usageUnits(model,input,maxOutput);
  if (units>CAP || (kind==='receipt' && units>HOLD)) throw new Error('Inference envelope exceeds reservation allowance');
  return units;
}
function actualUnits(call,usage) {
  // Missing/invalid usage: keep full reservation, including failed upstream requests.
  const i=usage?.prompt_tokens ?? usage?.input_tokens, o=usage?.completion_tokens ?? usage?.output_tokens;
  return validCount(i)&&validCount(o) ? usageUnits(call.model,i,o) : call.units;
}

// Pure ledger transitions, exported for deterministic local testing.
export function freshLedger(day) {return {day,spent:0,visitors:{},calls:{}};}
function totals(s) {
  let reserved=0, receiptReserved=0;
  for(const v of Object.values(s.visitors)) receiptReserved+=v.hold;
  for(const c of Object.values(s.calls)) if(c.state==='pending') reserved+=c.units;
  return {reserved,receiptReserved,available:Math.max(0,CAP-s.spent-reserved-receiptReserved)};
}
export function snapshot(s,visitor) {
  const v=s.visitors[visitor], t=totals(s);
  const round=n=>Math.floor(n)/1000;
  return {day:s.day, resets_at:resetAt(s.day), budget_neurons:QUOTA.dailyNeurons,
    spent_neurons:round(s.spent), pending_neurons:round(t.reserved), receipt_reserved_neurons:round(t.receiptReserved),
    hay_available:round(t.available), exchanges_used:v?.used||0,
    exchanges_remaining:v?.closed?0:Math.max(0,QUOTA.exchanges-(v?.used||0)),
    receipt_status:v?.receipt||'not_started', pending:!!v?.active, accounting:'local estimate; not provider balance'};
}
// A lost request is conservatively charged; never silently refund a possibly billable call.
export function sweep(s,now) {
  for(const c of Object.values(s.calls)) {
    if(c.state!=='pending'||now-c.started<QUOTA.staleMs)continue;
    const v=s.visitors[c.visitor]; s.spent+=c.units; c.state='expired'; c.charged=c.units;
    if(v.active===c.id)v.active=null;
    if(c.kind==='receipt'){v.closed=true;v.receipt='unavailable';}
    if(c.kind==='chat' && v.used>=QUOTA.exchanges && !v.successful){v.hold=0;v.closed=true;v.receipt='unavailable';}
  }
}
export function admit(s,{visitor,id,kind,model,units},now) {
  sweep(s,now);
  if(!idOK(visitor)||!idOK(id)||!['chat','receipt'].includes(kind)||!RATES[model]||
     !Number.isSafeInteger(units)||units<1||units>CAP) return deny('invalid_reservation',400);
  if(s.calls[id])return deny('duplicate_request',409);
  let v=s.visitors[visitor];
  if(v?.active)return deny('exchange_in_progress',409);
  if(kind==='chat'){
    if(v?.closed||v?.used>=QUOTA.exchanges)return deny('daily_exchange_limit');
    const extra=v?0:HOLD;
    if(units+extra>totals(s).available)return deny('hay_exhausted');
    if(!v)v=s.visitors[visitor]={used:0,successful:0,hold:HOLD,receipt:'reserved',closed:false,active:null};
    v.used++;
  } else {
    if(!v||v.successful<1||v.closed||v.receipt!=='reserved')return deny('receipt_not_available',409);
    if(units>v.hold)return deny('receipt_envelope_too_large',400);
    // Consume the held allowance rather than compete for remaining conversation hay.
    // Release surplus only after the receipt settles; one receipt per visitor/day.
    v.hold=0; v.receipt='pending';v.closed=true;
  }
  v.active=id;
  s.calls[id]={id,visitor,kind,model,units,started:now,state:'pending'};
  return {ok:true,id,day:s.day,quota:snapshot(s,visitor)};
}
export function settle(s,{id,visitor,success,usage}) {
  if(!idOK(id)||!idOK(visitor)||typeof success!=='boolean')return deny('invalid_settlement',400);
  const c=s.calls[id]; if(!c||c.visitor!==visitor)return deny('unknown_reservation',404);
  if(c.state==='settled')return {ok:true,duplicate:true,quota:snapshot(s,visitor)};
  const v=s.visitors[visitor]; const charged=actualUnits(c,usage);
  const expired=c.state==='expired';
  s.spent+=charged-(expired?c.charged:0); c.charged=charged;c.state='settled';
  if(v.active===id)v.active=null;
  // A failed model attempt still uses a turn: prevents unbounded paid retry loops.
  if(c.kind==='chat' && success)v.successful++;
  if(c.kind==='chat' && v.used>=QUOTA.exchanges && !v.successful){v.hold=0;v.closed=true;v.receipt='unavailable';}
  if(c.kind==='receipt')v.receipt=success?'complete':'unavailable';
  return {ok:true,charged_neurons:charged/1000,quota:snapshot(s,visitor)};
}

// DO owns only opaque visitor IDs and usage records, never questions or answers.
// Worker must use one global instance, derive visitor server-side, and call reserve/settle
// around EVERY paid inference. Do not trust client-supplied usage, model, IDs or costs.
// SQLite transactionSync serializes reservations across concurrent Worker invocations.
export class HayLedger {
  constructor(ctx,env) {
    this.ctx=ctx; this.sql=ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS ledger (day TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  }
  load(day){const r=this.sql.exec('SELECT payload FROM ledger WHERE day=?',day).toArray()[0];return r?JSON.parse(r.payload):freshLedger(day);}
  save(s){this.sql.exec('INSERT INTO ledger(day,payload) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET payload=excluded.payload',s.day,JSON.stringify(s));}
  async fetch(request){
    if(request.method!=='POST')return json(deny('method',405),405);
    const action=new URL(request.url).pathname;
    if(!['/reserve','/settle','/status'].includes(action))return json(deny('not_found',404),404);
    try{
      const body=await request.json(); if(!idOK(body?.visitor))return json(deny('invalid_visitor',400),400);
      const now=Date.now(),today=dayAt(now);
      const day=action==='/settle'?body.day:today;
      if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||day>today||day<dayAt(now-86400000))return json(deny('invalid_day',400),400);
      const result=this.ctx.storage.transactionSync(()=>{
        // Retain yesterday to settle requests crossing midnight; purge older opaque IDs.
        this.sql.exec('DELETE FROM ledger WHERE day<?',dayAt(now-86400000));
        const s=this.load(day); let result;
        if(action==='/reserve')result=admit(s,body,now);
        else if(action==='/settle')result=settle(s,body);
        else {sweep(s,now);result={ok:true,quota:snapshot(s,body.visitor)};}
        this.save(s); return result;
      });
      return json(result,result.status||200);
    }catch{return json(deny('ledger_unavailable',503),503);}
  }
}

// Server-side client wrappers. Required Wrangler binding: HAY_LEDGER, class HayLedger,
// SQLite migration new_sqlite_classes: ["HayLedger"]. Export class from worker.mjs.
async function rpc(env,action,body){
  try{
    const stub=env.HAY_LEDGER.get(env.HAY_LEDGER.idFromName('aliveos-global-v0.01'));
    const response=await stub.fetch('https://hay.internal/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return await response.json();
  }catch{return deny('ledger_unavailable',503);}
}
export async function reserveInference(env,{visitor,kind='chat',model,messages,maxOutput}){
  try{
    const units=reserveUnits(model,messages,maxOutput,kind),id=crypto.randomUUID();
    return await rpc(env,'reserve',{visitor,id,kind,model,units});
  }catch{return deny('unpriced_or_oversize_inference',400);}
}
export const settleInference=(env,{visitor,reservation,success,usage})=>rpc(env,'settle',{visitor,id:reservation.id,day:reservation.day,success,usage});
export const getQuota=(env,visitor)=>rpc(env,'status',{visitor});
