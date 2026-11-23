import {Notice} from 'obsidian';
import {activityMessage,createTaskActivity} from '../../shared/task-activity';
import {workFeed,type WorkTask} from './work';

export function showWorkNotice(message:string,open:()=>void,persistent=false){
 const content=document.createDocumentFragment();
 content.append(message+' ');
 const view=document.createElement('button');
 view.textContent='View';content.append(view);
 const notice=new Notice(content,persistent?0:5000);
 view.addEventListener('click',event=>{event.stopPropagation();notice.hide();open()});
 return notice;
}

export function subscribeWorkNotices(open:(id:string)=>void){
 const activity=createTaskActivity(),blockers=new Map<string,Notice>();
 const unsubscribe=workFeed.subscribe((snapshot:{vault:string;tasks:WorkTask[]})=>{
  if(!snapshot.vault)return;
  const {entries,changes}=activity.update(snapshot.tasks);
  for(const [id,notice] of blockers)if(!entries.some(entry=>entry.task.id===id&&entry.state==='needs input')){
   notice.hide();blockers.delete(id);
  }
  for(const entry of changes){
   const id=entry.task.id,blocker=entry.state==='needs input';
   const notice=showWorkNotice(activityMessage(entry),()=>{blockers.delete(id);open(id)},blocker);
   if(blocker)blockers.set(id,notice);
  }
 });
 return ()=>{unsubscribe();for(const notice of blockers.values())notice.hide()};
}
