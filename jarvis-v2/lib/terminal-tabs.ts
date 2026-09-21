import {isOpenWork} from '../../obsidian-v2/shared/work-presentation';
import type {WorkTask} from './work';

export function visibleTerminalTabs(tasks:WorkTask[],opened:readonly string[],hidden:readonly string[],target:string|null):WorkTask[] {
  const openIds=new Set(opened),hiddenIds=new Set(hidden);
  // A running terminal always has a tab, so the "N open" count is what is on screen. Hiding only removes the tab of
  // a conversation that is not running; a tab that is being stopped stays until the bridge confirms, then goes.
  return tasks.filter(task=>task.execution!=='headless'&&!task.background&&(isOpenWork(task)||!hiddenIds.has(task.id)&&(openIds.has(task.id)||task.id===target)));
}

// What the × on a tab does. A terminal that is idle at its prompt is ended at once; one that is busy asks once more
// first; a conversation that is not running only loses its tab. Ending a terminal never deletes the conversation:
// it stays in History, Resume reopens it and a voice follow-up continues it.
export type TabCloseAction='remove'|'stop'|'confirm-stop'|'wait';
export function tabCloseAction(task:WorkTask|null|undefined):TabCloseAction {
  if(!task||!isOpenWork(task))return 'remove';
  if(task.state==='stopping')return 'wait';
  return task.state==='ready'?'stop':'confirm-stop';
}

// Open sessions stay in this page's tab strip after closing; old saved sessions
// enter it only when explicitly selected. Neither operation starts a process.
export function rememberOpenTerminals(opened:string[],tasks:WorkTask[],target:string|null):string[] {
  // Event IDs can arrive before their first summary (including immediate start
  // failures). Retain them until the user closes the tab or this page unloads.
  const background=new Set(tasks.filter(task=>task.execution==='headless'||task.background).map(task=>task.id));
  const next=[...new Set([...opened,...tasks.filter(task=>!background.has(task.id)&&isOpenWork(task)).map(task=>task.id),...(target?[target]:[])])].filter(id=>!background.has(id));
  return next.length===opened.length&&next.every((id,index)=>id===opened[index])?opened:next;
}
