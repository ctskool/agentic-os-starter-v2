import {taskLabel,taskUpdate,shortOutcome} from '../task-updates.mjs';

const SILENCE=1200,BATCH=3000,RECENT=10000,CHECK_IN=180000;

export class LiveTaskUpdates {
 constructor(call){this.call=call;this.jobs=new Map();this.pending=[];this.lastInput=-Infinity;this.inputOpen=false;this.lastResult=null}
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
  if(!this.call.paused)answers.resume({recentInput:now-this.lastInput<=RECENT});
  while(this.pending.length&&now-this.pending[0].at>=BATCH){
   const boundary=this.pending[0].at+BATCH;
   const batch=this.pending.filter(item=>item.at<=boundary);
   this.pending=this.pending.slice(batch.length);
   const prefix=now-this.lastInput<=RECENT?'By the way, ':'';
   const parts=batch.map(item=>{
    const outcome=item.outcome?.replace(/[.!?]$/,'');
    if(item.state==='done')return item.label+' is done'+(outcome?': '+outcome:'');
    if(item.state==='failed')return item.label+" didn't finish"+(outcome?': '+outcome:'')+' (open the task for the next step)';
    if(item.state==='needs input')return item.label+' needs your OK in the terminal tray';
    return item.text.replace(/[.!?]$/,'');
   });
   const text=prefix+(batch.length===1?batch[0].text:new Intl.ListFormat('en').format(parts)+'.');
   answers.append('thinking',null,text);
   answers.speak(null,text);
  }
 }
}
