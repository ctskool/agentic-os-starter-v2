import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from '../shared/contract.mjs';
import {writeJson} from './core.mjs';
import {projectRoot} from './runtime.mjs';
import {openIntentGiven,resolveOpenStrict,strictOpenRouted,validateStrictOpen} from './voice-targets.mjs';
import {parseUiIntent,sameUiAction} from './voice-ui-intent.mjs';
import {trackOwnedWork,ownedWorkDraining} from './jev.mjs';

// Strict local rules: "open this one file" and "this one workspace command",
// decided by code alone at the very end of the rules layer, right before a
// model would be asked. Every spoken word must be explained, names match
// literally, exactly one file may qualify, and a validator accepts the finished
// action before it is returned. Anything else is a refusal with a reason, and
// the request continues exactly as before. No model and no network is involved.
// Off (the default) runs none of this; shadow only records, after the answer.
export const STRICT_MODES=['off','shadow','on'];
export const STRICT_KINDS=['open','ui'];
export const STRICT_BUDGET_MS=100;
export const STRICT_RULE={open:'router.strictOpen',ui:'router.strictUi'};
const PROVEN=new Set(Object.values(STRICT_RULE));

// The switch has a file of its own beside the Jev config and is read on every
// request. Missing file, unreadable JSON and unknown values all mean off.
export function readStrictConfig({env=process.env,file=path.join(projectRoot,'.runtime','voice-strict.json'),read=target=>JSON.parse(fs.readFileSync(target,'utf8'))}={}){
 if(env.NODE_TEST_CONTEXT&&env===process.env)return {open:'off',ui:'off'};
 let saved={};try{saved=read(file)||{}}catch{}
 return Object.fromEntries(STRICT_KINDS.map(kind=>[kind,typeof saved==='object'&&!Array.isArray(saved)&&STRICT_MODES.includes(saved[kind])?saved[kind]:'off']));
}

/** An earlier exchange the model would be shown is harmless only when it was a
 * plain command: rules decided it, nothing was dispatched, no question is left
 * open, and EITHER its receipt records that these strict rules took the action
 * (proof made at the time) OR the closed UI grammar explains its sentence word
 * for word. "A rule answered it" proves nothing: keyword rules answer sentences
 * they only partly read. An open lead proves nothing either: it accepts any
 * words after it. */
export function plainCommand(exchange,tables={}){
 if(!exchange||exchange.tier!==1||exchange.pendingSkill||exchange.lookupRoute==='clarification')return false;
 if(PROVEN.has(exchange.rule))return true;
 return !parseUiIntent(String(exchange.you||''),{conversationSelected:false,tables}).refused;
}

/** The first reason these rules must stay out of the way, or null. The strict
 * rules read one sentence; the model reads the sentence and the conversation.
 * They act only when the model would have been shown no conversation at all
 * other than earlier plain commands. */
export function strictGuard({excluded=[],newConversation=false,explicitWork=false,workHistory=false,workTarget=null,exchanges=[],tables={}}={}){
 if(excluded.length)return `excluded:${excluded[0]}`;
 if(newConversation)return 'new-conversation';
 if(explicitWork)return 'explicit-work';
 // For these sentences the model is also shown summaries of unselected work.
 if(workHistory)return 'work-history';
 // A selected conversation's request and last turns reach the model at any age.
 if(workTarget)return 'frame:selected';
 if(exchanges.some(exchange=>!plainCommand(exchange,tables)))return 'frame:history';
 return null;
}

/** What the strict checks make of one sentence: a finished, validated action, or
 * the stage that refused it and why. `kinds` are the kinds allowed to finish. */
export async function strictCandidate({root,transcript,appScope='web',workTarget=null,tables={},validateText,now=new Date(),kinds=STRICT_KINDS,budgetMs=null,signal,own=trackOwnedWork}){
 const ui=parseUiIntent(transcript,{conversationSelected:Boolean(workTarget),tables}),open=openIntentGiven(transcript);
 const uiOk=!ui.refused,openOk=typeof open.target==='string';
 // Resolution is owned from the moment it starts, so shutdown always sees it.
 // The budget does not cancel it: a file index that outlives its budget warms
 // the cache for the next request. A cancelled request and shutdown do stop it.
 const resolveOpen=async()=>{
  const controller=new AbortController();
  if(signal?.aborted)controller.abort();else signal?.addEventListener('abort',()=>controller.abort(),{once:true});
  const work=resolveOpenStrict(root,open.target,{now,appScope,signal:controller.signal});
  own(work,controller);
  let resolved,timer;
  try{resolved=await(budgetMs?Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>resolve({refused:'budget',overrun:true}),budgetMs)})]):work)}
  catch{return {refused:'error'}}
  finally{clearTimeout(timer)}
  return resolved;
 };
 if(uiOk){
  // One sentence, one meaning. The open grammar accepts any words after a
  // display lead ("open up my daily note"), so its reading only counts when it
  // names a real file; then there are two readings, and that is one too many.
  // A reading that could not be checked in time counts as a second reading.
  if(openOk){const other=await resolveOpen();if(!other.refused||other.overrun||other.refused==='error')return {kind:null,stage:'resolver',reason:'both'}}
  if(!kinds.includes('ui'))return {kind:'ui',stage:'door',reason:'kind-off'};
  // The unchanged validators may reject the command; they may never change or drop what was asked.
  let routed=null;try{routed=validateText(JSON.stringify(ui.candidate))}catch{}
  if(!routed||routed.tier!==2||routed.write||routed.deliverable||routed.skill||!routed.obsidian||routed.obsidian.op==='open-note'||!sameUiAction(routed.obsidian,ui.expect))return {kind:'ui',stage:'validator',reason:'invalid'};
  return {kind:'ui',stage:'confirmed',reason:null,routed:{tier:2,engine:'rules',reply:'',context:'',...(routed.panels?{panels:routed.panels}:{}),obsidian:routed.obsidian},action:{obsidian:routed.obsidian}};
 }
 if(openOk){
  if(!kinds.includes('open'))return {kind:'open',stage:'door',reason:'kind-off'};
  const resolved=await resolveOpen();
  if(resolved.refused)return {kind:'open',stage:'resolver',reason:String(resolved.refused).slice(0,60)};
  const routed=strictOpenRouted(resolved);
  if(!validateStrictOpen(routed,{root,appScope}))return {kind:'open',stage:'validator',reason:'invalid'};
  return {kind:'open',stage:'confirmed',reason:null,routed,action:routed.deliverable?{deliverable:routed.deliverable}:{obsidian:routed.obsidian}};
 }
 return {kind:null,stage:'door',reason:`ui:${ui.refused}|open:${open.refused}`.slice(0,80)};
}

const shadowFile=id=>`${ROOT}/strict-shadow/${id}.json`;
export function writeStrictShadow(root,id,record){try{writeJson(root,shadowFile(id),record)}catch{}} // A record must never affect a voice request.
const INERT=Object.freeze({active:false,atBoundary:async()=>null,returned(){}});

/** One request's view of the strict rules. `atBoundary` is called once, right
 * before a model would be started; `returned` when the caller has its answer.
 * Records are written after that, on a later turn of the event loop. */
export function strictRules({root,id,config=readStrictConfig(),log=writeStrictShadow,defer=callback=>setImmediate(callback),budgetMs=STRICT_BUDGET_MS,evaluate=strictCandidate}={}){
 const mode=Object.fromEntries(STRICT_KINDS.map(kind=>[kind,STRICT_MODES.includes(config?.[kind])?config[kind]:'off']));
 const watched=STRICT_KINDS.filter(kind=>mode[kind]!=='off'),acting=STRICT_KINDS.filter(kind=>mode[kind]==='on');
 if(!watched.length)return INERT;
 let finished;const answered=new Promise(resolve=>{finished=resolve});
 const safeLog=record=>{try{log(root,id,record)}catch{}};
 // Owned from now until the record is written. Shutdown can release it at any
 // point before the work starts, even if the scheduler never fires; work that
 // is already running is told to stop and stays owned until it settles.
 const afterAnswer=job=>{
  const abort=new AbortController(),released=new Promise(resolve=>abort.signal.addEventListener('abort',resolve,{once:true}));
  trackOwnedWork(Promise.race([released,answered.then(()=>new Promise(resolve=>defer(resolve)))]).then(async()=>{
   if(ownedWorkDraining()||abort.signal.aborted)return;
   await job(abort.signal);
  }).catch(()=>{}),abort);
 };
 return {
  active:true,
  returned(){finished()},
  async atBoundary({transcript,appScope='web',workTarget=null,excluded=[],newConversation=false,explicitWork=false,workHistory=false,exchanges=[],signal,validateText,tables={},now=new Date(),preModelMs=null}){
   const began=performance.now(),took=()=>Math.round((performance.now()-began)*10)/10;
   const blockedBy=strictGuard({excluded,newConversation,explicitWork,workHistory,workTarget,exchanges,tables});
   const base={id,ts:now.toISOString(),mode,blockedBy};
   const about={root,transcript,appScope,workTarget,tables,validateText,now};
   const summary=outcome=>({candidate:outcome.stage==='confirmed'?{kind:outcome.kind,action:outcome.action}:null,kind:outcome.kind,stage:outcome.stage,reason:outcome.reason});
   // A blocked request stops here: its sentence is neither parsed as a candidate
   // nor resolved before the answer. What it would have been is looked at later.
   let inline=null;
   if(!blockedBy&&acting.length&&!signal?.aborted&&!ownedWorkDraining()){
    try{inline=await evaluate({...about,kinds:acting,budgetMs,signal})}catch{inline={kind:null,stage:'door',reason:'error'}}
   }
   const strictMs=took();
   const acts=Boolean(inline?.stage==='confirmed'&&acting.includes(inline.kind)&&!signal?.aborted);
   // Everything the inline pass could not or may not finish is looked at after
   // the answer: a blocked request, and kinds that are only being watched.
   const later=!acts&&(blockedBy||watched.length>acting.length||!inline);
   afterAnswer(async stop=>{
    // A cancelled request is looked at no further.
    if(signal?.aborted&&!acts)return;
    if(!later)return safeLog({...base,...summary(inline),acted:acts,deferred:false,ms:strictMs});
    let outcome;try{outcome=await evaluate({...about,kinds:watched,budgetMs:null,signal:stop})}catch{outcome={kind:null,stage:'door',reason:'error'}}
    // Computed after the answer: a later observation, not proof of what would
    // have happened at the boundary (a worker may have created the file since).
    safeLog({...base,...summary(outcome),acted:false,deferred:true,evaluatedAt:new Date().toISOString(),ms:strictMs});
   });
   if(!acts)return null;
   return {...inline.routed,decision:{boundary:'general',source:'rules',rule:STRICT_RULE[inline.kind],rawIntent:{tier:2,kind:inline.kind==='open'?'local-open':'local-ui'},guarded:{tier:2},jev:null,fallbackModel:null,timing:{preModelMs,strictMs}}};
  }};
}
