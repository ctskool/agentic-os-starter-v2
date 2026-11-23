import {isDeepStrictEqual} from 'node:util';
import {readConversationEpoch,reconcileCurrent,resolveVoiceTarget,renewConversation} from './current-conversations.mjs';
import {replaceDaily,resolveDailyEdit} from './note-edits.mjs';
import {destinationFor} from './workflows.mjs';

const taskAt=(terminals,id)=>{try{return terminals?.get(id)||null}catch{return null}};
function taskRevision(terminals,id){
 const task=taskAt(terminals,id);
 if(!task)return null;
 const {provider,model,title,created,state,sessionId,execution,appScope,background,workflow,turns}=task;
 return {provider,model,title,created,state,sessionId,execution,appScope,background,workflowId:workflow?.job?.id,turnId:turns?.at(-1)?.id};
}
const snapshot=value=>JSON.parse(JSON.stringify(value));
const providerName=provider=>provider==='claude'?'Claude':'Codex';
const hasWorkflowDestination=site=>site==='startWorkflow'||site==='continueWorkflow'||site==='enqueue';

export function planVoiceEffects(root,terminals,context,{watchSelected=true}={}){
 const effects=[],targets=new Map();
 const watch=id=>{if(id&&!targets.has(id))targets.set(id,taskRevision(terminals,id))};
 if(watchSelected)watch(context.resolvedTarget);
 return {
  add(site,details,description,afterReceipt=false){
   watch(details.taskId);
   if(hasWorkflowDestination(site))details={...details,destination:destinationFor(details.job)};
   effects.push({site,details,afterReceipt,description});
  },
  finish(receipt){
   // Reading never refreshes conversation activity during planning. Any
   // renewal that accompanies a proposed effect is kept in its original order.
   const meaningful=effects.filter(effect=>effect.description);
   if(!meaningful.length)return null;
   const description=meaningful.map(effect=>effect.description).join(' and then ');
   return {kind:'action',action:snapshot({version:1,context,targets:[...targets],effects,receipt}),description};
  }
 };
}

export function checkVoiceAction(root,terminals,plan,{request,profile,handoffTarget}){
 if(plan?.version!==1||!plan.effects?.length||plan.receipt?.id!==request.id)throw new Error('A planned voice action is required for this request.');
 const changed=()=>new Error('The voice target, selection, or conversation changed. Say the request again.');
 const {context,effects,targets}=plan,{appScope:scope,selection:{provider}}=request;
 const current=reconcileCurrent(root,terminals,{scope,persist:false});
 const resolvedTarget=request.workTarget?resolveVoiceTarget(root,terminals,{scope,provider,id:request.workTarget}):null;
 if(!isDeepStrictEqual(context.request,request)||!isDeepStrictEqual(context.profile,profile)||
    !isDeepStrictEqual(context.handoffTarget,handoffTarget)||!isDeepStrictEqual(context.current,current)||
    context.resolvedTarget!==resolvedTarget||context.epoch!==readConversationEpoch(root,provider,scope))throw changed();
 for(const [id,revision]of targets)if(!isDeepStrictEqual(revision,snapshot(taskRevision(terminals,id))))throw changed();
 return effects.map(effect=>{
  const {site,details}=effect;
  if(hasWorkflowDestination(site)&&details.destination!==destinationFor(details.job))throw changed();
  if(site==='start'||site==='startWorkflow'){
   if(taskAt(terminals,details.job.id)||terminals?.workflowRequest?.(details.job.id))throw changed();
  }
  if(site==='reopenArtifact'){
   const artifacts=taskAt(terminals,details.taskId)?.turns?.flatMap(turn=>turn.artifacts||[])||[];
   if(!artifacts.some(artifact=>isDeepStrictEqual(snapshot(artifact),details.artifact)))throw changed();
  }
  if(site==='editDaily')return {...effect,note:resolveDailyEdit(root,details)};
  return effect;
 });
}

// The same calls apply to single-phase routing and to a resolved commit.
// Guards are synchronous so there is no await between approval and mutation.
export function voiceEffectRunner(root,terminals,{guard,enqueue,resolveCli,updateCurrent,onDispatch,reopenArtifact}){
 let guardRejected=false;
 const check=(site,details)=>{try{guard?.(site,details)}catch(error){guardRejected=true;throw error}};
 return {
  get guardRejected(){return guardRejected},
  check,
  apply(site,details,note){
   const {taskId,job,options}=details;
   switch(site){
    case 'renewConversation':return renewConversation(root,details,()=>check(site,details));
    case 'enqueue':return enqueue(root,job.skill,job.selection,job.id,job.args,{resolveCli,beforeWrite:()=>check(site,details)});
    case 'editDaily':return replaceDaily(root,note,()=>check(site,details));
    case 'stop':check(site,details);return terminals.stop(taskId);
    case 'send':check(site,details);return terminals.send(taskId,details.prompt,options);
    case 'continueWorkflow':check(site,details);return terminals.continueWorkflow(taskId,job,options);
    case 'startWorkflow':check(site,details);return terminals.startWorkflow(job);
    case 'start':check(site,details);return terminals.start(job);
    case 'reopenArtifact':check(site,details);return reopenArtifact({id:details.id,taskId,artifact:details.artifact},check);
    case 'onDispatch':check(site,details);return onDispatch(taskId,details.epoch);
    case 'updateCurrent':check(site,details);return updateCurrent(details);
    default:throw new Error('Unknown planned voice effect.');
   }
  }
 };
}

export function describeWork(site,{job,taskTitle}){
 if(site==='send')return `Continue “${taskTitle}”`;
 if(site==='continueWorkflow')return `Run the ${job.skill} workflow in “${taskTitle}”`;
 if(site==='startWorkflow')return `Start the ${job.skill} workflow in your ${providerName(job.selection.provider)} terminal`;
 if(site==='enqueue')return job.skill==='voice-ask'?'Queue the requested work':`Queue the ${job.skill} workflow`;
 return `Start “${job.title}” in your ${providerName(job.selection.provider)} terminal`;
}
