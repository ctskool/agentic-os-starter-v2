"use client";
import {useEffect,useState} from 'react';
import {activityElapsed,activityMessage,createTaskActivity,TASK_ACTIVITY_TTL,type TaskActivity} from '../../obsidian-v2/shared/task-activity';
import {openWork,type WorkTask} from '@/lib/work';

export function TaskActivityBar({tasks,ready,viewing}:{tasks:WorkTask[];ready:boolean;viewing:string|null}){
  const [tracker]=useState(createTaskActivity);
  const [entries,setEntries]=useState<TaskActivity[]>([]);
  const [toasts,setToasts]=useState<TaskActivity[]>([]);
  const [viewed,setViewed]=useState<Record<string,string>>({});
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{
    if(!ready)return;
    const {entries,changes}=tracker.update(tasks);
    setEntries(entries);
    const seenAt=Date.now(),keys=new Set(entries.map(entry=>entry.key));
    setToasts(previous=>[
      ...previous.filter(item=>keys.has(item.key)&&(item.state==='needs input'||seenAt-item.since<5000)),
      ...changes.map(item=>({...item,since:seenAt}))
    ]);
    setNow(seenAt);
  },[tasks,ready,tracker]);
  useEffect(()=>{
    const task=entries.find(entry=>entry.task.id===viewing&&entry.state==='needs input');
    if(!task)return;
    setViewed(previous=>previous[task.task.id]===task.key?previous:{...previous,[task.task.id]:task.key});
    setToasts(previous=>previous.some(item=>item.key===task.key)?previous.filter(item=>item.key!==task.key):previous);
  },[entries,viewing]);
  const visible=entries.filter(entry=>entry.state==='working'||entry.state==='needs input'||now-entry.since<TASK_ACTIVITY_TTL);
  const ticking=visible.length>0;
  useEffect(()=>{
    if(!ticking)return;
    const timer=setInterval(()=>setNow(Date.now()),1000);
    return()=>clearInterval(timer);
  },[ticking]);
  const view=(entry:TaskActivity)=>{
    setViewed(previous=>({...previous,[entry.task.id]:entry.key}));
    setToasts(previous=>previous.filter(item=>item.key!==entry.key));
    openWork([entry.task.id],true);
  };
  return <>
    <div className="agent-task-chips" aria-label="Task status">
      {visible.map(entry=>{
        const {task,state,key,since}=entry,elapsed=activityElapsed(entry,now);
        const finishing=state==='done'||state==='failed';
        return <button key={key} className="agent-task-chip" data-state={state} data-unread={state==='needs input'&&viewed[task.id]!==key}
          data-expiring={finishing&&now-since>=TASK_ACTIVITY_TTL-1000} title={task.title} aria-label={task.title+' · '+state+' · '+elapsed} onClick={()=>view(entry)}>
          <span aria-hidden="true" className="agent-task-dot"/><span>{task.title}</span><time>{elapsed}</time>
        </button>;
      })}
    </div>
    <div className="agent-task-toasts" aria-live="polite">
      {toasts.filter(item=>item.state==='needs input'||now-item.since<5000).map(item=><div key={item.key} className="agent-task-toast" data-state={item.state}>
        <span className="agent-task-dot" aria-hidden="true"/><span>{activityMessage(item)}</span><button onClick={()=>view(item)}>View</button>
      </div>)}
    </div>
  </>;
}
