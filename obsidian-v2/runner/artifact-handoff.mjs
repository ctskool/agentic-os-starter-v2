import {createHash} from 'node:crypto';
import {artifactContentKey} from './artifacts.mjs';
export const ARTIFACT_CLAIM_LEASE_MS=60000;

// UI delivery has its own durable receipts. Audio grouping, expiry and playback
// leases must never reopen a file or consume an unperformed UI action.
export class ArtifactHandoff {
 constructor({load=()=>({}),save=()=>{},now=Date.now,maxAgeMs=300000,claimLeaseMs=ARTIFACT_CLAIM_LEASE_MS,onExpired=null}={}){
  this.save=save;this.now=now;this.maxAgeMs=maxAgeMs;this.claimLeaseMs=claimLeaseMs;this.onExpired=onExpired;
  const state=load();this.targets=state.targets||{};this.items=Array.isArray(state.items)?state.items:[];
 }
 sweep(){
  const now=this.now();let changed=false;
  for(const item of this.items){
   if(item.state==='pending'&&now-item.createdAt>=this.maxAgeMs){item.state='expired';changed=true}
   if(item.state!=='claimed')continue;
   const claimedAt=Number.isFinite(item.claimedAt)?item.claimedAt:Number.isFinite(item.createdAt)?item.createdAt:0;
   if(now-claimedAt<this.claimLeaseMs)continue;
   // Never replay an opening whose response may have been lost. Retain a
   // durable outcome until the speech queue accepts its stable receipt ID.
   item.state='failed';item.completedAt=now;item.error='The viewer did not confirm opening the file in time.';item.outcomePending=true;changed=true;
  }
  if(changed)this.persist();
  if(this.onExpired)for(const item of this.items)if(item.state==='failed'&&item.outcomePending){
   this.onExpired(item);item.outcomePending=false;this.persist();
  }
 }
 persist(){this.items=this.items.slice(-500);this.save({version:1,targets:this.targets,items:this.items})}
 bind(taskId,target){if(target?.client)this.targets[taskId]={...target};else delete this.targets[taskId];this.persist()}
 remove(taskId){delete this.targets[taskId];this.items=this.items.filter(item=>item.artifact.taskId!==taskId);this.persist()}
 publish(task,turn,completionText=''){
  const target=this.targets[task.id];let added=0;
  for(const artifact of turn.artifacts||[]){
   if(!artifact.open||!target)continue;
   const content=artifactContentKey(artifact),id=createHash('sha256').update(`${task.id}:${turn.id}:${content}`).digest('hex');
   // Compare content identity as well as the receipt ID, including receipts
   // written before content-based delivery IDs were introduced.
   if(this.items.some(item=>item.id===id||item.artifact.taskId===task.id&&item.artifact.turnId===turn.id&&artifactContentKey(item.artifact)===content))continue;
   this.items.push({id,artifact,target:{...target},completionText:added===0?completionText:'',completionId:`${task.id}:${turn.id}`,createdAt:this.now(),state:'pending'});added++;
  }
  if(added)this.persist();return added;
 }
 claim(client,acceptTarget=()=>true){
  this.sweep();
  let changed=false,action=null;
  for(const item of this.items){
   if(item.state!=='pending')continue;
   if(this.now()-item.createdAt>=this.maxAgeMs){item.state='expired';changed=true;continue}
   if(action||item.target.client!==client||!acceptTarget(item.target,item.artifact))continue;
   // Persist before returning: a lost response/reloaded app must not steal
   // focus later. The file reference remains on its completed turn.
   item.state='claimed';item.claimedAt=this.now();changed=true;action=item;
  }
  if(changed)this.persist();return action;
 }
 ack(id,client,ok,error=''){
  const item=this.items.find(item=>item.id===id);
  if(!item||item.target.client!==client)throw new Error('Unknown artifact delivery');
  this.sweep();
  if(['opened','failed'].includes(item.state))return {item,fresh:false};
  if(item.state!=='claimed')throw new Error('Artifact delivery was not claimed');
  item.state=ok?'opened':'failed';item.completedAt=this.now();
  if(!ok)item.error=String(error||'The file could not be displayed.').slice(0,300);
  this.persist();return {item,fresh:true};
 }
}

export function artifactSpeech(artifacts,status,kind='web'){
 const noun=artifacts.length>1?'files':artifacts[0]?.mime?.startsWith('image/')?'image':artifacts[0]?.mime==='application/pdf'?'document':'file';
 if(status==='opened')return `I opened the ${noun} in ${kind==='native'?'Obsidian':'the dashboard'}.`;
 if(status==='failed')return `I saved the ${noun}, but couldn't open ${artifacts.length>1?'them':'it'} here. ${artifacts.length>1?'Their locations are':'Its location is'} in the saved result.`;
 return `Your ${noun} ${artifacts.length>1?'are':'is'} ready.`;
}
