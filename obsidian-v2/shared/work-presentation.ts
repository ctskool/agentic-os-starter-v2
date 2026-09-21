/** UI-only task presentation. These helpers never resume, stop or route work. */
export interface WorkPresentationTask {
 state:string;
 pid?:number|null;
 execution?:string;
 title?:string;
 provider?:string;
 /** Set by the bridge when it closed a finished terminal that sat idle at its prompt. */
 idleStoppedAt?:number|null;
}

/** An error can still have a live CLI awaiting a response. Keep it accessible. */
export function isOpenWork(task:WorkPresentationTask|null|undefined):boolean {
 if(!task)return false;
 const hasProcess=typeof task.pid==='number'&&Number.isFinite(task.pid)&&task.pid>0;
 return hasProcess||!['stopped','error'].includes(task.state);
}

export function isHistoryWork(task:WorkPresentationTask|null|undefined):boolean {
 return !!task&&!isOpenWork(task);
}

const statusLabels:Record<string,string>={
 starting:'Starting',working:'Working','needs input':'Needs input',ready:'Ready',
 editing:'Editing',stopping:'Stopping',stopped:'Closed',error:'Needs attention',
};

/** Closed describes the terminal lifecycle, never the success of an old answer. */
export function taskStatus(task:WorkPresentationTask|null|undefined):string {
 if(!task)return 'No task selected';
 if(task.state==='stopped'&&typeof task.idleStoppedAt==='number'&&Number.isFinite(task.idleStoppedAt))return 'Closed (idle)';
 const label=statusLabels[task.state];return typeof label==='string'?label:'Status unknown';
}
export const workLabel=taskStatus;

export function shortTaskTitle(task:WorkPresentationTask,limit=64):string {
 const fallback=task.execution==='script'?'Source refresh':task.provider==='codex'?'Codex task':task.provider==='claude'?'Claude task':'Agent task';
 const title=typeof task.title==='string'?task.title.replace(/\s+/g,' ').trim():'';
 const chars=Array.from(title||fallback),size=Number.isFinite(limit)?Math.max(1,Math.floor(limit)):64;
 return chars.length>size?chars.slice(0,size-1).join('')+'…':chars.join('');
}

/** Compact voice labels only; the stored request and terminal title stay intact. */
export function shortConversationTitle(task:WorkPresentationTask,limit=52):string {
 const original=typeof task.title==='string'?task.title.replace(/\s+/g,' ').trim():'';
 const title=original
  .replace(/^(?:hey|hi|okay|ok|alright)[,!:.]?\s+/i,'')
  .replace(/^(?:(?:can|could|would) you (?:please )?|are you able to |i(?:'d| would) like (?:you )?to |please )/i,'')
  .trim()||original||'Untitled conversation';
 const display=title.charAt(0).toUpperCase()+title.slice(1);
 const chars=Array.from(display),size=Number.isFinite(limit)?Math.max(1,Math.floor(limit)):52;
 return chars.length>size?chars.slice(0,size-1).join('')+'…':chars.join('');
}
