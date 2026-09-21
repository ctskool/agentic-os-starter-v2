import React from 'react';
import {shortTaskTitle,taskStatus} from '../../obsidian-v2/shared/work-presentation';
import type {WorkTask} from '../lib/work';
import {tabCloseAction} from '../lib/terminal-tabs';

interface Props {
  tabs:WorkTask[];history:WorkTask[];target:string|null;historyOpen:boolean;loaded:boolean;
  onHistory:(open:boolean)=>void;onSelect:(id:string)=>void;onClose:(id:string)=>void;
  /** The tab whose × has been pressed once while its terminal is busy: the next press stops it. */
  armed?:string|null;
}
const closeHint={remove:'Remove this tab. The conversation stays in History.',stop:'Close: ends this terminal. The conversation stays in History.','confirm-stop':'This terminal is still busy. Press again to stop it; text typed in the CLI but not sent is lost.',wait:'Stopping…'} as const;
export function TerminalTabs({tabs,history,target,historyOpen,loaded,onHistory,onSelect,onClose,armed=null}:Props){
  return <>
    <div className="agent-session-nav">
      <nav className="agent-tabs" aria-label="Terminal tabs">
        {tabs.map(task=><div key={task.id} className={target===task.id?'selected':''}>
          <button aria-pressed={target===task.id} onClick={()=>onSelect(task.id)} title={task.title}>{shortTaskTitle(task)}<small>{task.execution==='script'?'Source refresh':task.provider==='codex'?'Codex':'Claude Code'} · {taskStatus(task)}</small></button>
          <button className={armed===task.id?'is-armed':undefined} aria-label={armed===task.id?`Stop and close: ${task.title}`:`Close tab: ${task.title}`} title={closeHint[tabCloseAction(task)]} disabled={task.state==='stopping'} onClick={()=>onClose(task.id)}>{armed===task.id?'Stop?':'×'}</button>
        </div>)}
        {!tabs.length&&<span className="agent-tabs-empty">{loaded?'No open terminals':'Connecting…'}</span>}
      </nav>
      <button className="agent-history-toggle" aria-expanded={historyOpen} aria-controls="terminal-history" onClick={()=>onHistory(!historyOpen)}>History</button>
    </div>
    {historyOpen&&<section className="agent-history" id="terminal-history" aria-label="Terminal history">
      <div className="agent-history-list">{history.map(task=><button key={task.id} aria-pressed={target===task.id} onClick={()=>{onSelect(task.id);onHistory(false)}}>
        <span>{shortTaskTitle(task,110)}</span><small>{task.provider==='codex'?'Codex':'Claude Code'} · {taskStatus(task)}{task.keep?' · Kept':''}</small>
      </button>)}</div>
      {!history.length&&<p>{loaded?'No saved terminals yet.':'Loading history…'}</p>}
      <p>Opening history does not resume a session. Stopped tasks clear after 7 days. Keep saves them.</p>
    </section>}
  </>;
}
