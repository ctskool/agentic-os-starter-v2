export interface ActivityTask {
 id:string;
 title:string;
 state:string;
 created?:number;
 lastActivityAt?:number;
 workflowStatus?:string;
 completedAt?:number;
 summary?:string;
 error?:string|null;
 turns?:{id:string;ts:number;text:string}[];
}
export type ActivityState='working'|'needs input'|'done'|'failed';
export interface TaskActivity {task:ActivityTask;state:ActivityState;since:number;key:string}
export const TASK_ACTIVITY_TTL=600000;
export const localTaskSpeech=(mode?:'local'|'live')=>mode!=='live';

export function activityState(task:ActivityTask):ActivityState|null {
 if(task.state==='needs input')return 'needs input';
 if(['starting','working','stopping'].includes(task.state))return 'working';
 const turn=task.turns?.at(-1);
 if(task.state==='error'||task.workflowStatus==='error'&&(!turn||turn.ts<=(task.completedAt??Infinity))||/^\s*BLOCKED:/i.test(turn?.text||''))return 'failed';
 return task.turns?.length||task.workflowStatus==='ok'?'done':null;
}
export function activityMessage({task,state}:TaskActivity){
 const suffix={working:' started','needs input':' needs your OK',done:' is done',failed:" didn’t finish"};
 const result=state==='failed'?task.error||task.summary||task.turns?.at(-1)?.text:state==='done'?task.summary||task.turns?.at(-1)?.text:'';
 const detail=result?.trim().replace(/^BLOCKED:\s*/i,'').split(/\r?\n/).find(line=>line.trim()&&line.trim()!=='---')?.replace(/^#+\s*/,'').slice(0,140);
 return (task.title||'Task')+suffix[state]+'.'+(detail?' '+detail:'');
}
export function activityElapsed({task,state,since}:TaskActivity,now:number){
 const seconds=Math.max(0,Math.floor(((state==='done'||state==='failed'?since:now)-(task.created??since))/1000));
 return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
}

export function createTaskActivity(){
 let primed=false,episode=0;
 let previous=new Map<string,TaskActivity&{signature:string}>();
 return {update(tasks:ActivityTask[],now=Date.now()){
  const entries:(TaskActivity&{signature:string})[]=[],changes:TaskActivity[]=[];
  for(const task of tasks){
   const state=activityState(task);if(!state)continue;
   const turn=task.turns?.at(-1),finished=state==='done'||state==='failed';
   const signature=state+':'+(finished?turn?.id||task.completedAt||'':'');
   const prior=previous.get(task.id),changed=prior?.signature!==signature;
   const endedAt=state==='done'?Math.max(turn?.ts??0,task.completedAt??0)||task.lastActivityAt:task.completedAt??task.lastActivityAt;
   const since=changed?(finished?endedAt:undefined)??now:prior.since;
   const key=changed?task.id+':'+ ++episode:prior.key;
   const entry={task,state,key,since,signature};entries.push(entry);
   if(primed&&changed&&(!finished||now-since<TASK_ACTIVITY_TTL))changes.push(entry);
  }
  primed=true;previous=new Map(entries.map(entry=>[entry.task.id,entry]));
  return {entries,changes};
 }};
}
