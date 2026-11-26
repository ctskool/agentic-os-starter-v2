import {SKILLS} from '../shared/contract.mjs';
import {statusIntent} from './voice-stop.mjs';

export function taskLabel(task){
 const workflow=SKILLS[task?.workflow?.job?.skill||task?.workflow?.skill||task?.skill]?.label;
 const title=String(task?.title||task?.label||'').replace(/\s+/g,' ').trim();
 const id=task?.taskId||task?.id;
 return workflow||(title&&title!==id?title.slice(0,70):'Task');
}
export const taskRunning=task=>['starting','working','needs input','stopping'].includes(task.state)||task.status==='running';
const sentence=text=>/[.!?…]$/.test(text)?text:text+'.';
const max=(text,limit)=>text.length>limit?text.slice(0,limit-1).trimEnd()+'…':text;

export function shortOutcome(value,count=1){
 const text=String(value||'').trim().replace(/^BLOCKED:\s*/i,'')
  .replace(/!?\[([^\]]+)\]\([^)]+\)/g,'$1')
  .replace(/^[#>*-]+\s+/gm,'').replace(/[\x60*_]/g,'').replace(/\s+/g,' ').trim();
 const parts=text.match(/.+?(?:[.!?](?=\s|$)|$)/g)?.slice(0,count).join('').trim()||'';
 return max(parts,count===1?150:260);
}

// The worker's own opening, for a Live call to put in its own words: its first paragraph, up to three sentences.
// (2026-11-26 test calls: the two-sentence summary cut a calendar answer off at "today", and the local-voice summary
// replaced a useful result with "There are important limitations in the result".)
export function replyOpening(text){
 const first=String(text||'').replace(/^BLOCKED:\s*/i,'').split(/\n\s*\n/).map(part=>part.trim()).find(part=>part&&!/^#{1,6}\s/.test(part))||'';
 const clean=first.replace(/!?\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/^[#>*-]+\s+/gm,'').replace(/[\x60*_]/g,'').replace(/\s+/g,' ').trim();
 const plain=clean.match(/.+?(?:[.!?](?=\s|$)|$)/g)?.slice(0,3).join('').trim()||'';
 return plain.length>=12?max(plain,450):'';
}
export function taskUpdate(item){
 const label=item.label||'Task';
 const value=String(item.summary||item.text||'').trim();
 const outcome=item.reply||shortOutcome(value,2);
 const reason=shortOutcome(value)||'the worker stopped before returning a result';
 if(item.kind==='attention')return {state:'needs input',text:label+" needs your OK. It's in the terminal tray."};
 // A result whose file link couldn't be checked still finished: only a real failure is told as one.
 const failed=item.failed===false?false:['error','completion-error'].includes(item.kind)||/^BLOCKED:/i.test(value);
 if(failed)return {state:'failed',text:label+" didn't finish: "+sentence(reason)+' Open the task to see what to try next.'};
 return {state:'done',text:label+' is done: '+sentence(outcome||'see the result on screen')};
}

const statusPattern=/^(?:(?:hey|please|so)[,\s]+)*(?:(?:how(?:['’]?s| is) (?:it|that|(?:the )?.+? task) going|(?:is|was) (?:it|that|(?:the )?.+? task) (?:done|finished)(?: yet)?|(?:what(?:['’]?s| is)|which tasks? (?:are|is)) running(?: right now)?)|(?:what(?:['’]?s| is) (?:the )?)?status (?:of|on) (?:the )?(.+?))[\s.!?]*$/i;

export function taskStatusReply(text,readTasks,callIds=[],now=Date.now()){
 const match=statusPattern.exec(text.trim());
 // The pattern above covers the short forms. People also ask loosely ("What's going on? Why is this taking so
 // long", "where are we at with that"): those were handed to the working task they asked about, and since follow-ups
 // wait for a working task the caller heard "I'll add that as soon as that task is free" (Chase's call, 2026-11-24).
 // A loose question gets every running task and what this call has finished, and is left to the model when there
 // is neither, since "how are things going" can also be small talk.
 if(!match){
  if(!statusIntent(text))return null;
  const tasks=readTasks(),byId=new Map(tasks.map(task=>[task.id,task]));
  const active=tasks.filter(taskRunning).sort((a,b)=>(a.state==='needs input'?0:1)-(b.state==='needs input'?0:1)||(b.created||0)-(a.created||0));
  const ended=[...callIds].reverse().map(id=>byId.get(id)).filter(task=>task&&!taskRunning(task));
  if(!active.length&&!ended.length)return null;
  const since=ts=>Math.max(0,Math.floor((now-(ts??now))/60000));
  // A workflow has a name, and so does a task Claude Code has titled. Anything else is known only by the words it
  // was asked in, so it is quoted as a request.
  const name=task=>{const label=taskLabel(task);return SKILLS[task?.workflow?.job?.skill||task?.workflow?.skill||task?.skill]||task?.titleSource==='session'?label:'Your request “'+(label.length>60?label.slice(0,60).trimEnd()+'…':label)+'”'};
  const working=task=>name(task)+(task.state==='needs input'?' needs your OK. It’s in the terminal tray.'
   // A conversation that has answered before is on a follow-up: its age is not how long this turn has run.
   :task.turns?.length&&!task.workflow?' is still working on your follow-up.':' is still running, '+since(task.workflow?.startedAt||task.created)+' min in.')
   +(task.queuedFollowups?(task.queuedFollowups===1?' One more request is':' '+task.queuedFollowups+' more requests are')+' waiting behind it.':'');
  const finished=task=>name(task)+(task.state==='error'||task.workflowStatus==='error'?' didn’t finish.':task.turns?.length||task.workflowStatus==='ok'?' is done.':' was stopped.');
  return {reply:[...active.slice(0,4).map(working),...ended.slice(0,3).map(finished)].join(' ')};
 }
 const tasks=readTasks(),byId=new Map(tasks.map(task=>[task.id,task]));
 const recent=[...callIds].reverse().map(id=>byId.get(id)).filter(Boolean);
 const running=tasks.filter(taskRunning).sort((a,b)=>(b.created||0)-(a.created||0));
 const selected=[...new Set([...recent,...running])];
 const named=match[1]||/(?:the )?(.+?) task(?: going| (?:done|finished))/i.exec(text.replace(/^(?:how(?:['’]?s| is)|is|was) /i,''))?.[1];
 const namedTask=named?.toLowerCase().replace(/^(?:the|my)\s+/,'').replace(/\s+task$/,'').trim();
 const needle=/^(?:it|that|this|the current|current|latest)$/.test(namedTask||'')?null:namedTask;
 const candidates=needle?selected.filter(task=>taskLabel(task).toLowerCase().includes(needle)) : selected;
 const all=/^(?:(?:hey|please|so)[,\s]+)*(?:what(?:['’]s| is)|which tasks? (?:are|is)) running/i.test(text.trim());
 const task=candidates[0];
 const minutes=ts=>Math.max(0,Math.floor((now-(ts??now))/60000));
 const progress=t=>taskLabel(t)+(t.state==='needs input'?' needs your OK. It’s in the terminal tray.':' is still running, '+minutes(t.workflow?.startedAt||t.created)+' min in.');
 let reply='Nothing is running right now.';
 if(all&&running.length)reply=selected.filter(taskRunning).map(progress).join(' ');
 else if(!all&&taskRunning(task||{}))reply=progress(task);
 else if(!all&&task){
  const turn=task.turns?.at(-1);
  const outcome=shortOutcome(task.error||(turn?.ts>(task.completedAt??0)?turn.text:task.summary||turn?.text));
  reply=taskLabel(task)+' finished '+minutes(Math.max(task.completedAt??0,turn?.ts??0)||task.lastActivityAt)+' min ago: '+sentence(outcome||(task.state==='error'?'see the terminal for the error':'see the result on screen'));
 }
 return {reply};
}
