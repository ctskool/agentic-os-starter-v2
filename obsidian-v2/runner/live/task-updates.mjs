import {taskLabel,taskUpdate,shortOutcome} from '../task-updates.mjs';

const SILENCE=1200,BATCH=3000,RECENT=10000,CHECK_IN=180000,LINE_GAP=2500;
// How long a hand-off may stay open for its task (Chase, 2026-11-26: "five minute cap"). Open, the call stays awake
// (no standby; about 3 cents a minute more) and Live says the result in its own voice when it lands.
export const HANDOFF_CAP_MS=300000;
const STOPPED_GRACE_MS=10000;

export class LiveTaskUpdates {
 constructor(call){this.call=call;this.jobs=new Map();this.pending=[];this.lastInput=-Infinity;this.inputOpen=false;this.lastResult=null;this.announcements=new Map();this.announced=0;this.open=new Map()}
 // The text of a standby announcement, once, for the screen that plays it.
 takeAnnouncement(seq){const text=this.announcements.get(seq);this.announcements.delete(seq);return text||null}
 // Open hand-offs (real calls, 2026-11-26): GPT-Live does not go to standby while a client delegation is unanswered,
 // and a commentary sent later on that delegation is spoken in Live's own voice and completes it. Lines sent with
 // delegation_id null meanwhile ("needs your OK") leave it open. So a hand-off that starts a task stays open until
 // that task's news is said on it, up to HANDOFF_CAP_MS.
 hold(taskIds,delegation,now){if(typeof delegation==='string'&&delegation)for(const id of taskIds)this.open.set(id,{delegation,at:now})}
 // A renewed session does not know the old session's delegations.
 release(){this.open.clear()}
 // News held for a fresh session that could not be started: the caller's screen says it instead (see flush).
 wakeFailed(){
  const answers=this.call.answers,held=answers.held.filter(event=>event.delegation_id===null);
  answers.held=answers.held.filter(event=>event.delegation_id!==null);
  for(const event of held)this.announce(event.content);
 }
 announce(text){
  const seq=++this.announced;this.announcements.set(seq,text);
  for(const key of this.announcements.keys())if(this.announcements.size>5)this.announcements.delete(key);
  this.call.answers.append('thinking',null,`Already said out loud on the user's screen while the call was in standby, so don't repeat it unless asked: ${text}`);
  this.call.updates.push({type:'announce',say:seq});
 }
 taskIds(){return [...this.jobs.keys()]}
 started(ids,at){for(const id of ids){this.jobs.delete(id);this.jobs.set(id,at)}}
 transcript(row){
  if(row.user&&row.text.trim()){
   this.lastInput=row.at;this.inputOpen=true;this.inputOffset=row.offset;this.inputTurn=row.turnId;
  }else if(!row.user&&row.offset>=this.inputOffset)this.inputOpen=false;
 }
 endTurn(event){
  const id=event.turn_id??event.item_id;
  const offset=event.delegation?.offset_ms??event.offset_ms;
  if(id&&this.inputTurn&&id!==this.inputTurn||Number.isFinite(offset)&&offset<this.inputOffset)return;
  this.inputOpen=false;
 }
 receive(item,prefs,now){
  const label=taskLabel({...item,title:item.taskLabel});
  const update=taskUpdate({...item,label});
  const forCall=item.liveCallId===this.call.callId;
  const chime=Boolean(this.call.paused&&prefs.liveTaskUpdates!=='silent'&&forCall);
  this.call.updates.push({type:'completion',taskId:item.taskId??null,label,text:update.text,state:update.state,chime});
  if(!forCall)return;
  if(update.state!=='needs input'){
   this.pending=this.pending.filter(entry=>entry.taskId!==item.taskId||!['needs input','progress'].includes(entry.state));
   if(this.jobs.has(item.taskId))this.jobs.set(item.taskId,null);
   const reply=shortOutcome(item.summary||item.text,2)||update.text;
   this.lastResult={reply,spokenReply:update.state==='failed'?update.text:reply,deliverable:item.deliverable||null};
  }
  if(prefs.liveTaskUpdates!=='silent'){
   this.pending.push({taskId:item.taskId,label,text:update.text,state:update.state,at:now,outcome:shortOutcome(item.summary||item.text)});
   this.pending=this.pending.slice(-20);
  }
 }
 flush(prefs,now,readTasks){
  const answers=this.call.answers;
  if(prefs.liveTaskUpdates==='silent'){
   this.pending.length=0;answers.held=answers.held.filter(event=>event.delegation_id!==null);return;
  }
  if(prefs.liveTaskUpdates==='chatty'&&!this.call.paused){
   const due=[...this.jobs].filter(([,at])=>at!==null&&now-at>=CHECK_IN);
   if(due.length){
    const tasks=new Map(readTasks().map(task=>[task.id,task]));
    for(const [id,last] of due){
     const task=tasks.get(id),working=task&&['starting','working'].includes(task.state);
     this.jobs.set(id,working||task?.state==='needs input'?now:null);
     if(!working)continue;
     const minutes=Math.max(1,Math.floor((now-(task.workflow?.startedAt||task.created||last))/60000));
     this.pending=this.pending.filter(entry=>entry.taskId!==id||entry.state!=='progress');
     this.pending.push({at:now,taskId:id,state:'progress',text:taskLabel(task)+' is still going, '+minutes+' minutes in.'});
    }
   }
  }else this.pending=this.pending.filter(entry=>entry.state!=='progress');
  if(this.inputOpen||now-this.lastInput<SILENCE)return;
  // Not while a hand-off is being worked out or its "Starting…" window is open, within a moment of another line for
  // Live to say, or while Live is mid-sentence: a result sent a second before a "Starting…" line was never said
  // (2026-11-26 test call). One spoken line per pass; the next pass sends the next.
  const call=this.call;
  if(!call.paused&&(call.routing||call.staged?.undo||now-(call.commentedAt??-Infinity)<LINE_GAP||now-(call.liveSaidAt??-Infinity)<SILENCE))return;
  if(!this.call.paused)answers.resume({recentInput:now-this.lastInput<=RECENT});
  // An open hand-off past the cap, or whose task was stopped, is closed by Live in its own voice. The call can then
  // go to standby; that task's news comes later through a fresh session (see below).
  if(this.open.size&&!this.call.paused){
   let tasks=null;
   for(const [id,entry] of [...this.open]){
    if(this.pending.some(item=>item.taskId===id&&!['needs input','progress'].includes(item.state)))continue;
    const task=(tasks??=new Map(readTasks().map(task=>[task.id,task]))).get(id);
    if(task&&['stopped','closed'].includes(task.state))entry.stoppedAt??=now;else delete entry.stoppedAt;
    const stopped=entry.stoppedAt!==undefined&&now-entry.stoppedAt>=STOPPED_GRACE_MS;
    if(!stopped&&now-entry.at<HANDOFF_CAP_MS)continue;
    this.open.delete(id);
    const label=task?taskLabel(task):'That task';
    answers.speak(entry.delegation,stopped?`${label} was stopped.`:`${label} is still working. I'll tell you when it's done.`);
    return;
   }
  }
  while(this.pending.length&&now-this.pending[0].at>=BATCH){
   const boundary=this.pending[0].at+BATCH;
   const all=this.pending.filter(item=>item.at<=boundary);
   this.pending=this.pending.slice(all.length);
   // A task whose hand-off is still open: its news goes on that hand-off, one each, so Live says it in its own voice.
   const batch=[],later=[];let spoke=false;
   for(const item of all){
    const entry=!this.call.paused&&!['needs input','progress'].includes(item.state)?this.open.get(item.taskId):null;
    if(!entry){batch.push(item);continue}
    if(spoke){later.push(item);continue}
    this.open.delete(item.taskId);
    answers.speak(entry.delegation,item.text);spoke=true;
   }
   // The rest wait for the next pass, in their order.
   if(spoke){this.pending.unshift(...later,...batch);return}
   if(!batch.length)continue;
   const prefix=now-this.lastInput<=RECENT?'By the way, ':'';
   const parts=batch.map(item=>{
    const outcome=item.outcome?.replace(/[.!?]$/,'');
    if(item.state==='done')return item.label+' is done'+(outcome?': '+outcome:'');
    if(item.state==='failed')return item.label+" didn't finish"+(outcome?': '+outcome:'')+' (open the task for the next step)';
    if(item.state==='needs input')return item.label+' needs your OK in the terminal tray';
    return item.text.replace(/[.!?]$/,'');
   });
   const text=prefix+(batch.length===1?batch[0].text:new Intl.ListFormat('en').format(parts)+'.');
   if(this.call.paused){
    // Standby only wakes on the caller's voice: an update sent to Live now is held until they speak (tested on
    // real calls, 2026-11-26: no append, response.create or setting wakes it). A fresh session starts awake, so the
    // call is renewed and the held news is said there, in Live's voice (the renewal carries held lines over).
    // If no renewal can start, the caller's own screen says it in the local voice.
    if(this.call.requestWake?.()){answers.speak(null,text);continue}
    this.announce(text);
    continue;
   }
   answers.append('thinking',null,text);
   answers.speak(null,text);
   return;
  }
 }
}
