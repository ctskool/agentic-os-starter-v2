import {createResourceCache} from '../../shared/resource-cache.mjs';
import {createWorkFeed,taskSummary} from '../../shared/work-feed.mjs';
import {v2VoiceTransport} from './v2-voice';
import {validateSelection,SKILLS} from '../../shared/contract.mjs';
import {readDraft,saveDraft,type DraftStorage} from '../../shared/drafts';
import type {VoiceSelection} from '../../shared/voice-session';
import {createWorkConversations} from '../../shared/work-conversations';
export interface WorkTask {pid?:number|null;inputReason?:string;recoveryAvailable?:boolean;execution?:string;workflow?:{destination?:string};keep?:boolean;lastActivityAt?:number;expiresAt?:number|null;id:string;title:string;provider:'codex'|'claude';model:string;state:string;sessionId:string|null;error:string|null;turns:{id:string;ts:number;text:string}[]}
export interface RecoveredWorkRequest {prompt:string;title?:string;selection:VoiceSelection;skill?:string;args?:Record<string,string>}
export function isLiveTerminal(task:WorkTask){return !['script','headless'].includes(task.execution||'')&&(task.pid?true:!['stopped','error'].includes(task.state))}
export function scriptStatus(task:WorkTask){
 if(task.state==='stopping')return 'Stopping the data script…';
 if(['starting','working'].includes(task.state))return 'Running the data script…';
 if(task.error||task.state==='error')return 'The source refresh did not complete. Review the message below.';
 return task.turns.length?'Script finished. Its result is saved below.':'This source refresh is stopped.';
}
export function checkedRecovery(value:unknown):RecoveredWorkRequest{
 if(!value||typeof value!=='object')throw new Error('The saved request is unavailable.');
 const data=value as RecoveredWorkRequest;
 if(typeof data.prompt!=='string'||!data.prompt.trim()||data.prompt.length>12000)throw new Error('The saved request has invalid text.');
 const selection=validateSelection(data.selection) as VoiceSelection;
 if(data.skill&&(!SKILLS[data.skill]||!data.args||typeof data.args!=='object'||Array.isArray(data.args)||Object.values(data.args).some(value=>typeof value!=='string')))throw new Error('The saved workflow settings are invalid.');
 return {prompt:data.prompt,selection,...(data.title?{title:String(data.title)}:{}),...(data.skill?{skill:data.skill,args:data.args}:{})};
}
export function readRecovery(storage:DraftStorage,key:string){
 const raw=storage.getItem(key+':selection');if(!raw)return null;
 const prompt=readDraft(storage,key);if(!prompt.trim())return null;
 const parsed=JSON.parse(raw),saved=checkedRecovery(parsed.selection?parsed:{prompt,selection:parsed});
 if(saved.prompt!==prompt)throw new Error('The recovered request and its settings no longer match. Recover it again before submitting.');
 return saved;
}
export function preserveRecovery(storage:DraftStorage,key:string,request:RecoveredWorkRequest){
 const saved=checkedRecovery(request),previous=storage.getItem(key+':selection');
 storage.setItem(key+':selection',JSON.stringify(saved));
 if(!saveDraft(storage,key,saved.prompt)){
  try{if(previous===null)storage.removeItem(key+':selection');else storage.setItem(key+':selection',previous)}catch{}
  throw new Error('Could not preserve the recovered request.');
 }
 return saved;
}
export async function workRequest(path:string,data?:unknown){
 const r=await v2VoiceTransport('/work'+path,data===undefined?{}:{method:'POST',body:JSON.stringify(data)});
 if(r.status!==200)throw new Error(r.json?.error||'Work service is offline. Start the V2 bridge.');return r.json;
}
const conversationSessionId=crypto.randomUUID();
let workSessionMode:'native'|'preview'='native',workSessionStarted=false;
// The component preview reads the web selection, but does not own a new app
// session. Configure it before mounting components that load the work feed.
export function configureWorkSession(mode:'native'|'preview'){
 if(workSessionStarted)throw new Error('Configure the work session before loading conversations.');
 workSessionMode=mode;
}
export const workFeed=createWorkFeed(async(path:string)=>{await workConversations.startSession();const snapshot=await workRequest(path);workConversations.sync(snapshot);return snapshot});
export const workConversations=createWorkConversations({
 initialProvider:'codex',getSnapshot:()=>workFeed.getSnapshot(),
 readFresh:()=>workRequest('?summary=1'),persist:(provider,id)=>workRequest('/current',{provider,id}),
 startSession:()=>{workSessionStarted=true;return workSessionMode==='preview'?workRequest('/current'):workRequest('/session',{sessionId:conversationSessionId})},
 publish:snapshot=>workFeed.publish(snapshot),
 onChange:()=>window.dispatchEvent(new Event('aos-work-target')),
});
export const workTarget=(provider?:'codex'|'claude')=>workConversations.target(provider);
export const setWorkProvider=(provider:'codex'|'claude')=>workConversations.setProvider(provider);
export async function refreshWorkConversations(){
 const snapshot=await workFeed.refresh();
 if(snapshot.error)throw new Error(snapshot.error);
 if(!snapshot.current||!Number.isSafeInteger(snapshot.currentRevision))throw new Error('Conversation state is unavailable. Refresh the dashboard and try again.');
 workConversations.sync(snapshot);return snapshot;
}
export function publishWorkTask(task:WorkTask){
 const snapshot=workFeed.getSnapshot();workFeed.publish({...snapshot,tasks:[taskSummary(task),...snapshot.tasks.filter((existing:WorkTask)=>existing.id!==task.id)]});
}
export function chooseWork(id:string|null,provider?:'codex'|'claude'){
 const task=workFeed.getSnapshot().tasks.find((task:WorkTask)=>task.id===id) as WorkTask|undefined;
 if(task&&['script','headless'].includes(task.execution||''))return;
 if(id&&!provider&&!task){window.dispatchEvent(new CustomEvent('aos-work-error',{detail:'This conversation is still loading. Select it again once its terminal appears.'}));return}
 void workConversations.choose(id,provider||task?.provider).catch(error=>window.dispatchEvent(new CustomEvent('aos-work-error',{detail:String(error.message||error)})));
}
export function openWork(ids:string[]=[]){void workFeed.refresh();window.dispatchEvent(new CustomEvent('aos-open-work',{detail:ids}))}
const answers=createResourceCache(30000);
export async function fullAnswer(task:WorkTask){const turn=task.turns.at(-1);if(!turn)return '';if(!(turn as any).truncated)return turn.text;return answers.read(task.id+':'+turn.id,async()=>(await workRequest('/answer?id='+encodeURIComponent(task.id)+'&turn='+encodeURIComponent(turn.id))).text) as Promise<string>;}
