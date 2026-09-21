import {ItemView,WorkspaceLeaf,type ViewStateResult} from 'obsidian';
import {h,render} from 'preact';
import {WorkPane} from './components/WorkPane';
import {readSelection} from './lib/provider';
import {assertVoiceVault} from './lib/v2-voice';
import {workFeed,type WorkTask} from './lib/work';
import {shortTaskTitle,taskStatus} from '../shared/work-presentation';
import type ChaseCommandCenter from './main';
export const WORK_VIEW='aos-v2-work';
export class WorkView extends ItemView {
 taskId:string|null=null;
 private title='Terminals';
 private mounted=false;
 private unsubscribe?:()=>void;
 constructor(leaf:WorkspaceLeaf,private plugin:ChaseCommandCenter){super(leaf)}
 getViewType(){return WORK_VIEW}
 getDisplayText(){return this.title}
 getIcon(){return 'terminal'}
 getState(){return {taskId:this.taskId,title:this.title}}
 async setState(state:unknown,result:ViewStateResult){
  const saved=state as {taskId?:unknown;title?:unknown}|null;
  this.taskId=typeof saved?.taskId==='string'&&saved.taskId?saved.taskId:null;
  this.title=this.taskId&&typeof saved?.title==='string'?saved.title:'Terminals';
  if(this.mounted){this.mount();this.updateTitle()}
  await super.setState(state,result);
 }
 private getSelection=async()=>{await assertVoiceVault(this.app);return readSelection(this.app)};
 private openTask=(id:string|null)=>{void this.plugin.activateWork([id])};
 private mount(){render(<WorkPane app={this.app} taskId={this.taskId} onOpenTask={this.openTask} getSelection={this.getSelection}/>,this.contentEl)}
 private updateTitle=()=>{
  const task=workFeed.getSnapshot().tasks.find((t:WorkTask)=>t.id===this.taskId) as WorkTask|undefined;
  const title=task?`${shortTaskTitle(task,38)} · ${taskStatus(task)}`:this.taskId?this.title:'Terminals';
  if(title===this.title)return;
  this.title=title;
  // Refresh the native tab label only when its title/status actually changes.
  // A restored leaf can retain active:true in its saved view state. Updating a
  // background task's title must never replay that old focus request.
  void this.leaf.setViewState({...this.leaf.getViewState(),active:false,state:this.getState()});
 };
 async onOpen(){
  this.contentEl.empty();this.contentEl.addClass('aos-work-view');
  try{await assertVoiceVault(this.app);this.mounted=true;this.mount();this.unsubscribe=workFeed.subscribe(this.updateTitle)}
  catch(e){this.contentEl.setText(String(e))}
 }
 async onClose(){this.mounted=false;this.unsubscribe?.();this.unsubscribe=undefined;render(null,this.contentEl)}
}
