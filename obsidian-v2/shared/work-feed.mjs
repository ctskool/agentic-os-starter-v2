import {createPollStore} from './poll-store.mjs';
// One feed per client runtime; full answers are fetched only by consumers that need them.
export function createWorkFeed(request){
 const store=createPollStore({initial:{tasks:[],vault:'',error:''},intervalMs:1500,
  load:async()=>{try{const result=await request('?summary=1');return {...result,tasks:result.tasks.filter(task=>task.execution!=='headless'&&!task.background),error:''}}catch(e){return {...store.getSnapshot(),error:String(e.message||e)}}}
 });
 return store;
}
export function taskSummary(task){
 const last=task.turns.at(-1);
 return {id:task.id,title:task.title,provider:task.provider,model:task.model,state:task.state,keep:task.keep===true,lastActivityAt:task.lastActivityAt,expiresAt:task.expiresAt??null,
  sessionId:task.sessionId,error:task.error,pid:task.pid,idleStoppedAt:task.state==='stopped'&&Number.isFinite(task.idleStoppedAt)?task.idleStoppedAt:undefined,inputReason:task.inputReason,recoveryAvailable:task.recoveryAvailable,execution:task.execution,background:task.background===true,workflow:task.workflow?.destination?{destination:task.workflow.destination}:undefined,
  turns:last?[{id:last.id,ts:last.ts,text:last.text.slice(0,650),truncated:last.text.length>650}]:[]};
}
