import {isDeepStrictEqual} from 'node:util';
import {setTimeout as wait} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {liveAffirmation,LIVE_NO_OFFER} from '../voice-router.mjs';
import {handleVoiceRequest} from '../voice-request.mjs';
import {CORRECTION_RE} from './turns.mjs';

const retry='Say that again in a moment.';
const busy='One second, still on the last one.';
const expired='That action is no longer available. Say the request again.';
const readOffer=/\b(?:hear|read|tell you|go over|walk you through|what['’]s in it|the result|the summary)\b/i;
const compoundReadAction=/\b(?:and then|(?:and|then) (?:run|start|create|draft|write|delete|send))\b/i;
const pendingRead=/^(?:what (?:is|are|was|were|did|does|do|happened)|when (?:is|are|was|did|does|do)|how (?:many|much)|(?:check|read|show|summarize) (?:me )?(?:the |my )?(?:saved reading|report|result|summary|note|schedule|calendar|inbox))\b/i;
const cancelWords=/^(?:no(?: thanks)?|don['’]?t|do not|(?:cancel|stop)(?: (?:it|that(?: task)?))?|wait|hold on|never\s*mind(?: the report)?|scratch that)[.!?\s]*$/i;
const immediate=action=>{
 const sites=new Set(action.effects.map(effect=>effect.site));
 const newWork=new Set(action.effects.filter(effect=>['start','startWorkflow','enqueue'].includes(effect.site)).map(effect=>effect.details.job.id));
 return newWork.size>0&&
  !['send','continueWorkflow','stop','editDaily','reopenArtifact'].some(site=>sites.has(site))&&
  !action.effects.some(effect=>effect.site==='updateCurrent'&&!newWork.has(effect.details.id));
};
const scheduleTimer=(fn,ms)=>{const handle=setTimeout(fn,ms);handle.unref?.();return ()=>clearTimeout(handle)};

export class LiveDelegations {
 constructor({active,context,requestContext,valid,prefs,now=Date.now,handle=handleVoiceRequest,limits={},
  timing:{schedule=scheduleTimer,sleep=(ms,signal)=>wait(ms,undefined,{signal})}={}}){
  Object.assign(this,{active,context,requestContext,valid,prefs,now,handle,schedule,sleep});
  this.limits={settle:200,progress:8000,undo:1500,autoUndo:2500,stage:45000,...limits};
 }
 isCurrent(call){
  try{return call.localHeld&&call.ready&&call.state==='active'&&this.prefs().voiceMode==='live'&&this.valid(call)}
  catch{return false}
 }
 capture(call){
  if(!this.isCurrent(call)||!call.context)return null;
  const saved=this.context(call);
  return saved&&['selection','workTarget','appScope','conversationEpoch'].every(key=>isDeepStrictEqual(saved[key],call.context[key]))?
   structuredClone({...saved,gen:call.gen,sessionId:call.sessionId}):null;
 }
 unchanged(call,captured){
  try{return !!captured&&isDeepStrictEqual(this.capture(call),captured)}catch{return false}
 }
 receive(call,event,id){
  const delegation=event.delegation.id,anchor=call.turns.anchor(event,this.now());
  if(call.routing||this.active.size){
   if(call.routing&&!call.routing.assembled)call.routing.busyAnchor=Math.max(call.routing.busyAnchor??-1,anchor);
   else call.turns.skip(anchor);
   call.answers.speak(delegation,busy);return
  }
  let captured;try{captured=this.capture(call)}catch{}
  // Snapshot and reserve the delegation before yielding to the settle timer.
  const pending={anchor,cancelled:false,abort:new AbortController(),prior:call.staged?.undo?call.staged:null,key:delegation};
  call.routing=pending;
  this.activity(call,pending,'handoff');
  pending.plan=this.plan(call,pending,{id,delegation,captured});
  void pending.plan.then(async stage=>{
   if(!stage)return;
   // Keep the first action's Cancel button and timer until its commit or cancellation.
   if(pending.prior)await pending.prior.finished;
   if(pending.cancelled||!this.isCurrent(call))return;
   if(!this.unchanged(call,captured)){call.answers.speak(delegation,retry);return}
   call.routing=pending;
   return this.stage(call,pending,stage);
  }).catch(()=>{
   if(this.isCurrent(call)&&!pending.cancelled)call.answers.speak(delegation,retry);
  }).finally(()=>{
   if(pending.busyAnchor!==undefined)call.turns.skip(pending.busyAnchor);
   if(call.routing===pending)call.routing=null;
   // A hand-off that ended without an answer or an action leaves nothing on screen.
   if(pending.activity==='handoff')this.activity(call,pending,'dropped');
  });
 }
 // What a hand-off is doing, for the surface to show beside the call like a skill run (Chase, 2026-11-23).
 // Display only: handoff, then answered (a read), or starting and started (an action), or dropped.
 activity(call,pending,phase,label=''){
  if(!pending?.key||call.state==='closing')return;
  pending.activity=phase;
  call.updates.push({type:'activity',key:pending.key,phase,label:String(label??'').slice(0,120)});
 }
 fragment(call,row){
  if(!row.user||!row.text.trim())return;
  const stage=call.staged;
  if(stage?.undo){
   if(this.now()<stage.undoUntil&&row.offset>stage.undoAnchor)this.interruptUndo(call,stage.undoAnchor,stage.undoUntil);
   if(!call.routing)return;
  }
  const pending=call.routing;
  if(pending?.committing)return;
  const anchor=Math.min(pending?.anchor??Infinity,stage&&!stage.undo?stage.anchor:Infinity);
  if(row.offset>anchor&&(cancelWords.test(row.text.trim())||CORRECTION_RE.test(row.text)||call.turns.correctionAfter(anchor))){
   call.cancelledBy=row.offset;
   if(!stage?.undo)this.clear(call,'staged-cancelled');
   if(pending){pending.cancelled=true;pending.abort.abort()}
  }
 }
 interruptUndo(call,anchor,until){
  const interruption=call.turns.undoInterruptionAfter(anchor,until);
  if(!interruption)return false;
  if(interruption.cancel)call.undoCancelledBy=interruption.offset;else call.cancelledBy=interruption.offset;
  this.clear(call,'staged-cancelled');return true;
 }
 async plan(call,pending,{id,delegation,captured}){
  await this.sleep(this.limits.settle,pending.abort.signal);
  if(pending.cancelled||!this.isCurrent(call))return;
  const turn=call.turns.take(pending.anchor,this.now());
  pending.assembled=true;
  if(pending.busyAnchor!==undefined)call.turns.skip(pending.busyAnchor);
  if(!turn?.text||!this.unchanged(call,captured)){call.answers.speak(delegation,retry);return}
  if(this.active.size){call.answers.speak(delegation,busy);return}
  // The input delta already cleared the timer. Its delegation must not stop another task.
  const staged=call.staged,interrupted=call.cancelledBy>=turn.firstOffset&&call.cancelledBy<=pending.anchor;
  const undoInterrupted=call.undoCancelledBy>=turn.firstOffset&&call.undoCancelledBy<=pending.anchor;
  if(call.cancelledBy<=pending.anchor)delete call.cancelledBy;
  if(call.undoCancelledBy<=pending.anchor)delete call.undoCancelledBy;
  let transcript=turn.text;
  const affirm=liveAffirmation(transcript);
  if(undoInterrupted){call.answers.speak(delegation,'Cancelled.');return}
  if(((interrupted||staged&&!staged.undo)&&cancelWords.test(transcript))||(interrupted&&affirm)){
   this.clear(call,'staged-cancelled');call.answers.speak(delegation,'Cancelled.');return;
  }
  if(affirm&&staged&&!staged.undo){
   if(!this.unchanged(call,staged.captured)||staged.expiresAt<=this.now()){this.clear(call);call.answers.speak(delegation,retry);return}
   if(staged.mode==='click'){call.answers.speak(delegation,'Tap Confirm on screen.');return}
   this.startUndo(call,staged,delegation,pending.anchor,turn.lastAt+this.limits.undo);
   return;
  }
  if(affirm){
   if(!turn.offer){call.answers.speak(delegation,LIVE_NO_OFFER);return}
   if(readOffer.test(turn.offer)){
    const result=call.taskUpdates?.lastResult;
    if(result){call.answers.result(delegation,result);this.activity(call,pending,'answered','the last result')}
    else call.answers.speak(delegation,'Nothing has finished yet.');
    return;
   }
   transcript=`Do what you just offered. You said: "${turn.offer}". The user replied: "${turn.text}".`;
  }
  if(!staged?.undo)this.clear(call,'staged-cancelled');
  if(call.turns.correctionAfter(pending.anchor)){pending.cancelled=true;return}
  const request={id,transcript,selection:captured.selection,workTarget:affirm?null:captured.workTarget,appScope:captured.appScope,
   conversationEpoch:captured.conversationEpoch,surface:call.ownerSurface,liveCallId:call.callId,liveTurns:turn.preceding,liveTaskIds:call.taskUpdates?.taskIds()};
  const result=await this.route(call,pending,request,delegation,'plan');
  if(pending.cancelled||!this.isCurrent(call))return;
  if(!this.unchanged(call,captured)){call.answers.speak(delegation,retry);return}
  if(result.kind==='read'){
   call.answers.result(delegation,result,this.view(result,call));
   this.activity(call,pending,'answered',result.briefSource?'the morning brief':'saved notes');return;
  }
  if(result.kind!=='action')throw new Error('Invalid Live voice plan.');
  const setting=this.prefs().liveConfirm??'auto';
  return {actionId:randomUUID(),captured,request,delegation,anchor:pending.anchor,mode:setting==='destructive'?'click':setting,
   action:result.action,description:result.description,spokenDescription:result.action.effects.some(effect=>effect.site==='reopenArtifact')?'reopen the selected file':result.description,
   immediate:setting==='destructive'&&immediate(result.action)};
 }
 async stage(call,pending,stage){
  const {delegation}=stage;
  stage.activity={key:pending.key};
  this.activity(call,stage.activity,'starting',stage.description);pending.activity='starting';
  if(stage.immediate){
   stage.consumed=true;
   await this.commit(call,pending,stage,delegation);return;
  }
  call.staged=stage;
  stage.expiresAt=this.now()+this.limits.stage;
  stage.expiry=this.schedule(()=>{if(call.staged===stage)this.clear(call,'staged-expired')},this.limits.stage);
  const windowEnd=stage.mode==='auto'?this.now()+this.limits.autoUndo:stage.expiresAt;
  call.updates.push({type:'staged',actionId:stage.actionId,description:stage.description,mode:stage.mode,expiresAt:windowEnd});
  if(stage.mode==='auto'){this.startUndo(call,stage,delegation,pending.anchor,windowEnd);return}
  call.answers.speak(delegation,stage.mode==='click'?"Here's what I'd do. Tap Confirm on screen.":`Just to check: ${stage.spokenDescription}. Say yes to go ahead.`);
 }
 startUndo(call,stage,delegation,anchor,until){
  if(this.interruptUndo(call,anchor,until))return;
  stage.finished=new Promise(resolve=>{stage.finish=resolve});
  stage.undoAnchor=anchor;stage.undoUntil=until;stage.undoDelegation=delegation;
  const finishUndo=()=>{
   if(call.staged!==stage)return;
   const remaining=until-this.now();
   if(remaining>0){stage.undo=this.schedule(finishUndo,remaining);return}
   void this.confirm(call,stage.actionId,stage.mode,delegation).catch(()=>{if(this.isCurrent(call))call.answers.speak(delegation,retry)});
  };
  stage.undo=this.schedule(finishUndo,Math.max(0,until-this.now()));
  const receipt=stage.action.receipt;
  const slash=receipt?.decision?.rule==='frontdoor.slashSkill';
  call.answers.speak(delegation,slash?receipt.reply:`Starting ${stage.spokenDescription.replace(/^Start /i,'')}…`);
 }
 view(result,call){return this.requestContext().liveView?.(result,call.appScope)??result}
 async route(call,pending,request,delegation,phase,stage){
  const cancelProgress=phase==='plan'&&pendingRead.test(request.transcript)&&!compoundReadAction.test(request.transcript)?this.schedule(()=>{
   if(this.isCurrent(call)&&!pending.cancelled)call.answers.speak(delegation,'Still looking…');
  },this.limits.progress):null;
  const watchDisconnect=abort=>{
   const signal=pending.abort.signal;signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
   return ()=>signal.removeEventListener('abort',abort);
  };
  const guard=()=>{
   if(phase==='plan'||!stage?.consumed||pending.cancelled||pending.abort.signal.aborted||!this.unchanged(call,stage.captured))throw new Error('The Live voice target or call changed. Say the request again.');
  };
  try{return await this.handle(this.requestContext(),{...request,watchDisconnect},{source:'live',transport:'live',phase,guard,plannedAction:stage?.action})}
  finally{cancelProgress?.()}
 }
 async commit(call,pending,stage,delegation){
  if(!this.unchanged(call,stage.captured))throw new Error('The voice target, selection or conversation changed. Say the request again.');
  pending.committing=true;
  let result;
  try{result=await this.route(call,pending,stage.request,delegation,'commit',stage)}
  catch(error){this.activity(call,stage.activity,'dropped');throw error}
  this.activity(call,stage.activity,'started',stage.description);
  if(this.isCurrent(call)){
   const started=stage.action.effects.flatMap(({site,details})=>{
    if(['start','startWorkflow','enqueue'].includes(site))return [details.job.id];
    return ['send','continueWorkflow'].includes(site)?[details.taskId]:[];
   });
   call.taskUpdates?.started(started,this.now());
   call.answers.result(delegation,result,this.view(result,call),{speak:!(stage.undo&&result.action==='task')});
  }
 }
 async confirm(call,id,mode='click',delegation){
  const stage=call.staged;
  if(!stage||stage.actionId!==id||stage.mode!==mode||stage.expiresAt<=this.now()||
    mode!=='click'&&(!stage.undo||this.now()<stage.undoUntil))throw new Error(expired);
  // A follow-up may still hold the shared router. Its plan never waits for the earlier commit.
  const followUp=call.routing?.prior===stage?call.routing:null;
  stage.consumed=true;this.clear(call);
  const pending={anchor:stage.anchor,abort:new AbortController()};
  try{
   if(followUp)await followUp.plan.catch(()=>{});
   if(!this.unchanged(call,stage.captured))throw new Error('The voice target, selection or conversation changed. Say the request again.');
   if((call.routing&&call.routing!==followUp)||this.active.size)throw new Error(busy);
   call.routing=pending;
   await this.commit(call,pending,stage,delegation??stage.delegation);return {ok:true}
  }finally{if(call.routing===pending)call.routing=null;stage.finish?.()}
 }
 cancel(call,id){
  if(!this.isCurrent(call)||call.staged?.actionId!==id||!call.staged||call.staged.expiresAt<=this.now())throw new Error(expired);
  this.clear(call,'staged-cancelled');return {ok:true};
 }
 clear(call,type='staged-cleared'){
  const stage=call.staged;if(!stage)return;
  call.staged=null;stage.undo?.();stage.expiry?.();
  if(!stage.consumed){stage.finish?.();this.activity(call,stage.activity,'dropped')}
  call.answers.held=call.answers.held.filter(event=>event.delegation_id!==stage.delegation&&event.delegation_id!==stage.undoDelegation);
  if(call.state!=='closing')call.updates.push({type});
 }
 close(call){this.clear(call);call.routing?.abort.abort();call.answers?.close()}
}
