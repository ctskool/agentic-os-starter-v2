import {createResourceCache} from '../../obsidian-v2/shared/resource-cache.mjs';
import {createWorkFeed} from '../../obsidian-v2/shared/work-feed.mjs';
import {bridge} from './bridge';
import type {VoiceReply,VoiceSelection} from '../../obsidian-v2/shared/voice-session';
import {createWorkConversations,type ConversationProvider,type ConversationSnapshot} from '../../obsidian-v2/shared/work-conversations';

export interface WorkTask {
  id:string; title:string; provider:'codex'|'claude'; model:string;
  state:string; sessionId:string|null; error:string|null; pid?:number|null;
  keep:boolean; lastActivityAt:number; expiresAt:number|null;
  /** Set when the bridge closed this finished terminal after it sat idle at its prompt. */
  idleStoppedAt?:number|null;
  inputReason?:string|null; recoveryAvailable?:boolean; execution?:'script'|'cli'|'headless'; background?:boolean; workflow?:{destination:string};
  turns:{id:string;ts:number;text:string}[];
}
export const workRequest=(path='',body?:unknown)=>bridge('/work'+path,body);
const conversationSessionId=crypto.randomUUID();
const feed=createWorkFeed(async(path:string)=>{await workConversations.startSession();return workRequest(path)});
const models={codex:'gpt-6-astra',claude:'sonnet'};
const changed=()=>{if(typeof window!=='undefined')window.dispatchEvent(new Event('jarvis-work-target'))};
export const workConversations=createWorkConversations({
  getSnapshot:()=>feed.getSnapshot(),readFresh:()=>workRequest('?summary=1'),
  startSession:()=>workRequest('/session',{sessionId:conversationSessionId,mode:'adopt'}),
  persist:(provider,id)=>workRequest('/current',{provider,id}),publish:snapshot=>feed.publish(snapshot),onChange:changed,
});
export const workFeed={...feed,subscribe:(listener:(snapshot:any)=>void)=>feed.subscribe((snapshot:ConversationSnapshot)=>{workConversations.sync(snapshot);listener(snapshot)})};
export const workProvider=()=>workConversations.provider();
export const workTarget=(provider?:ConversationProvider)=>workConversations.target(provider);
export const workSelectionError=()=>workConversations.error()||'';
export function setWorkProvider(provider:ConversationProvider,model?:string){if(model)models[provider]=model;workConversations.setProvider(provider)}
export function chooseWork(id:string|null,provider?:ConversationProvider){return workConversations.choose(id,provider)}
export function syncWorkReply(reply:Pick<VoiceReply,'current'|'currentRevision'>){
  const snapshot={...feed.getSnapshot(),current:reply.current,currentRevision:reply.currentRevision};
  // Publishing also invalidates an older in-flight poll. Dirty local choices
  // stay optimistic in the controller until their ordered writes are confirmed.
  if(workConversations.sync(snapshot))feed.publish(snapshot);
}
export function openWork(ids:string[]=[],spoken=false){
  // Successful dispatch already selected its own provider on the bridge. A late
  // reply may open its view, but must not overwrite the current top provider.
  if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('jarvis-open-work',{detail:{ids,spoken}}));
  void workFeed.refresh().catch(()=>{});
}
export async function setWorkKeep(id:string,keep:boolean){
  const result=await workRequest('/keep',{id,keep});
  const snapshot=workFeed.getSnapshot();
  workFeed.publish({...snapshot,tasks:snapshot.tasks.map((task:WorkTask)=>task.id===id?{...task,keep:result.keep,lastActivityAt:result.lastActivityAt,expiresAt:result.expiresAt}:task)});
  await workFeed.refresh();
  return result;
}
// Capture the visible provider/model and its target synchronously, before reads.
export function getWorkSelection():Promise<VoiceSelection>{
  const provider=workProvider();return workConversations.getSelection({provider,model:models[provider]});
}
const answers=createResourceCache(30000);
export async function fullAnswer(task:WorkTask){const turn=task.turns.at(-1);if(!turn)return '';if(!(turn as any).truncated)return turn.text;return answers.read(task.id+':'+turn.id,async()=>(await workRequest('/answer?id='+encodeURIComponent(task.id)+'&turn='+encodeURIComponent(turn.id))).text) as Promise<string>;}
