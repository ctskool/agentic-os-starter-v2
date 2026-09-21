// Native CLI processes belong to Obsidian's Terminal plugin. This coordinator
// exchanges launch/input/status commands only; it never owns or relays a screen.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {TerminalManager,terminalSpec,cleanPrompt,workId} from './terminals.mjs';
import {projectRoot} from './runtime.mjs';
import {findCli} from './adapters.mjs';
import {TerminalInputBoundary,TerminalPromptDetector} from './terminal-transport.mjs';
import {WORKER_SPOKEN_STYLE,artifactHandoffInstructions} from './spoken-answer.mjs';

const normalize=text=>String(text||'').replace(/\r\n?/g,'\n').trim();
const hash=text=>crypto.createHash('sha256').update(normalize(text)).digest('hex');
const native=r=>r.execution==='native';
export const NATIVE_LAUNCH_TIMEOUT_MS=30000;
export const NATIVE_PRESENCE_TIMEOUT_MS=90000;
const UNSTARTED='The native terminal did not start. Its unused launch was cancelled. Recover the request to review it before starting again.';
const UNCONFIRMED='The native terminal has not reconnected. It may still be running. Open its Obsidian Terminal tab to check it; this request was not launched again.';
export class NativeTerminalManager extends TerminalManager {
 constructor(root,options={}){
  super(root,options);this.resolveNativeCli=options.resolveNativeCli||findCli;
  for(const r of this.records.values())if(native(r)&&r.native){
   if(!r.native.ended){this.live.set(r.id,this.nativeLive(r,true));if(r.recoveryAvailable){r.recoveryAvailable=false;this.save(r)}}
   else if(r.native.launchCancelled&&!r.recoveryAvailable){r.recoveryAvailable=true;this.save(r)}
  }
 }
 nativeLive(r,restored=false){return {native:true,instance:r.native.instance,exitObserved:false,inputBoundary:new TerminalInputBoundary(),detector:new TerminalPromptDetector(r.provider),pendingDelivery:null,resumedAt:r.native.startedAt||null,reconnectUntil:restored?this.now()+NATIVE_PRESENCE_TIMEOUT_MS:0};}
 revokeUnusedLaunch(r){
  if(!workId(r.native.instance)||r.pid||r.native.presenceConfirmed||r.native.lastSeen||r.native.launchedAt||(r.native.actions||[]).some(a=>a.type==='launch'&&a.state==='done'))return false;
  const file=path.join(this.folder(r.id),`native-${r.native.instance}.json`);
  if(r.native.ticket!==file)return false;
  let descriptor;
  try{
   this.retention.assertFile(file);if(fs.statSync(file).size>512*1024)return false;
   const ticket=JSON.parse(fs.readFileSync(file,'utf8'));if(ticket.taskId!==r.id||ticket.instance!==r.native.instance)return false;
   // The launcher takes this same exclusive claim before spawning. Winning it
   // proves no CLI consumed the ticket and also revokes a delayed launch reply.
   descriptor=fs.openSync(file+'.claimed','wx');
   fs.writeFileSync(descriptor,JSON.stringify({taskId:r.id,instance:r.native.instance,cancelled:true,ts:this.now()}));fs.fsyncSync(descriptor);
   return true;
  }catch(error){
   if(error.code!=='EEXIST')return false;
   // A prior cancellation may have survived an interrupted session.json save.
   try{this.retention.assertFile(file+'.claimed');if(fs.statSync(file+'.claimed').size>4096)return false;const claim=JSON.parse(fs.readFileSync(file+'.claimed','utf8'));return claim.cancelled===true&&claim.taskId===r.id&&claim.instance===r.native.instance}catch{return false}
  }finally{if(descriptor!==undefined)fs.closeSync(descriptor)}
 }
 nativeContact(r){
  const first=!r.native.presenceConfirmed,warning=r.native.connectionWarning;
  r.native.presenceConfirmed=true;r.native.lastSeen=this.now();delete r.native.closedAt;
  if(warning){if(r.state==='needs input'&&r.error===UNCONFIRMED){r.state=warning.state;r.error=null;delete r.inputReason}delete r.native.connectionWarning;}
  return first||!!warning;
 }
 reconcileNative(){
  for(const [id,live] of this.live){
   const r=this.records.get(id);if(!r||!native(r)||r.native?.ended||r.native.connectionWarning)continue;
   const confirmed=r.pid||r.native.presenceConfirmed||r.native.launchedAt||(r.native.actions||[]).some(a=>a.type==='launch'&&a.state==='done');
   if(!['starting','working','ready','stopping'].includes(r.state)&&!(r.state==='needs input'&&!confirmed))continue;
   const deadline=Math.max(live.reconnectUntil||0,Math.max(r.native.startedAt||0,r.native.lastSeen||0,r.native.stopRequestedAt||0)+(confirmed?NATIVE_PRESENCE_TIMEOUT_MS:NATIVE_LAUNCH_TIMEOUT_MS));
   if(this.now()<deadline)continue;
   const cancelled=this.revokeUnusedLaunch(r),previousState=r.state;this.clearDelivery(live);
   if(cancelled){for(const action of r.native.actions||[])if(['pending','claimed'].includes(action.state))action.state='error';r.native.ended=true;r.native.launchCancelled=true;this.live.delete(id);r.recoveryAvailable=true;}
   else {r.native.connectionWarning={state:previousState};r.recoveryAvailable=false;}
   r.state='needs input';r.error=cancelled?UNSTARTED:UNCONFIRMED;r.inputReason=r.error;this.touch(r);this.save(r);
  }
 }
 collect(id){if(this.closed)return;super.collect(id);this.reconcileNative()}
 expected(r,text){
  for(const file of [path.join(this.folder(r.id),'events','active-request.meta'),path.join(this.artifactOutbox(r.id),'active-request.meta')]){
   const meta=JSON.parse(fs.readFileSync(file,'utf8')),temporary=file+'.'+crypto.randomUUID()+'.tmp';
   fs.writeFileSync(temporary,JSON.stringify({...meta,expectedPromptHash:hash(text),accepted:false}),{flag:'wx'});fs.renameSync(temporary,file);
  }
 }
 command(r,type,extra={}){
  const action={id:crypto.randomUUID(),taskId:r.id,instance:r.native.instance,provider:r.provider,title:r.title,type,state:'pending',createdAt:this.now(),...extra};
  r.native.actions=(r.native.actions||[]).filter(a=>['pending','claimed'].includes(a.state)).concat(action).slice(-8);this.save(r);return action;
 }
 launch(r,options={}){
  if(!native(r))return super.launch(r,options);
  if(this.live.has(r.id))return r;
  const {resumePrompt,spoken=!!r.spoken}=options;
  if(resumePrompt!==undefined)cleanPrompt(resumePrompt);
  if(r.workflow&&!r.workflowCompleted&&[...this.records.values()].some(other=>other.id!==r.id&&other.workflow?.destination===r.workflow.destination&&!other.workflowCompleted&&this.live.has(other.id)))throw Error('Another task is updating this note. Wait for it to finish.');
  r.skipWorkflowCompletion=!!r.sessionId&&resumePrompt===undefined;this.beginRequest(r);
  const cli=this.resolveNativeCli?.(r.provider)||findCli(r.provider);
  const spec=terminalSpec(this.root,r,cli,{resumePrompt,spoken,events:this.artifactOutbox(r.id)});
  const instance=crypto.randomUUID(),events=path.join(this.folder(r.id),'events');
  const ticket=path.join(this.folder(r.id),`native-${instance}.json`);
  const env={TERM:'xterm-256color',COLORTERM:'truecolor',AOS_WORK_SESSION:r.sessionId||'',AOS_WORK_PROMPT:spec.args.at(-1),AOS_ARTIFACT_NODE:process.execPath,AOS_ARTIFACT_HELPER:path.join(projectRoot,'runner','artifact-result.mjs'),AOS_ARTIFACT_OUTBOX:this.artifactOutbox(r.id)};
  for(const name of ['CODEX_HOME','CLAUDE_CONFIG_DIR'])if(process.env[name])env[name]=process.env[name];
  this.expected(r,spec.args.at(-1));
  fs.writeFileSync(ticket,JSON.stringify({version:1,taskId:r.id,instance,cwd:this.root,command:spec.command,args:spec.args,env,events}),{flag:'wx',mode:0o600});
  r.native={instance,startedAt:this.now(),lastSeen:0,ended:false,actions:[],ticket,cli:{command:cli.command,source:cli.source}};
  r.state='starting';r.pid=null;r.error=null;r.recoveryAvailable=false;delete r.inputReason;this.touch(r,{conversation:true});this.live.set(r.id,this.nativeLive(r));
  this.command(r,'launch',{launch:{executable:process.execPath,args:[path.join(projectRoot,'runner','native-launch.mjs'),'--ticket',ticket],cwd:this.root,environment:[['AOS_V2_TASK_ID',r.id],['AOS_V2_TASK_PROVIDER',r.provider],['AOS_V2_NATIVE_INSTANCE',instance],['AOS_V2_NATIVE_DIRECT','1']]}});
  return r;
 }
 send(id,text,{resumeStopped=false,spoken=false,openWhenDone=false}={}){
  const r=this.get(id);if(!native(r))return super.send(id,text,{resumeStopped,spoken,openWhenDone});
  text=cleanPrompt(text);this.collect(id);this.assertFollowup(id,{resumeStopped});
  if(openWhenDone&&!r.openWhenDone){r.openWhenDone=true;this.save(r)}
  if(!this.live.has(id))return this.launch(r,{resumePrompt:text,spoken});
  const live=this.live.get(id);this.beginRequest(r);r.state='working';r.error=null;this.touch(r,{conversation:true});
  const handoff=artifactHandoffInstructions({node:process.execPath,helper:path.join(projectRoot,'runner','artifact-result.mjs'),events:this.artifactOutbox(id),taskId:id,requestKey:r.artifactRequestKey,provider:r.provider});
  const submitted=`${text}${spoken?`\n\n${WORKER_SPOKEN_STYLE}`:''}\n\n${handoff}`;
  this.expected(r,submitted);
  const watcher=r.provider==='codex'?this.deliveryWatch(r.sessionId,submitted):undefined;
  live.pendingDelivery={key:r.artifactRequestKey,text:submitted,sessionId:r.sessionId,sentAt:this.now(),watcher,timer:null,warned:false};
  this.command(r,'send',{text:submitted,requestKey:r.artifactRequestKey});return r;
 }
 input(id,...args){if(native(this.get(id)))throw Error('Type directly in the Obsidian Terminal tab.');return super.input(id,...args)}
 output(id,...args){if(native(this.get(id)))throw Error('This terminal is displayed directly inside Obsidian.');return super.output(id,...args)}
 resize(id,...args){if(native(this.get(id)))throw Error('Obsidian owns this terminal size.');return super.resize(id,...args)}
 pendingNative(){
  const actions=[];for(const r of this.records.values())if(native(r)&&!r.native?.ended)for(const a of r.native?.actions||[])if(a.state==='pending')actions.push({id:a.id,taskId:r.id,instance:a.instance,type:a.type});
  return {actions};
 }
 claimNative(id){
  if(!workId(id))throw Error('Invalid native command');
  for(const r of this.records.values())if(native(r)){
   const action=r.native?.actions?.find(a=>a.id===id);if(!action)continue;
   if(action.state!=='pending'||r.native.ended||action.instance!==r.native.instance)throw Error('This native command was already claimed or replaced. Check the terminal; it was not resent.');
   action.state='claimed';action.claimedAt=this.now();this.save(r);
   return {action:structuredClone(action)};
  }
  throw Error('Native command not found');
 }
 nativeRecord(id,instance){const r=this.get(id);if(!native(r)||!r.native||r.native.instance!==instance)throw Error('Native terminal instance changed');return r}
 submitNative({taskId,instance,actionId,requestKey}){
  const r=this.nativeRecord(taskId,instance);this.collect(taskId);
  const action=r.native.actions.find(a=>a.id===actionId),live=this.live.get(taskId);
  const submit=!!live&&!live.exitObserved&&r.state==='working'&&action?.type==='send'&&action.state==='claimed'&&r.artifactRequestKey===requestKey&&live.pendingDelivery?.key===requestKey&&!live.pendingDelivery.submitCanceled;
  return {submit,...(!submit?{reason:r.error||'This request is no longer waiting to be submitted.'}:{})};
 }
 nativeEvent(event){
  const {taskId,instance,type,actionId}=event;
  if(!workId(taskId)||!workId(instance)||!['launched','input-written','input-cancelled','editing','submitted','approval','closed','error'].includes(type))throw Error('Invalid native event');
  const existing=this.records.get(taskId);if(!existing||!native(existing)||existing.native?.instance!==instance)return {ok:true,ignored:true};
  const r=existing,live=this.live.get(taskId);
  if(r.native.ended)return {ok:true};
  const action=actionId?r.native.actions.find(a=>a.id===actionId):null;
  if(actionId&&(!action||action.instance!==instance))throw Error('Native command does not match this terminal');
  if(action&&['done','error'].includes(action.state))return {ok:true};
  const reason=String(event.reason||'').slice(0,500);
  if(!['closed','error'].includes(type))this.nativeContact(r);
  if(['editing','submitted','approval','closed'].includes(type))for(const a of r.native.actions||[])if(a.type==='send'&&['pending','claimed'].includes(a.state))a.state='error';
  if(type==='launched'){if(action?.type!=='launch')throw Error('Invalid launch acknowledgment');action.state='done';r.native.launchedAt=this.now();if(r.state==='starting')r.state='working';}
  else if(type==='input-written'){if(action?.type!=='send')throw Error('Invalid input acknowledgment');action.state='done';}
  else if(type==='input-cancelled'){if(action)action.state='error';this.clearDelivery(live);r.state='needs input';r.error=reason||'The request is in the terminal. Review its input box before submitting.';}
  else if(type==='editing'){this.clearDelivery(live);if(live)live.inputBoundary.hasDraft=event.hasDraft!==false;r.state='editing';r.error=null;}
  else if(type==='submitted'){this.clearDelivery(live);live?.inputBoundary.reset();r.state='working';r.error=null;}
  else if(type==='approval'){this.cancelSubmit(live);r.state='needs input';r.error=reason||'Review the requested permission in the terminal.';}
  else if(type==='closed'){
   // The launcher reports actual CLI exit separately. A missing view alone must
   // not authorize launching another copy of a potentially running conversation.
   this.clearDelivery(live);r.native.lastSeen=0;r.native.closedAt=this.now();
   const mightHaveLaunched=r.pid||r.native.actions.some(a=>a.type==='launch'&&['claimed','done'].includes(a.state));
   r.state=mightHaveLaunched?'stopping':'stopped';r.error=null;
   if(!mightHaveLaunched){r.native.ended=true;this.live.delete(taskId)}
  }
  else if(type==='error'){if(action)action.state='error';this.clearDelivery(live);r.state='needs input';r.error=reason||'The native terminal could not confirm this action. Check its tab before retrying.';}
  else throw Error('Unknown native event');
  this.touch(r,{conversation:['launched','input-written','editing','submitted'].includes(type)});this.save(r);return {ok:true};
 }
 nativePresence(sessions){
  if(!Array.isArray(sessions)||sessions.length>100)throw Error('Invalid native sessions');
  for(const item of sessions){
   const r=this.records.get(item.taskId);if(!r||!native(r)||r.native?.instance!==item.instance||r.native.ended)continue;
   const changed=this.nativeContact(r);
   if(!this.live.has(r.id))this.live.set(r.id,this.nativeLive(r));
   if(typeof item.hasDraft==='boolean')this.live.get(r.id).inputBoundary.hasDraft=item.hasDraft;
   if(changed)this.save(r);
  }
  return {ok:true,ready:sessions.filter(item=>{const r=this.records.get(item.taskId);return r?.native?.instance===item.instance&&r.state==='ready'}).map(item=>({taskId:item.taskId,instance:item.instance}))};
 }
 stop(id,options){
  const r=this.get(id);if(!native(r))return super.stop(id,options);
  const live=this.live.get(id);this.clearDelivery(live);
  if(!live||r.native?.ended)return r;
  for(const action of r.native.actions||[])if(action.state==='pending')action.state='error';
  if(this.revokeUnusedLaunch(r)){r.native.ended=true;r.native.launchCancelled=true;r.state='stopped';r.recoveryAvailable=true;this.live.delete(id);this.touch(r);this.save(r);return r}
  if((r.native.actions||[]).some(a=>a.type==='stop'&&['pending','claimed'].includes(a.state)))return r;
  if(r.state!=='stopping'){r.state='stopping';r.error=null;delete r.inputReason;delete r.native.connectionWarning;r.native.stopRequestedAt=this.now();this.command(r,'stop')}
  return r;
 }
 accept(id,event,options={}){
  const r=this.records.get(id);if(!r||!native(r))return super.accept(id,event,options);
  if(event.nativeInstance&&event.nativeInstance!==r.native?.instance)return;
  // Native prompt hooks also rotate the artifact request identity below. Check
  // their immutable provider session before touching any native state.
  if(r.sessionId&&event.sessionId&&event.sessionId!==r.sessionId)return;
  if(event.type==='native-start'){
   if(event.nativeInstance!==r.native?.instance||r.native.ended||!Number.isSafeInteger(event.pid)||event.pid<=0)return;
   r.pid=event.pid;this.nativeContact(r);if(r.state==='starting')r.state='working';this.save(r);return;
  }
  if(event.type==='native-exit'){
   if(event.nativeInstance!==r.native?.instance)return;
   const stopping=r.state==='stopping'||r.native.connectionWarning?.state==='stopping',failed=!stopping&&(event.exitCode??event.code)!==0;this.clearDelivery(this.live.get(id));this.live.delete(id);r.native.ended=true;delete r.native.connectionWarning;delete r.inputReason;r.pid=null;r.state=failed?'error':'stopped';r.error=failed?'The CLI exited. Resume its saved conversation in Obsidian.':null;r.recoveryAvailable=!r.sessionId;this.touch(r);this.save(r);return;
  }
  if(event.type==='UserPromptSubmit'&&workId(event.requestKey)&&!this.live.get(id)?.pendingDelivery){r.artifactRequestKey=event.requestKey;r.pendingArtifacts=[];}
  return super.accept(id,event,options);
 }
 close(){
  this.closed=true;this.cancelSchedule(this.timer);this.cancelSchedule(this.retentionTimer);if(this.idleTimer)this.cancelSchedule(this.idleTimer);
  for(const [id,live] of this.live)if(native(this.get(id)))this.clearDelivery(live);else super.stop(id);
 }
}
