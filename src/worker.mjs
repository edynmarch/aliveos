// Alive OS / SENSDECIDE 3000 — Worker entry point v0.01.
// API-only Worker. No pilot key, no external web access.
// Required bindings: AI, HAY_LEDGER (HayLedger), SESSIONS (ConversationSession).
// Both DO classes require SQLite migrations. Markdown is bundled server-side as Text.
import runtime from '../runtime/alive-os.md';
import sourcebook from '../sourcebooks/S.md';
import receiptMarkdown from '../runtime/receipt-evaluation.md';
import {parseS} from './retrieve.mjs';
import {MODEL,LIMITS,readChatBody,prepareChat,inferChat} from './handler.mjs';
import {HayLedger,QUOTA,RATES,getQuota,reserveInference,settleInference} from './quota.mjs';
import {parseReceiptSpec,evaluateReceipt} from './receipt.mjs';
export {HayLedger};
export const VERSION='0.01';
const COOKIE='__Host-aliveos';
const VISITOR=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROUTES=new Map([['/api/status','GET'],['/api/chat','POST'],['/api/receipt','POST']]);
const dayAt=(now=Date.now())=>new Date(now).toISOString().slice(0,10);
const midnight=day=>Date.parse(day+'T00:00:00Z')+86400000;
const json=(data,status=200,headers={})=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const error=(message,status=400,extra={})=>json({error:message,...extra},status);
const modelFor=env=>typeof env.AI_MODEL==='string'&&env.AI_MODEL.trim()?env.AI_MODEL.trim():MODEL;
const configured=env=>typeof env.AI?.run==='function'&&!!env.HAY_LEDGER&&!!env.SESSIONS&&Object.hasOwn(RATES,modelFor(env));
let entries,receiptSpec;
function getEntries(){return entries??=parseS(sourcebook);}
function getSpec(){return receiptSpec??=parseReceiptSpec(receiptMarkdown);}
function visitorCookie(request){
  const matches=(request.headers.get('Cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(COOKIE+'='));
  if(matches.length!==1)return null;
  const id=matches[0].slice(COOKIE.length+1);return VISITOR.test(id)?id:null;
}
function cookie(id){return `${COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000`;}
function publicQuota(q){return q?.ok?q.quota:null;}
function denied(r){return error('The requested inference is unavailable.',r.status||429,{reason:r.reason});}

// A separate anonymous conversation object keeps the shared hay ledger free of transcripts.
// Active text is stored only until receipt completion/consumption or the next UTC midnight.
// The receipt (without original transcript) is cached until midnight for safe retrieval.
// Storage cleanup is best-effort at the alarm, with a day check on every request.
// Provider-side retention/backups are outside this application policy.
export class ConversationSession {
  constructor(ctx,env){this.ctx=ctx;this.env=env;this.busy=false;}
  async load(){
    const day=dayAt(), old=await this.ctx.storage.get('session');
    if(old?.day===day)return old;
    if(old)await this.ctx.storage.deleteAll();
    return {day,history:[],receipt:null};
  }
  async save(state){
    if(state.day!==dayAt()){await this.ctx.storage.deleteAll();return false;}
    await this.ctx.storage.setAlarm(midnight(state.day));
    await this.ctx.storage.put('session',state);return true;
  }
  async alarm(){
    if(this.busy){await this.ctx.storage.setAlarm(Date.now()+30000);return;}
    this.busy=true;
    try{const state=await this.ctx.storage.get('session');
      if(state?.day===dayAt())await this.ctx.storage.setAlarm(midnight(state.day));
      else await this.ctx.storage.deleteAll();
    }finally{this.busy=false;}
  }
  async fetch(request){
    const path=new URL(request.url).pathname,visitor=request.headers.get('X-Alive-Visitor')||'';
    if(!VISITOR.test(visitor)||!ROUTES.has(path)||request.method!==ROUTES.get(path))return error('Invalid internal request.',400);
    if(this.busy)return error('An exchange is already in progress.',409,{reason:'exchange_in_progress'});
    this.busy=true;
    try{
      const state=await this.load(), env=this.env;
      if(path==='/api/status'){
        const quota=await getQuota(env,visitor);
        if(!quota.ok)return denied(quota);
        return json({version:VERSION,model:modelFor(env),configured:configured(env),mode:'live; status does not test inference',
          quota:quota.quota,history_supported:true,history_mode:'server-recorded',quota_enforced:true,
          completed_exchanges:state.receipt?.exchanges??state.history.length/2,receipt:state.receipt?.receipt??null,privacy:'Anonymous active transcript until receipt or UTC day expiry; provider retention may differ.'});
      }
      if(!configured(env))return error('AI or resource bindings unavailable.',503);
      if(path==='/api/chat'){
        let body,prepared;
        try{
          body=await readChatBody(request);
          if(state.history.length>=QUOTA.exchanges*2)return error('Daily exchange limit reached.',429,{reason:'daily_exchange_limit'});
          // Ignore all supplied history, roles, model choices, costs and visitor IDs.
          prepared=prepareChat(body,runtime,getEntries(),{trustedHistory:state.history});
        }catch(e){return error(e.status?e.message:'Unable to prepare conversation.',e.status||500);}
        const model=modelFor(env);
        const reservation=await reserveInference(env,{visitor,kind:'chat',model,messages:prepared.messages,maxOutput:LIMITS.completionTokens});
        if(!reservation.ok)return denied(reservation);
        if(reservation.day!==state.day){
          await settleInference(env,{visitor,reservation,success:false,usage:null});
          return error('Daily allocation changed. Refresh the status.',409,{reason:'day_changed'});
        }
        const result=await inferChat(env,prepared);
        let success=result.status===200&&typeof result.data.answer==='string'&&result.data.answer.length<=LIMITS.assistantChars;
        // Never truncate an answer silently to make the evaluation transcript fit.
        if(result.status===200&&!success){result.status=502;result.data.error='Model response exceeded the conversation record limit.';delete result.data.answer;}
        const settlement=await settleInference(env,{visitor,reservation,success,usage:result.data.usage});
        if(!settlement.ok)return error('Inference accounting could not be confirmed.',503);
        if(success){
          state.history.push({role:'user',content:prepared.question},{role:'assistant',content:result.data.answer});
          if(!await this.save(state))return error('Daily allocation changed during inference. Refresh the status.',409,{reason:'day_changed'});
        }
        return json({...result.data,quota:settlement.quota,
          conversation:{completed_exchanges:state.history.length/2,history_mode:'server-recorded'},
          receipt:{status:settlement.quota.receipt_status,eligible:state.history.length>0&&settlement.quota.receipt_status==='reserved'}},result.status);
      }
      if(state.receipt)return json({...state.receipt,cached:true});
      if(!state.history.length)return error('No completed conversation to evaluate.',409,{receipt:{status:'unavailable'}});
      // Explicit receipt selection; never trust a transcript submitted by the browser.
      // Counter 001 is scoped to the anonymous visitor/day, not globally unique.
      const result=await evaluateReceipt(env,{spec:getSpec(),trustedHistory:state.history,visitor,counter:1});
      if(result.status===200){
        state.history=[];state.receipt=result.data;
        if(!await this.save(state))return error('Daily allocation changed during evaluation.',409,{reason:'day_changed'});
      }else{
        // A consumed evaluation cannot be retried; discard transcript if the ledger confirms closure.
        const q=result.data.quota??publicQuota(await getQuota(env,visitor));
        if(q&&['complete','unavailable'].includes(q.receipt_status)){
          state.history=[];await this.save(state);
        }
      }
      return json(result.data,result.status);
    }catch{return error('Conversation service temporarily unavailable.',503);}
    finally{this.busy=false;}
  }
}

export default {async fetch(request,env){
  const url=new URL(request.url),path=url.pathname;
  // API-only deployment: no game assets or internal source documents are served.
  if(path==='/'&&request.method==='GET')return json({service:'Alive OS',version:VERSION,configured:configured(env),model:modelFor(env),mode:'API only; status does not test inference',routes:['GET /api/status','POST /api/chat','POST /api/receipt']});
  if(!ROUTES.has(path))return error('Not found.',404);
  if(request.method!==ROUTES.get(path))return error('Method not allowed.',405);
  if(request.headers.get('Sec-Fetch-Site')==='cross-site'||(request.headers.has('Origin')&&request.headers.get('Origin')!==url.origin))return error('Same-origin requests only.',403);
  if(!configured(env))return error('Worker bindings or configured model unavailable.',503,{configured:false});
  let visitor=visitorCookie(request),newVisitor=false;
  if(!visitor){
    if(path!=='/api/status')return error('Initialize the anonymous session using /api/status first.',409,{reason:'session_required'});
    visitor=crypto.randomUUID();newVisitor=true;
  }
  try{
    const headers=new Headers();headers.set('X-Alive-Visitor',visitor);
    for(const key of ['Content-Type','Content-Length'])if(request.headers.has(key))headers.set(key,request.headers.get(key));
    const target=new Request('https://session.internal'+path,{method:request.method,headers,
      ...(request.method==='POST'&&request.body?{body:request.body,duplex:'half'}:{})});
    const response=await env.SESSIONS.get(env.SESSIONS.idFromName(visitor)).fetch(target);
    const outHeaders=new Headers(response.headers);
    outHeaders.set('Cache-Control','no-store');outHeaders.set('X-Content-Type-Options','nosniff');
    if(newVisitor)outHeaders.set('Set-Cookie',cookie(visitor));
    return new Response(response.body,{status:response.status,headers:outHeaders});
  }catch{return error('Worker session service unavailable.',503);}
}};
