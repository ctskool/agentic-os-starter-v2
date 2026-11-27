import {isDeepStrictEqual} from 'node:util';
import {setTimeout as wait} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {liveAffirmation,LIVE_NO_OFFER} from '../voice-router.mjs';
import {handleVoiceRequest} from '../voice-request.mjs';
import {CORRECTION_RE} from './turns.mjs';
import {LIVE_SUPERSEDED as SUPERSEDED} from './answers.mjs';

const retry='Say that again in a moment.';
const busy='One second, still on the last one.';
const RETAKE_QUIET=2500,RETAKE_WINDOW=30000;

const expired='That action is no longer available. Say the request again.';
// A request that cannot be delivered says why when the reason is one the caller can act on. "Say that again in a
// moment" told a caller nothing when the real answer was "the task you started is still working" (2026-11-23).
const busyTarget='That task is still working, so I can\'t add to it yet. Ask me again when it finishes, or say start a new task and what you want.';
const spokenFailure=error=>/working or needs terminal input|unfinished workflow/i.test(String(error?.message||''))?busyTarget:retry;
const readOffer=/\b(?:hear|read|tell you|go over|walk you through|what['’]s in it|the result|the summary)\b/i;
const compoundReadAction=/\b(?:and then|(?:and|then) (?:run|start|create|draft|write|delete|send))\b/i;
const pendingRead=/^(?:what (?:is|are|was|were|did|does|do|happened)|when (?:is|are|was|did|does|do)|how (?:many|much)|(?:check|read|show|summarize) (?:me )?(?:the |my )?(?:saved reading|report|result|summary|note|schedule|calendar|inbox))\b/i;
// "Wait, actually never mind" too: the words people put in front of a cancel (2026-11-26 test call).
const cancelWords=/^(?:(?:wait|actually|oh|um|uh|hold on|hang on|okay|ok|no|sorry)[,.!\s]+)*(?:no(?: thanks)?|don['’]?t|do not|(?:cancel|stop)(?: (?:it|that(?: task)?))?|wait|hold on|never\s*mind(?: (?:the report|that|it))?|scratch that)[.!?\s]*$/i;
const immediate=action=>{
 const sites=new Set(action.effects.map(effect=>effect.site));
 const newWork=new Set(action.effects.filter(effect=>['start','startWorkflow','enqueue'].includes(effect.site)).map(effect=>effect.details.job.id));
 return newWork.size>0&&
  !['send','continueWorkflow','stop','editDaily','reopenArtifact'].some(site=>sites.has(site))&&
  !action.effects.some(effect=>effect.site==='updateCurrent'&&!newWork.has(effect.details.id));
};
// Work whose news comes later: a new task, a workflow, or a request sent to (or queued for) an existing one.
// The tasks an action starts.
const jobsOf=action=>(action?.effects||[]).filter(effect=>['start','startWorkflow','enqueue'].includes(effect.site)).map(effect=>effect.details.job.id);
const startsWork=action=>Array.isArray(action?.effects)&&action.effects.some(effect=>['start','startWorkflow','enqueue','send','queueFollowup','continueWorkflow'].includes(effect.site));
const scheduleTimer=(fn,ms)=>{const handle=setTimeout(fn,ms);handle.unref?.();return ()=>clearTimeout(handle)};

export class LiveDelegations {
 constructor({active,context,requestContext,valid,prefs,now=Date.now,handle=handleVoiceRequest,limits={},
  timing:{schedule=scheduleTimer,sleep=(ms,signal)=>wait(ms,undefined,{signal})}={}}){
  Object.assign(this,{active,context,requestContext,valid,prefs,now,handle,schedule,sleep});
  this.limits={settle:200,progress:8000,undo:1500,autoUndo:2500,stage:45000,finish:3000,finishQuiet:1200,retry:1500,...limits};
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
 // Live promised work in its own words without handing it off (calls.mjs). The caller's words go through the same
 // plan and commit as a hand-off, with no delegation: everything V2 says on it is a plain line.
 rescue(call,anchor){
  if(call.routing||call.staged||this.active.size||!this.isCurrent(call))return false;
  this.receive(call,{delegation:{id:null,offset_ms:anchor}},randomUUID(),{key:'rescue-'+randomUUID().slice(0,8)});
  return true;
 }
 // Live handed off what the caller said next itself: the held hand-off is closed with a say-nothing line (on the
 // real API Live then stays quiet and the call can go to standby: probe, 2026-11-26).
 closeSuperseded(call,except){
  const held=call.supersededHandoff;
  if(!held||held.delegation===except)return;
  call.supersededHandoff=null;
  if(call.answers?.isOpen(held.delegation))call.answers.speak(held.delegation,SUPERSEDED);
 }
 // Live made no new hand-off once the caller stopped: V2 takes their whole turn on the held one. A turn that ended in
 // a cancel ("…wait, actually never mind") is answered "Cancelled."; a held one no longer needed is closed.
 retakeSuperseded(call,now){
  const held=call.supersededHandoff;
  if(!held||call.routing||call.staged||this.active.size)return;
  if(now-(call.heardAt??-Infinity)<RETAKE_QUIET||now-held.at<RETAKE_QUIET)return;
  call.supersededHandoff=null;
  if(!this.isCurrent(call)||!call.answers.isOpen(held.delegation))return;
  if(now-held.at>RETAKE_WINDOW||!(call.heardOffset>call.turns.used)){call.answers.speak(held.delegation,SUPERSEDED);return}
  const tail=call.turns.textFrom(held.cancelledBy);
  if(!tail||cancelWords.test(tail)){call.turns.skip(call.heardOffset);call.answers.speak(held.delegation,'Cancelled.');return}
  delete call.cancelledBy;call.rescuedFor=call.heardAt;
  this.receive(call,{delegation:{id:held.delegation,offset_ms:call.heardOffset}},randomUUID());
 }
 receive(call,event,id,{key,tool}={}){
  const delegation=event.delegation.id,anchor=call.turns.anchor(event,this.now());
  this.closeSuperseded(call,delegation);
  if(call.routing||this.active.size){
   if(call.routing&&!call.routing.assembled)call.routing.busyAnchor=Math.max(call.routing.busyAnchor??-1,anchor);
   else call.turns.skip(anchor);
   call.answers.speak(delegation,busy);return
  }
  let captured;try{captured=this.capture(call)}catch{}
  // Snapshot and reserve the delegation before yielding to the settle timer.
  const pending={anchor,cancelled:false,abort:new AbortController(),prior:call.staged?.undo?call.staged:null,key:delegation??key,tool};
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
  }).catch(error=>{
   call.debugLog?.({event:'v2-error',error:String(error?.message??error).slice(0,300)});
   if(this.isCurrent(call)&&!pending.cancelled)call.answers.speak(delegation,spokenFailure(error));
  }).finally(()=>{
   // A hand-off dropped because the caller corrected themselves or kept going is held, never left open: one left open
   // kept a test call awake for eleven minutes, Live filling the silence ("Mm-hmm", "Still here"). And it was not
   // closed at once either: closed while the caller was still talking ("Start a timer test task. Wait six full
   // minutes…"), Live never handed off the rest. See closeSuperseded and retakeSuperseded.
   if(pending.cancelled&&delegation&&this.isCurrent(call)&&call.answers.isOpen(delegation)&&call.staged?.heldOpen!==delegation)
    call.supersededHandoff={delegation,at:this.now(),cancelledBy:call.cancelledBy??pending.anchor};
   if(pending.tool)call.answers.closeTool(delegation);
   if(pending.busyAnchor!==undefined)call.turns.skip(pending.busyAnchor);
   if(call.routing===pending)call.routing=null;
   // A hand-off that ended without an answer or an action leaves nothing on screen.
   if(pending.activity==='handoff')this.activity(call,pending,'dropped');
  });
 }
 // What a hand-off is doing, for the surface to show beside the call like a skill run (Chase, 2026-11-23).
 // Display only: handoff, then answered (a read), or starting and started (an action), or dropped.
 // A started action names the tasks it started or added to, so the surface can keep the card up until that task
 // finishes instead of clearing it a few seconds after "started".
 activity(call,pending,phase,label='',taskIds=[]){
  if(!pending?.key||call.state==='closing')return;
  pending.activity=phase;
  const ids=taskIds.filter(id=>typeof id==='string'&&id).slice(0,4);
  call.updates.push({type:'activity',key:pending.key,phase,label:String(label??'').slice(0,120),...(ids.length?{taskIds:ids}:{})});
 }
 fragment(call,row){
  // With tool hand-offs a cancel or a correction arrives as its own tool call, read in context ("Wait six full
  // minutes…" is not a cancel), so the caller's words are not searched for cancel words here.
  if(call.toolMode&&!call.toolsBroken)return;
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
 // Work that never started keeps no id for the model to name later.
 dropRefs(call,stage){const ids=jobsOf(stage.action);for(const [ref,task] of call.toolRefs??[])if(ids.includes(task.id))call.toolRefs.delete(ref)}
 retryTool(call,stage){
  if(!this.isCurrent(call))return;
  if(call.routing||call.staged||this.active.size){this.dropRefs(call,stage);call.answers.speak(null,retry);return}
  const ref=[...call.toolRefs].find(([,task])=>jobsOf(stage.action).includes(task.id))?.[0]??null;
  this.receive(call,{delegation:{id:null,offset_ms:call.heardOffset??0}},randomUUID(),{tool:{...stage.tool,retry:true,retryRef:ref},key:'retry-'+randomUUID().slice(0,8)});
 }
 // A tool hand-off: the request arrives written out, with its kind and the task it concerns (tools.mjs). Nothing is
 // taken from the transcript, and nothing is waited for.
 async planTool(call,pending,{id,delegation,captured}){
  const answers=call.answers;
  pending.assembled=true;
  // These words are spoken for: nothing else takes them from the transcript (no rescue for this turn).
  if(call.heardOffset!==undefined)call.turns.skip(call.heardOffset);
  call.rescuedFor=call.heardAt;
  if(!this.unchanged(call,captured)){answers.speak(delegation,retry);return}
  let {kind,request:transcript,taskId}=pending.tool;
  if(kind==='unclear'){answers.speak(delegation,pending.tool.say);return}
  // The answer to "say yes to go ahead" (the Ask first settings).
  if(kind==='confirm'){
   const waiting=call.staged&&!call.staged.undo&&!call.staged.consumed?call.staged:null;
   if(!waiting){answers.speak(delegation,'Nothing is waiting for a yes.');return}
   if(!pending.tool.confirm){this.clear(call,'staged-cancelled');answers.speak(delegation,'Cancelled.');return}
   if(!this.unchanged(call,waiting.captured)||waiting.expiresAt<=this.now()){this.clear(call);answers.speak(delegation,retry);return}
   if(waiting.mode==='click'){answers.speak(delegation,'Tap Confirm on screen.');return}
   this.startUndo(call,waiting,delegation,pending.anchor,this.now()+this.limits.undo);return;
  }
  const refOf=id=>[...call.toolRefs].find(([,task])=>task.id===id)?.[0]??null;
  const staged=call.staged&&!call.staged.consumed?call.staged:null,stagedIds=staged?jobsOf(staged.action):[];
  if(kind==='cancel'&&staged&&(!taskId||stagedIds.includes(taskId))){this.clear(call,'staged-cancelled');answers.speak(delegation,'Cancelled.');return}
  // A cancel that names no task stops only work this call started, and only when there is no doubt which.
  if(kind==='cancel'&&!taskId){
   const terminals=this.requestContext().terminals;
   const running=[...call.toolRefs.values()].map(task=>task.id).filter(id=>{try{return ['starting','working','needs input'].includes(terminals?.get(id)?.state)}catch{return false}});
   if(running.length!==1){answers.speak(delegation,running.length?'More than one task is running. Which one should I stop?':'Nothing from this call is running.');return}
   taskId=running[0];
  }
  // Live handed off before the caller finished ("Start a timer test task." … "Wait six full minutes…"): the rest
  // arrives as a follow-up to work that has not started yet, so the two halves become the one request.
  if(kind==='replace'&&staged&&stagedIds.includes(taskId)){pending.reuseRef=refOf(taskId);kind='new_work';taskId=null;this.clear(call)}
  if(pending.tool.retryRef)pending.reuseRef=pending.tool.retryRef;
  if(kind==='follow_up'&&staged&&stagedIds.includes(taskId)){
   pending.reuseRef=refOf(taskId);transcript=(staged.request.transcript+' '+transcript).slice(0,4000);kind='new_work';taskId=null;this.clear(call);
  }else if(staged&&!staged.undo)this.clear(call,'staged-cancelled');
  if(this.active.size){answers.speak(delegation,busy);return}
  const request={id,transcript,selection:captured.selection,workTarget:taskId??null,appScope:captured.appScope,conversationEpoch:captured.conversationEpoch,
   surface:call.ownerSurface,liveCallId:call.callId,liveTurns:call.turns.context(this.now()),liveTaskIds:call.taskUpdates?.taskIds(),liveIntent:{kind}};
  const stage=await this.planned(call,pending,request,delegation,captured,await this.route(call,pending,request,delegation,'plan'));
  if(!stage)return;
  // Stopping is what the caller just asked for: no "Stopping…" and a window to take it back, just the one line.
  if(kind==='cancel')stage.immediate=true;
  stage.tool={...pending.tool,kind,request:transcript,taskId};stage.retried=!!pending.tool.retry;
  // The model names tasks by short ids V2 gives it (t1, t2…), described by the caller's own words: nothing from
  // outside this call is named to it.
  for(const job of jobsOf(stage.action)){
   const ref=pending.reuseRef??'t'+(++call.toolSeq.n);pending.reuseRef=null;
   call.toolRefs.set(ref,{id:job,words:transcript.slice(0,80)});
   answers.toolExtra(delegation,{task_id:ref,status:'started'});
  }
  if(taskId)answers.toolExtra(delegation,{task_id:refOf(taskId)});
  answers.toolExtra(delegation,{tasks_in_this_call:[...call.toolRefs].slice(-8).map(([task_id,task])=>({task_id,request:task.words}))});
  return stage;
 }
 async plan(call,pending,{id,delegation,captured}){
  if(pending.tool)return this.planTool(call,pending,{id,delegation,captured});
  await this.sleep(this.limits.settle,pending.abort.signal);
  if(pending.cancelled||!this.isCurrent(call))return;
  // Live can hand off at a pause while the caller is still talking (2026-11-26: "…save to my inbox. Take your time
  // and be thorough" reached V2 as "…Save to my"). Words that keep coming after the hand-off point are waited for,
  // up to `finish`, and taken with the rest.
  if(call.heardOffset>pending.anchor&&call.turns.continuesAfter(pending.anchor)){
   const deadline=this.now()+this.limits.finish;
   while(this.now()-call.heardAt<this.limits.finishQuiet&&this.now()<deadline){
    await this.sleep(this.limits.settle,pending.abort.signal);
    if(pending.cancelled||!this.isCurrent(call))return;
   }
   pending.anchor=Math.max(pending.anchor,call.heardOffset);
  }
  const turn=call.turns.take(pending.anchor,this.now());
  pending.assembled=true;
  if(pending.busyAnchor!==undefined)call.turns.skip(pending.busyAnchor);
  // A rescue (no delegation) with nothing new to take was already handled: nothing to say (2026-11-26 test call).
  if(!turn?.text&&delegation===null)return;
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
  return this.planned(call,pending,request,delegation,captured,await this.route(call,pending,request,delegation,'plan'));
 }
 // A routed plan becomes an answer (a read) or an action to stage.
 planned(call,pending,request,delegation,captured,result){
  if(pending.cancelled||!this.isCurrent(call))return;
  if(!this.unchanged(call,captured)){call.answers.speak(delegation,retry);return}
  if(result.kind==='read'){
   call.answers.result(delegation,result,this.view(result,call));
   this.activity(call,pending,'answered',result.briefSource?'the morning brief':result.decision?.rule==='router.taskStatus'?'task status':'saved notes');return;
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
  if(!(call.toolMode&&!call.toolsBroken)&&this.interruptUndo(call,anchor,until))return;
  stage.finished=new Promise(resolve=>{stage.finish=resolve});
  stage.undoAnchor=anchor;stage.undoUntil=until;stage.undoDelegation=delegation;
  const finishUndo=()=>{
   if(call.staged!==stage)return;
   const remaining=until-this.now();
   if(remaining>0){stage.undo=this.schedule(finishUndo,remaining);return}
   void this.confirm(call,stage.actionId,stage.mode,delegation).catch(error=>{
    // Which part of the context moved, for the call log: seen when a request lands seconds after a task starts.
    let moved='';try{const now=this.capture(call);moved=now?['selection','workTarget','appScope','conversationEpoch','gen','sessionId'].filter(key=>!isDeepStrictEqual(now[key],stage.captured?.[key])).join(','):'context not posted'}catch{}
    call.debugLog?.({event:'v2-error',error:String(error?.message??error).slice(0,300)+(moved?' ['+moved+']':'')});
    if(!this.isCurrent(call))return;
    // A request that came written out is tried once more, quietly, before the caller is asked to repeat it (seen
    // twice on a 2026-11-27 test call: an accepted follow-up answered "Say that again in a moment" two seconds on).
    if(stage.tool&&!stage.retried){this.schedule(()=>this.retryTool(call,stage),this.limits.retry);return}
    this.dropRefs(call,stage);
    call.answers.speak(delegation,spokenFailure(error));
   });
  };
  stage.undo=this.schedule(finishUndo,Math.max(0,until-this.now()));
  const receipt=stage.action.receipt;
  const slash=receipt?.decision?.rule==='frontdoor.slashSkill';
  // Two cases need their own sentence, because "Starting…" would say the wrong thing: a workflow that runs on its
  // own while the selected task works, and a follow-up that waits for that task.
  const explained=receipt?.reply&&receipt.decision?.effects?.some(effect=>effect==='busy-target-separate'||effect==='queueFollowup');
  // Work that starts a task keeps its hand-off open for that task's news, so this line goes as a plain one.
  const keepOpen=startsWork(stage.action)&&call.answers.isOpen(delegation)&&this.holdsNews();
  if(keepOpen)stage.heldOpen=delegation;
  // A follow-up sent to a task reads "Continue “that task”" (titles stay off the call), so it is said as "Updating it now…".
  const followUp=/^Continue “(.*)”$/.exec(stage.spokenDescription);
  if(stage.retried)return;
  const stop=/^Stop “(.*)”$/.exec(stage.spokenDescription);
  // "Stop “that task” and then Start “…” in your Claude terminal" (a replace) is said as one plain sentence.
  const swap=/^Stop “[^”]*” and then Start (“.*)$/.exec(stage.spokenDescription);
  const line=slash||explained?receipt.reply:swap?`Stopping that and starting ${swap[1]} instead…`:stop?`Stopping ${stop[1]==='that task'?'it':`“${stop[1]}”`}…`:followUp?`Updating ${followUp[1]==='that task'?'it':`“${followUp[1]}”`} now…`:`Starting ${stage.spokenDescription.replace(/^Start /i,'')}…`;
  // Live already acknowledged this in its own voice ("On it, spinning that up"), so "Starting…" would be a second
  // acknowledgement (2026-11-26 test calls). Live gets it silently instead, to answer "what did you start?".
  // Never for a rescue (no delegation): V2 started that on its own reading of Live's words, so the caller hears what
  // started and can still say "wait" (Neon review, 2026-11-26).
  const acknowledged=call.liveAcked===true;
  // Not on a tool hand-off: given a result with nothing to say, Live made up "Done. It's saved" for work that had only
  // started (2026-11-27 test call). A second "starting" is the lesser fault, so the tool's result always says it.
  if(acknowledged&&!explained&&keepOpen&&startsWork(stage.action)){
   call.answers.append('thinking',null,`V2 is ${line.replace(/…$/,'').replace(/^(Starting|Updating)/,word=>word.toLowerCase())}. You already acknowledged it, so don't announce it again; mention it only if asked.`);
   return;
  }
  call.answers.speak(keepOpen?null:delegation,line);
 }
 // A hand-off is held open only for news that will be said: with task updates on Screen only, nothing would close it.
 holdsNews(){try{return this.prefs().liveTaskUpdates!=='silent'}catch{return false}}
 view(result,call){return this.requestContext().liveView?.(result,call.appScope)??result}
 async route(call,pending,request,delegation,phase,stage){
  // Not on a tool hand-off: its first line is the tool's result, so a progress line would end it before the answer.
  const cancelProgress=phase==='plan'&&!pending.tool&&pendingRead.test(request.transcript)&&!compoundReadAction.test(request.transcript)?this.schedule(()=>{
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
  const started=stage.action.effects.flatMap(({site,details})=>{
   if(['start','startWorkflow','enqueue'].includes(site))return [details.job.id];
   return ['send','queueFollowup','continueWorkflow'].includes(site)?[details.taskId]:[];
  });
  this.activity(call,stage.activity,'started',stage.description,started);
  if(this.isCurrent(call)){
   call.taskUpdates?.started(started,this.now());
   const keepOpen=started.length>0&&call.answers.isOpen(delegation)&&this.holdsNews();
   call.answers.result(delegation,result,this.view(result,call),{speak:!(stage.undo&&result.action==='task'),keepOpen});
   if(keepOpen)call.taskUpdates?.hold(started,delegation,this.now());
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
  // Work that never started keeps no id for the model to name later.
  if(!stage.consumed&&call.toolRefs){const ids=jobsOf(stage.action);for(const [ref,task] of call.toolRefs)if(ids.includes(task.id))call.toolRefs.delete(ref)}
  if(!stage.consumed){
   stage.finish?.();this.activity(call,stage.activity,'dropped');
   // Cancelled in the undo window: the hand-off left open for the task's news is answered now.
   if(stage.heldOpen&&call.answers?.isOpen(stage.heldOpen)&&call.state!=='closing')call.answers.speak(stage.heldOpen,'Cancelled.');
  }
  call.answers.held=call.answers.held.filter(event=>event.delegation_id!==stage.delegation&&event.delegation_id!==stage.undoDelegation);
  if(call.state!=='closing')call.updates.push({type});
 }
 close(call){this.clear(call);call.routing?.abort.abort();call.answers?.close()}
}
