import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {projectRoot} from './runtime.mjs';
import {findCli,executeCli} from './adapters.mjs';
import {startHeadlessWorkflow} from './headless-workflows.mjs';
import {validateSelection,validateIntent,SKILLS} from '../shared/contract.mjs';
import {atomicRename,writeJson,vaultPath} from './core.mjs';
import {prepareWorkflow,saveWorkflowResult} from './terminal-workflows.mjs';
import {destinationFor,directWorkflow} from './workflows.mjs';
import {windowsArguments,TerminalPromptDetector,TerminalInputBoundary,stopOwnedPtyTree,releaseStoppedWindowsPty} from './terminal-transport.mjs';
import {TaskRetention,migrateTaskRetention,TASK_SWEEP_MS} from './task-retention.mjs';
// Idle close: default 30 minutes; AOS_V2_TERMINAL_IDLE_MINUTES overrides, 0 or "off" disables it.
export const IDLE_STOP_MS=30*60*1000,IDLE_SWEEP_MS=60*1000;
// A one-click close is refused while the CLI's screen changed this recently: a working CLI keeps redrawing, also
// when a turn was queued behind another one and the state already says ready.
export const QUIET_BEFORE_CLOSE_MS=4000;
export function terminalIdleStopMs(env=process.env){
 const raw=String(env.AOS_V2_TERMINAL_IDLE_MINUTES??'').trim().toLowerCase();if(!raw)return IDLE_STOP_MS;
 if(raw==='off')return 0;const minutes=Number(raw);return Number.isFinite(minutes)&&minutes>=0?Math.round(minutes*60*1000):IDLE_STOP_MS;
}
import {WORKER_SPOKEN_STYLE,artifactHandoffInstructions} from './spoken-answer.mjs';
import {captureTurnArtifacts,promiseOpen} from './artifacts.mjs';
import {createCodexDeliveryWatch} from './terminal-delivery.mjs';
const require=createRequire(import.meta.url);
export const TERMINAL_PASTE_SETTLE_MS=750;
export const TERMINAL_DELIVERY_TIMEOUT_MS=10000;
const DELIVERY_WARNING="The terminal hasn't confirmed this request. Check its input box; if the request is still there, press Enter once.";
const normalizedPrompt=text=>String(text||'').replace(/\r\n?/g,'\n').trim();
// xterm answers cursor/device/color queries without any human keypress. These
// complete reports must not cancel the only pending submission or create a draft.
const terminalReport=data=>/^(?:\x1b\[(?:\??\d+;\d+R|[?>]?\d+(?:;\d+)*c)|\x1b\](?:10|11|12);rgb:[\da-f]{1,4}\/[\da-f]{1,4}\/[\da-f]{1,4}(?:\x07|\x1b\\))+$/i.test(data);
function assertAttachmentInstance(live,instance){
 if(instance!==undefined&&(typeof instance!=='string'||!instance||!live||live.exitObserved||live.instance!==instance))throw new Error('Terminal session changed. Reconnect before sending more input.');
}
export const workId=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
export function cleanPrompt(text){
 if(typeof text!=='string'||!text.trim()||text.length>12000)throw new Error('Enter a request of 1–12000 characters.');
 // Text is pasted into the CLI composer, never interpreted as terminal control codes.
 if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))throw new Error('Control characters are not allowed in a request.');
 return text.trim();
}
export function terminalSpec(root,record,cli=findCli(record.provider),{resumePrompt,spoken=!!record.spoken,events}={}){
 if(!cli)throw new Error(`${record.provider} CLI is not installed.`);
 const hook=path.join(projectRoot,'runner/terminal-hook.mjs');
 let args;
 if(record.provider==='codex'){
  // Native Codex reviews permission requests itself while keeping its workspace
  // sandbox. This invocation-level preset also overrides unrestricted user defaults.
  const permissions=record.execution==='native'?['--approve-for-me']:['-s','workspace-write','-a','on-request'];
  args=[...(record.sessionId?['resume',record.sessionId]:[]),'-C',root,'-m',record.model,...permissions,'--no-alt-screen',
   '-c','model_reasoning_effort="medium"','-c',`notify=${JSON.stringify([process.execPath,hook])}`,
   '-c','tui.notifications=false','-c','project_root_markers=[".agentic-os-v2.json",".agentic-os-v2-test-vault",".git"]'];
 }else{
  const command=`"${process.execPath.replaceAll('\\','/')}" "${hook.replaceAll('\\','/')}"`;
  const hooks=Object.fromEntries(['SessionStart','UserPromptSubmit','Stop','StopFailure','PermissionRequest'].map(event=>[event,[{hooks:[{type:'command',command,timeout:5}]}]]));
  args=['--model',record.model,'--settings',JSON.stringify({hooks}),...(record.sessionId?['--resume',record.sessionId]:['--session-id',record.id])];
 }
 // New sessions receive their initial prompt as a process argument, not shell code.
 const request=record.sessionId?(resumePrompt===undefined?'Resume this conversation without using tools or taking actions. Briefly confirm you are ready for a follow-up.':cleanPrompt(resumePrompt)):record.prompt;
 const explicit=!record.sessionId||resumePrompt!==undefined;
 const handoff=artifactHandoffInstructions({node:process.execPath,helper:path.join(projectRoot,'runner','artifact-result.mjs'),events,taskId:record.id,requestKey:record.artifactRequestKey,provider:record.provider});
 args.push('--',explicit?`${request}${spoken?`\n\n${WORKER_SPOKEN_STYLE}`:''}\n\n${handoff}`:request);
 return {command:cli.command,args:[...cli.prefix,...args]};
}
export class TerminalManager {
 constructor(root,{directory=path.join(projectRoot,'.runtime','terminals'),spawn,direct=directWorkflow,execute=executeCli,stopTree=process.platform==='win32'&&!spawn,now=Date.now,schedule=setInterval,cancelSchedule=clearInterval,defer=setTimeout,cancelDeferred=clearTimeout,deliveryWatch=createCodexDeliveryWatch,idleStopMs=terminalIdleStopMs(),voiceBusy=()=>false}={}){
  this.root=root;this.directory=path.resolve(directory);this.spawn=spawn;this.direct=direct;this.stopTree=stopTree;this.records=new Map();this.live=new Map();this.now=now;this.cancelSchedule=cancelSchedule;this.closed=false;
  this.defer=defer;this.cancelDeferred=cancelDeferred;this.deliveryWatch=deliveryWatch;this.execute=execute;
  this.retention=new TaskRetention(this.directory,root);
  for(const name of fs.readdirSync(directory))if(workId(name)){
   try{if(this.retention.retired.has(name))continue;const {record:r,mtime}=this.retention.read(name);
    // Retention restarts its stopped clock after a crash; voice continuation
    // must keep the last actual interaction instead of inheriting that reset.
    if(!Number.isFinite(r.conversationActivityAt))r.conversationActivityAt=Math.max(0,...[r.lastActivityAt,r.created,...r.turns.map(t=>t.ts)].filter(Number.isFinite));
    if(r.execution==='native'&&r.native?.instance){r.keep=r.keep===true;r.lastActivityAt=Number.isFinite(r.lastActivityAt)?r.lastActivityAt:this.now()}
    else migrateTaskRetention(r,mtime,this.now());
    const expires=this.retention.expiresAt(r);
    if(r.execution==='script'&&!r.workflowCompleted&&(expires===null||expires>this.now()))saveWorkflowResult(root,r,'BLOCKED: Source refresh was interrupted before the bridge recorded completion. Review the saved source data and start a new refresh explicitly.');
    if(r.execution==='headless'&&!r.workflowCompleted&&(expires===null||expires>this.now())){saveWorkflowResult(root,r,'BLOCKED: Workflow was interrupted before completion. The report was not replaced. Start a new run to try again.');r.state='error'}
    r.recoveryAvailable=!r.sessionId&&!['script','headless'].includes(r.execution);this.records.set(r.id,r);this.save(r);
   }catch{}
  }
  this.prune();
  this.timer=schedule(()=>this.collect(),700);this.timer.unref?.();
  this.retentionTimer=schedule(()=>this.prune(),TASK_SWEEP_MS);this.retentionTimer.unref?.();
  // A finished terminal left at its prompt is closed after a while (the retention sweep above is hourly).
  this.idleStopMs=idleStopMs;this.voiceBusy=voiceBusy;this.idleTimer=idleStopMs>0?schedule(()=>this.sweepIdle(),IDLE_SWEEP_MS):null;this.idleTimer?.unref?.();
 }
 // Only a bridge-owned CLI sitting at an EMPTY prompt, whose conversation is saved and can be resumed. Native
 // (Obsidian) terminals are visible tabs that end when closed and report drafts differently, so they are never
 // swept; neither are source refreshes and background workflows. What the input box holds is never guessed from
 // keystrokes: a terminal the user has typed in at all is not closed here (userTyped), and a follow-up the bridge
 // pasted counts as unsent until there is positive proof it was submitted (unsentPaste). Nothing in flight is cut
 // off either: a managed delivery, or any voice request the bridge is handling right now.
 idleCandidate(id){
  const r=this.records.get(id),live=this.live.get(id);
  if(this.closed||!r||!live||live.native||r.execution&&r.execution!=='cli')return false;
  if(live.exitObserved||r.state!=='ready'||!r.sessionId)return false;
  if(live.userTyped||live.unsentPaste||live.pendingDelivery||live.draftRequestKey)return false;
  const boundary=live.inputBoundary;if(boundary&&(boundary.hasDraft||boundary.pasting||boundary.pending))return false;
  let busy=true;try{busy=this.voiceBusy()===true}catch{}if(busy)return false;
  // The CLI's own output is a second, independent sign of life: a turn the state machine lost track of still
  // redraws its screen, an idle prompt is silent.
  if(Number.isFinite(live.lastOutputAt)&&this.now()-live.lastOutputAt<this.idleStopMs)return false;
  return Number.isFinite(r.lastActivityAt)&&this.now()-r.lastActivityAt>=this.idleStopMs;
 }
 // × in a dashboard ends a terminal at once only if it is STILL idle when the request arrives: the dashboard's
 // "ready" is a poll old. Queued hooks are consumed first. Otherwise it is refused and the dashboard asks again.
 stopIfIdle(id){
  const r=this.get(id);if(!this.live.has(id))return this.stop(id);
  this.collect(id);const live=this.live.get(id);if(!live)return this.stop(id);
  const boundary=live.inputBoundary,drawing=Number.isFinite(live.lastOutputAt)&&this.now()-live.lastOutputAt<QUIET_BEFORE_CLOSE_MS;
  const busy=r.state!=='ready'||drawing||live.exitObserved||live.pendingDelivery||live.draftRequestKey||live.userTyped||live.unsentPaste||boundary&&(boundary.hasDraft||boundary.pasting||boundary.pending);
  if(busy){const error=new Error('This terminal is no longer idle. Check it, then press Stop? to end it anyway.');error.code='TERMINAL_NOT_IDLE';throw error}
  return this.stop(id);
 }
 sweepIdle(){
  const stopped=[];if(this.closed||!(this.idleStopMs>0))return stopped;
  for(const id of [...this.live.keys()]){
   // One terminal's failure never stops the sweep. Queued approval and submission hooks are consumed first, and
   // the terminal is looked at again afterwards: they can move it out of ready.
   try{
    if(!this.idleCandidate(id))continue;this.collect(id);if(!this.idleCandidate(id))continue;
    this.stop(id,{idle:true});stopped.push(id);
   }catch{const r=this.records.get(id);if(r&&r.state!=='stopped'&&r.state!=='stopping')delete r.idleStoppedAt}
  }
  return stopped;
 }
 folder(id){if(!workId(id))throw new Error('Invalid task ID');return path.join(this.directory,id)}
 artifactOutbox(id){if(!workId(id))throw new Error('Invalid task ID');return vaultPath(fs.realpathSync(this.root),`system/v2/artifact-requests/${id}`)}
 get(id){const r=this.records.get(id);if(!r)throw new Error('Task not found');return r}
 touch(r,{conversation=false}={}){r.lastActivityAt=this.now();if(conversation)r.conversationActivityAt=r.lastActivityAt;if(r.state==='stopped')r.stoppedAt=r.lastActivityAt}
 cancelSubmit(live){const pending=live?.pendingDelivery;if(pending?.timer){this.cancelDeferred(pending.timer);pending.timer=null}if(pending)pending.submitCanceled=true}
 clearDelivery(live,{preserveDraft=false}={}){this.cancelSubmit(live);try{live?.pendingDelivery?.watcher?.close?.()}catch{}if(live){live.pendingDelivery=null;if(!preserveDraft)live.draftRequestKey=null}}
 finishDelivery(r,live){
  if(live)live.draftRequestKey=null;
  const pending=live?.pendingDelivery;if(!pending)return;
  this.clearDelivery(live);
  live.inputBoundary?.reset();
  if(r.state==='needs input'&&r.error===DELIVERY_WARNING){r.state='working';r.error=null;this.save(r)}
 }
 checkDelivery(r,live){
  const pending=live?.pendingDelivery;if(!pending)return;
  if(pending.key!==r.artifactRequestKey||pending.sessionId!==r.sessionId){this.clearDelivery(live);return}
  let accepted=false;try{accepted=pending.watcher?.poll()===true}catch{}
  // Proof for Codex: the delivery watcher found this exact text in the session.
  if(accepted){live.unsentPaste=false;this.finishDelivery(r,live);return}
  if(this.now()-pending.sentAt>=TERMINAL_DELIVERY_TIMEOUT_MS&&!pending.warned&&r.state==='working'){
   this.cancelSubmit(live);pending.warned=true;r.state='needs input';r.error=DELIVERY_WARNING;this.save(r);
  }
 }
 beginRequest(r){
  const live=this.live.get(r.id);if(live)live.draftRequestKey=null;
  r.artifactRequestKey=crypto.randomUUID();r.pendingArtifacts=[];
  const file=path.join(this.folder(r.id),'events','active-request.meta');
  fs.writeFileSync(file+'.tmp',JSON.stringify({taskId:r.id,requestKey:r.artifactRequestKey,events:path.dirname(file),vault:this.root}));atomicRename(file+'.tmp',file);
  const outbox=this.artifactOutbox(r.id);fs.mkdirSync(outbox,{recursive:true});
  const metadata=path.join(outbox,'active-request.meta');
  fs.writeFileSync(metadata+'.tmp',JSON.stringify({taskId:r.id,requestKey:r.artifactRequestKey,outbox,vault:this.root}));atomicRename(metadata+'.tmp',metadata);
 }
 save(r){if(this.records.get(r.id)!==r||this.retention.retired.has(r.id))return;const file=path.join(this.folder(r.id),'session.json');fs.writeFileSync(file+'.tmp',JSON.stringify(r,null,2));atomicRename(file+'.tmp',file);this.onChange?.(r)}
 list(){return [...this.records.values()].sort((a,b)=>b.created-a.created).map(r=>({...r,expiresAt:this.retention.expiresAt(r,this.live.has(r.id)),prompt:undefined,vault:undefined,native:undefined,pendingArtifacts:undefined,artifactRequestKey:undefined,workflowHistory:undefined,completedTurnIds:undefined,workflow:r.workflow?{skill:r.workflow.job.skill,destination:r.workflow.destination}:undefined}))}
 setKeep(id,keep){if(typeof keep!=='boolean')throw new Error('Keep must be true or false');const r=this.get(id);if(r.keep!==keep){r.keep=keep;if(!keep)this.touch(r);this.save(r)}return {...r,expiresAt:this.retention.expiresAt(r,this.live.has(id))}}
 prune(){
  if(this.closed)return;
  for(const [id,r] of this.records){const expires=this.retention.expiresAt(r,this.live.has(id));if(expires===null||this.now()<expires)continue;
   try{this.retention.remove(id)}catch{}
   if(this.retention.retired.has(id)){try{fs.rmSync(this.artifactOutbox(id),{recursive:true,force:true})}catch{}this.records.delete(id);this.onRemove?.(r)}
  }
  // Retry a partially completed deletion, without loading retired conversations.
  for(const id of this.retention.retired){try{if(fs.existsSync(this.folder(id)))this.retention.remove(id);else if(fs.existsSync(path.join(this.directory,`.retired-${id}`)))this.retention.removeRetired(id)}catch{}}
 }
 originalRequest(id){const r=this.get(id);return {prompt:r.workflow?.prompt||r.prompt,title:r.workflow?SKILLS[r.workflow.job.skill].label:r.title,selection:{provider:r.provider,model:r.workflow?.job.model||r.model},...(r.workflow?{skill:r.workflow.job.skill,args:r.workflow.job.args}:{})}}
 workflowRequest(id){
  for(const record of this.records.values())for(const workflow of [record.workflow,...(record.workflowHistory||[])])if(workflow?.job.id===id)return {record,workflow};
  return null;
 }
 startWorkflow({id=crypto.randomUUID(),selection,skill,args={},execution,appScope=execution==='native'?'native':'web'}){
  if(!workId(id))throw new Error('Invalid task ID');
  if(![undefined,'native','headless'].includes(execution)||!['native','web'].includes(appScope))throw new Error('Invalid workflow owner');
  const previous=this.workflowRequest(id);
  const existing=previous?.record||this.records.get(id);
  if(existing?.execution==='headless'&&existing.model!==selection.model)throw new Error('Task ID already used with a different model.');
  if(existing&&(existing.execution==='headless'||execution==='headless')&&(existing.execution!=='script'&&existing.execution!==execution||(existing.appScope||(existing.execution==='native'?'native':'web'))!==appScope))throw new Error('Task ID belongs to a different workflow or app.');
  if(existing&&existing.execution!=='script'&&(existing.execution==='native')!==(execution==='native'))throw new Error('Task ID belongs to a different app.');
  if(previous){if(previous.workflow.job.skill!==skill||JSON.stringify(previous.workflow.job.args)!==JSON.stringify(args)||previous.record.provider!==selection.provider)throw new Error('Task ID already used');return previous.record}
  if(this.records.has(id)){const existing=this.get(id);if(existing.workflow?.job.skill!==skill||JSON.stringify(existing.workflow.job.args)!==JSON.stringify(args)||existing.provider!==selection.provider)throw new Error('Task ID already used');return existing}
  this.retention.assertNew(id);
  const job=validateIntent({version:2,id,...selection,skill,args,from:'plugin',ts:new Date().toISOString()});
  const destination=destinationFor(job);
  if(SKILLS[skill].direct&&[...this.records.values()].some(r=>r.execution==='script'&&r.workflow?.job.skill===skill&&this.live.has(r.id)))throw new Error('This source refresh is already running. Wait for its result; other tasks can still run.');
  if([...this.records.values()].some(r=>r.workflow?.destination===destination&&!r.workflowCompleted&&this.live.has(r.id)))throw new Error('Another task is updating that same note. Continue it or wait for its result; unrelated tasks can still run.');
  if(SKILLS[skill].direct)return this.startDirect(job,destination,appScope,{background:execution==='headless'});
  const workflow=prepareWorkflow(this.root,{id,selection,skill,args,execution});
  if(execution==='headless')return startHeadlessWorkflow(this,workflow,appScope);
  return this.start({id,selection,prompt:workflow.prompt,title:skill.replaceAll('-',' '),workflow,execution});
 }
 continueWorkflow(targetId,{id=crypto.randomUUID(),selection,skill,args={}},{resumeStopped=false}={}){
  if(!workId(id))throw new Error('Invalid task ID');
  const r=this.get(targetId),chosen=validateSelection(selection);
  if(r.provider!==chosen.provider)throw new Error('This conversation belongs to a different provider.');
  const job=validateIntent({version:2,id,provider:r.provider,model:r.model,skill,args,from:'plugin',ts:new Date().toISOString()});
  if(SKILLS[skill].direct)throw new Error('Source refreshes run as scripts; start a separate refresh instead of sending one to a terminal.');
  const previous=this.workflowRequest(id);
  if(previous){if(previous.record!==r||previous.workflow.job.skill!==skill||JSON.stringify(previous.workflow.job.args)!==JSON.stringify(args))throw new Error('Task ID already used');return r}
  if(this.records.has(id))throw new Error('Task ID already used');
  this.retention.assertNew(id);
  const ready=()=>{
   this.assertFollowup(targetId,{resumeStopped});
   if(r.workflow&&!r.workflowCompleted)throw new Error('This conversation has an unfinished workflow. Continue it before starting another workflow in this terminal.');
  };
  // Process already-arrived hooks before assigning a new output contract. A
  // queued approval or completion cannot be mistaken for the new workflow.
  ready();this.collect(targetId);ready();
  const destination=destinationFor(job);
  if([...this.records.values()].some(other=>other.workflow?.destination===destination&&!other.workflowCompleted&&this.live.has(other.id)))throw new Error('Another task is updating that same note. Continue it or wait for its result; unrelated tasks can still run.');
  const workflow=prepareWorkflow(this.root,{id,selection:{provider:r.provider,model:r.model},skill,args});
  cleanPrompt(workflow.prompt);
  workflow.startedAt=this.now();workflow.continued=true;
  if(r.workflow){const prior=r.workflow;r.workflowHistory=[...(r.workflowHistory||[]),{job:prior.job,destination:prior.destination,startedAt:prior.startedAt||r.created,completed:true,status:r.workflowStatus,resultPath:r.resultPath}]}
  r.workflow=workflow;r.workflowCompleted=false;r.skipWorkflowCompletion=false;
  delete r.resultPath;delete r.workflowStatus;r.error=null;
  return this.send(targetId,workflow.prompt,{resumeStopped});
 }
 startDirect(job,destination,appScope='web',{background=false}={}){
  this.retention.assertNew(job.id);
  const file=path.join(this.root,destination),before=fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;
  const r={id:job.id,vault:this.root,provider:job.provider,model:'none',prompt:SKILLS[job.skill].label,title:SKILLS[job.skill].label,created:this.now(),lastActivityAt:this.now(),keep:false,state:'working',sessionId:null,pid:null,turns:[],error:null,execution:'script',appScope,...(background?{background:true}:{}),workflow:{job,destination,before}};
  fs.mkdirSync(path.join(this.folder(r.id),'events'),{recursive:true});this.records.set(r.id,r);
  const controller=new AbortController();
  const live={controller,proc:{kill:()=>controller.abort(),resize(){}},output:'',start:0,instance:crypto.randomUUID(),sizes:[{at:0,cols:110,rows:30}]};
  writeJson(this.root,`system/v2/runs/${r.id}.json`,{...job,model:'none',ts_queued:job.ts,ts_started:new Date(r.created).toISOString(),ts_completed:null,status:'running',summary:'Fetching source data',execution:'script',appScope,task_id:r.id,deliverable_path:null});
  this.live.set(r.id,live);this.save(r);
  live.done=Promise.resolve().then(()=>{if(controller.signal.aborted)throw new Error('Task stopped');return this.direct(this.root,job,{signal:controller.signal})}).then(result=>{
   if(this.live.get(r.id)!==live)return;
   if(controller.signal.aborted)throw new Error('Source refresh was stopped. Any source data already fetched remains available.');
   const text=String(result.text||'');if(!text.trim())throw new Error('The source refresh returned no result.');
   saveWorkflowResult(this.root,r,text,{ownsDestination:!!result.ownsDestination});
   r.turns.push({id:'script-complete',ts:Date.now(),text:text.slice(0,100000)});r.state=r.workflowStatus==='ok'?'stopped':'error';
  }).catch(error=>{
   if(this.live.get(r.id)!==live)return;
   r.error=String(error.message||error);r.state=controller.signal.aborted?'stopped':'error';saveWorkflowResult(this.root,r,'BLOCKED: '+r.error);
  }).finally(()=>{if(this.live.get(r.id)===live){this.live.delete(r.id);this.touch(r);this.save(r)}});
  return r;
 }
 start({id=crypto.randomUUID(),selection,prompt,title,workflow,spoken=false,execution,openWhenDone=false}){
  if(execution!==undefined&&execution!=='native')throw new Error('Invalid terminal owner');
  if(!workId(id))throw new Error('Invalid task ID');
  const chosen=validateSelection(selection);prompt=cleanPrompt(prompt);
  if(!this.records.has(id)&&this.workflowRequest(id))throw new Error('Task ID already used');
  if(this.records.has(id)){const r=this.get(id);if(r.provider!==chosen.provider||r.prompt!==prompt||(r.execution==='native')!==(execution==='native'))throw new Error('Task ID already used');return r}
  this.retention.assertNew(id);
  if(!findCli(chosen.provider)&&!this.spawn)throw new Error(`${chosen.provider} CLI is not installed`);
  const r={id,vault:this.root,...chosen,prompt,title:String(title||prompt).replace(/\s+/g,' ').slice(0,70),created:this.now(),lastActivityAt:this.now(),keep:false,state:'starting',sessionId:null,pid:null,turns:[],error:null,workflow,...(execution?{execution}:{}),...(spoken?{spoken:true}:{}),...(openWhenDone?{openWhenDone:true}:{})};
  fs.mkdirSync(path.join(this.folder(id),'events'),{recursive:true});this.records.set(id,r);this.save(r);
  try{this.launch(r)}catch(e){r.state='error';r.error=e.message;r.recoveryAvailable=!r.sessionId;this.save(r);throw e}return r;
 }
 launch(r,{resumePrompt,spoken=!!r.spoken}={}){
  if(this.live.has(r.id))return r;
  delete r.idleStoppedAt;
  if(resumePrompt!==undefined)resumePrompt=cleanPrompt(resumePrompt);
  if(r.workflow&&!r.workflowCompleted&&[...this.records.values()].some(other=>other.id!==r.id&&other.workflow?.destination===r.workflow.destination&&!other.workflowCompleted&&this.live.has(other.id)))throw new Error('Another task is updating this note. Resume after it finishes.');
  r.skipWorkflowCompletion=!!r.sessionId&&resumePrompt===undefined;
  this.beginRequest(r);
  const events=this.artifactOutbox(r.id);
  const spec=terminalSpec(this.root,r,this.spawn?{command:r.provider,prefix:[]}:undefined,{resumePrompt,spoken,events});
  const spawn=this.spawn||require('node-pty').spawn;
  const env={...process.env,TERM:'xterm-256color',COLORTERM:'truecolor',AOS_WORK_EVENTS:path.join(this.folder(r.id),'events'),AOS_WORK_SESSION:r.sessionId||'',AOS_WORK_PROMPT:spec.args[spec.args.length-1],AOS_ARTIFACT_NODE:process.execPath,AOS_ARTIFACT_HELPER:path.join(projectRoot,'runner','artifact-result.mjs')};
  // A parent Claude session must not make the new, independent CLI look nested.
  delete env.CLAUDECODE;
  const proc=spawn(spec.command,process.platform==='win32'&&!this.spawn?windowsArguments(spec.args):spec.args,{cwd:this.root,env,cols:110,rows:30,name:'xterm-256color',useConpty:true});
  const live={proc,lastOutputAt:this.now(),userTyped:false,unsentPaste:false,detector:new TerminalPromptDetector(r.provider),inputBoundary:new TerminalInputBoundary(),exitObserved:false,output:'',start:0,instance:crypto.randomUUID(),sizes:[{at:0,cols:110,rows:30}],resumedAt:resumePrompt===undefined?null:this.now()};this.live.set(r.id,live);
  r.pid=proc.pid;r.state='working';r.error=null;r.recoveryAvailable=false;this.touch(r,{conversation:true});this.save(r);
  proc.onData(data=>{if(this.live.get(r.id)!==live)return;live.lastOutputAt=this.now();live.output+=data;if(live.output.length>500000){const trim=live.output.length-400000;live.output=live.output.slice(trim);live.start+=trim;const base=live.sizes.filter(s=>s.at<=live.start).at(-1);live.sizes=[{...base,at:live.start},...live.sizes.filter(s=>s.at>live.start)]}
   if(r.provider==='codex'&&r.state!=='stopping'){const reason=live.detector.update(data);if(reason&&!(r.state==='needs input'&&r.error===reason)){this.cancelSubmit(live);r.state='needs input';r.error=reason;this.save(r)}}
  });
  proc.onExit(async({exitCode})=>{live.exitObserved=true;this.clearDelivery(live);if(this.stopTree)await releaseStoppedWindowsPty(proc);if(this.live.get(r.id)!==live)return;const stopping=r.state==='stopping';this.collect();this.live.delete(r.id);r.pid=null;r.state=exitCode&&!stopping?'error':'stopped';r.recoveryAvailable=!r.sessionId;r.error=exitCode&&!stopping?`CLI exited (${exitCode}). ${r.sessionId?'Resume the saved conversation.':'Use Recover request to review the original request and start a new task.'}`:null;this.touch(r);this.save(r)});
  return r;
 }
 resume(id){const r=this.get(id);if(r.execution==='headless')throw new Error('Background workflows cannot be resumed. Start a new workflow to run it again.');if(this.live.has(id))return r;if(r.execution==='script')throw new Error('This source refresh has finished. Start a new refresh to run it again.');if(!r.sessionId)throw new Error('No saved CLI session yet. Your original request is preserved. Use Recover request to review it and start a new task explicitly.');return this.launch(r)}
 output(id,cursor=0,instance=''){
  const r=this.get(id),live=this.live.get(id);if(!live)return {data:'',cursor:0,instance:'',state:r.state};
  const reset=instance!==live.instance||cursor<live.start||cursor>live.start+live.output.length;
  const offset=reset?0:cursor-live.start;
  const from=live.start+offset,end=live.start+live.output.length;
  // Preserve geometry with the stream: replaying old ANSI cursor moves at the
  // newest viewer's width corrupts both the scrollback and the live composer.
  const base=live.sizes.filter(s=>s.at<=from).at(-1);
  const sizes=[{...base,at:from},...live.sizes.filter(s=>s.at>from)];
  const frames=sizes.map((s,i)=>({cols:s.cols,rows:s.rows,data:live.output.slice(s.at-live.start,(sizes[i+1]?.at??end)-live.start)}));
  return {data:live.output.slice(offset),frames,cursor:end,instance:live.instance,reset,state:r.state};
 }
 input(id,data,instance){
  const r=this.get(id),live=this.live.get(id);if(!live)throw new Error('Terminal is stopped. Resume it first.');
  if(r.execution==='headless')throw new Error('Background workflows do not have an interactive terminal.');
  assertAttachmentInstance(live,instance);
  if(typeof data!=='string'||data.length>16000)throw new Error('Invalid terminal input');
  if(r.execution==='script')throw new Error('Source refreshes do not have an interactive terminal.');
  if(r.state==='stopping')throw new Error('This terminal is stopping. Wait for it to close.');
  const report=terminalReport(data);
  // Receipt may already be on disk: distinguish editing the managed paste from
  // composing the next message after the provider has accepted that paste.
  if(data.length&&!report&&live.pendingDelivery){this.collect(id);if(this.live.get(id)!==live||live.exitObserved)throw new Error('Terminal session changed. Reconnect before sending more input.')}
  const pending=live.pendingDelivery;
  if(data.length&&!report){if(pending)live.draftRequestKey=pending.key;this.clearDelivery(live,{preserveDraft:true})}
  live.proc.write(data);
  if(report)return;
  if(data.length)this.touch(r,{conversation:true});
  const activity=live.inputBoundary.update(data);
  // What the input box holds cannot be known from keystrokes (Alt+Enter, yank, completions that insert text, ...).
  // So nothing is inferred: once the user has typed ANYTHING here, this terminal is never closed automatically
  // and a one-click close asks first, until the user confirms an empty input box or the terminal is relaunched.
  // (Focus-in/out reports come from the emulator when the view is clicked or left; they carry no text.)
  if(!/^(?:\x1b\[[IO])+$/.test(data))live.userTyped=true;
  if(activity.submitted&&['ready','editing','needs input','error'].includes(r.state)){
   // Editing a managed paste does not replace the helper command embedded in
   // it. Keep its request identity until submission; a fresh typed turn rotates.
   if(['ready','editing'].includes(r.state)&&live.draftRequestKey!==r.artifactRequestKey)this.beginRequest(r);
   r.state='working';r.error=null;live.detector.reset();this.save(r);
  }
  else if(pending&&data.length&&!activity.submitted&&live.inputBoundary.hasDraft){r.state='editing';r.error=null;this.save(r)}
  else if(r.state==='ready'&&activity.edited){r.state='editing';this.save(r)}
  if(activity.submitted)live.draftRequestKey=null;
 }
 markReady(id,{confirmedEmpty=false}={}){
  const r=this.get(id),live=this.live.get(id);
  if(!live||['script','headless'].includes(r.execution)||r.state==='stopping')throw new Error('Open a running terminal before returning to the message box.');
  if(confirmedEmpty!==true)throw new Error('Confirm that the CLI is idle and its input box is empty. Preserve any draft first.');
  // User verification changes only our routing state. Never send clearing keys,
  // an interrupt, an approval response, or a prompt on the user's behalf.
  this.clearDelivery(live);live.inputBoundary.reset();live.userTyped=false;live.unsentPaste=false;live.detector.reset();r.state='ready';r.error=null;this.touch(r,{conversation:true});this.save(r);return r;
 }
 assertFollowup(id,{resumeStopped=false}={}){
  const r=this.get(id),live=this.live.get(id);
  if(r.execution==='headless')throw new Error('Background workflows do not have an interactive terminal. Start a new workflow instead.');
  if(r.execution==='script')throw new Error('Source refreshes do not have an interactive terminal.');
  if(!live){
   if(!resumeStopped)throw new Error('Resume this terminal before sending a follow-up.');
   if(!['stopped','error','ready'].includes(r.state))throw new Error('This terminal is still closing. Wait for it to stop before sending a follow-up.');
   if(!r.sessionId)throw new Error('No saved CLI session yet. Your original request is preserved. Use Recover request to review it and start a new task explicitly.');
   return;
  }
  if(live.exitObserved)throw new Error('This terminal is still closing. Wait for it to stop before sending a follow-up.');
  if(r.state!=='ready'||live.inputBoundary?.hasDraft)throw new Error(r.state==='needs input'&&r.error?r.error:'This task is working or needs terminal input. Wait for its answer, or type directly in its terminal.');
 }
 send(id,text,{resumeStopped=false,spoken=false,openWhenDone=false}={}){const r=this.get(id);text=cleanPrompt(text);
  this.assertFollowup(id,{resumeStopped});this.collect(id);this.assertFollowup(id,{resumeStopped});
  // A promised open stays with the conversation until a turn produces a file.
  if(openWhenDone&&!r.openWhenDone){r.openWhenDone=true;this.save(r)}
  if(!this.live.has(id)){
   // A fresh user request authorizes this resume. Submit it as the CLI's
   // startup argument so it cannot be pasted into a trust/approval screen.
   try{return this.launch(r,{resumePrompt:text,spoken})}catch(error){r.state='error';r.error=error.message;r.recoveryAvailable=!r.sessionId;this.save(r);throw error}
  }
  const live=this.live.get(id);this.beginRequest(r);r.state='working';live.detector?.reset();live.inputBoundary?.reset();this.touch(r,{conversation:true});this.save(r);
  const handoff=artifactHandoffInstructions({node:process.execPath,helper:path.join(projectRoot,'runner','artifact-result.mjs'),events:this.artifactOutbox(r.id),taskId:r.id,requestKey:r.artifactRequestKey,provider:r.provider});
  const submitted=`${text}${spoken?`\n\n${WORKER_SPOKEN_STYLE}`:''}\n\n${handoff}`;
  let watcher;try{if(r.provider==='codex')watcher=this.deliveryWatch(r.sessionId,submitted)}catch{}
  const pending={key:r.artifactRequestKey,text:submitted,sessionId:r.sessionId,sentAt:this.now(),watcher,timer:null,warned:false,submitCanceled:false};
  live.pendingDelivery=pending;
  const paste=`\x1b[200~${submitted}\x1b[201~`;
  live.inputBoundary?.update(paste);live.proc.write(paste);live.unsentPaste=true;
  // One Enter after the CLI can consume the paste. Never retry: a second Enter
  // could duplicate work or accept an approval that appeared in the meantime.
  pending.timer=this.defer(()=>{
   pending.timer=null;
   if(this.live.get(id)!==live||live.exitObserved||live.pendingDelivery!==pending||pending.submitCanceled||r.state!=='working'||r.artifactRequestKey!==pending.key)return;
   this.collect(id);
   if(this.live.get(id)===live&&!live.exitObserved&&live.pendingDelivery===pending&&!pending.submitCanceled&&r.state==='working')live.proc.write('\r');
  },TERMINAL_PASTE_SETTLE_MS);pending.timer?.unref?.();return r;
 }
 resize(id,cols,rows,instance){if(!Number.isInteger(cols)||!Number.isInteger(rows)||cols<20||cols>300||rows<5||rows>120)throw new Error('Invalid terminal size');const live=this.live.get(id);assertAttachmentInstance(live,instance);if(!live)return;const last=live.sizes.at(-1);if(last.cols===cols&&last.rows===rows)return;const at=live.start+live.output.length;if(last.at===at)live.sizes.pop();live.sizes.push({at,cols,rows});live.proc.resize(cols,rows)}
 stop(id,{idle=false}={}){const r=this.get(id),live=this.live.get(id);
  this.clearDelivery(live);
  if(!live&&r.state==='stopped')return r;
  this.touch(r);
  // Only the idle sweep labels a close as idle; any other Stop (also a retry after a failed cleanup) removes it.
  if(idle)r.idleStoppedAt=this.now();else delete r.idleStoppedAt;
  // Keep the source lock and shutdown guard until the child has actually closed.
  if(live&&['script','headless'].includes(r.execution)){r.state='stopping';live.proc.kill();this.save(r);return r}
  if(live&&this.stopTree&&process.platform==='win32'){
   // Returning early is only right when cleanup has really started; a failed save must not leave a terminal
   // that says "stopping" with nothing stopping it (the shutdown guard would stay pinned).
   if(r.state==='stopping'&&live.stopped)return r;r.state='stopping';try{this.save(r)}catch{}
   live.stopped=stopOwnedPtyTree(live,{isCurrent:()=>this.live.get(id)===live&&!live.exitObserved}).then(async confirmed=>{
    if(this.live.get(id)!==live)return;
    if(confirmed){
     if(!await releaseStoppedWindowsPty(live.proc)){r.state='error';r.error='Process tree stopped, but this node-pty version could not release its terminal handles.';this.save(r)}
     return;
    }
    // Calling node-pty.kill after the root exited starts its console-list agent
    // against a vanished console (AttachConsole failure). Never double-kill.
    r.state='error';r.error='Could not confirm terminal process cleanup. Inspect the terminal or retry Stop.';delete r.idleStoppedAt;this.save(r);
   }).catch(()=>{if(this.live.get(id)!==live)return;delete r.idleStoppedAt;r.state='error';r.error='Could not confirm terminal process cleanup. Inspect the terminal or retry Stop.';try{this.save(r)}catch{}});return r;
  }
  if(live){this.live.delete(id);live.proc.kill()}r.pid=null;r.state='stopped';r.recoveryAvailable=!r.sessionId&&!['script','headless'].includes(r.execution);this.save(r);return r
 }
 collect(targetId){for(const id of targetId?[targetId]:this.live.keys()){if(this.records.get(id)?.execution==='headless')continue;const events=[],directories=[{dir:path.join(this.folder(id),'events'),artifactOnly:false}];try{directories.push({dir:this.artifactOutbox(id),artifactOnly:true})}catch{}
  for(const {dir,artifactOnly} of directories){let iterator;try{
   if(!fs.existsSync(dir)||fs.lstatSync(dir).isSymbolicLink())continue;
   iterator=fs.opendirSync(dir);
   // Inspect only current task inboxes; a stalled or malicious producer cannot
   // make one collection pass walk an unbounded directory or read large files.
   for(let count=0;count<128;count++){
    const entry=iterator.readSync();if(!entry)break;if(!entry.name.endsWith('.json')||!entry.isFile())continue;
    const absolute=path.join(dir,entry.name);let event;
    try{
     if(fs.statSync(absolute).size>200000)throw new Error('Oversized queue event');
     event=JSON.parse(fs.readFileSync(absolute,'utf8'));
     if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.type!=='string'||(artifactOnly&&event.type!=='artifact'))throw new Error('Invalid queue event');
     if(artifactOnly){
      if(!Number.isFinite(event.ts))throw new Error('Invalid artifact timestamp');
      // A vault-writable artifact may carry output data only. In particular it
      // cannot establish or replace the provider's resumable session identity.
      event={type:'artifact',taskId:event.taskId,requestKey:event.requestKey,path:event.path,label:event.label,open:event.open===true,ts:event.ts};
     }
    }catch{
     // These are atomic protocol files, never user documents. Retire invalid
     // entries so 128 bad events cannot permanently hide a later valid result.
     try{fs.unlinkSync(absolute)}catch{}continue;
    }
    events.push({file:absolute,event});
   }
  }catch{}finally{try{iterator?.closeSync()}catch{}}}
  // Helper and completion files use random names. Their creation timestamps,
  // not directory ordering, determine which output belongs to a completed turn.
  events.sort((a,b)=>(a.event.ts||0)-(b.event.ts||0)||(a.event.type==='artifact'?-1:1));
  for(const {file,event} of events)try{this.accept(id,event,{historical:!this.live.has(id)});fs.unlinkSync(file)}catch{}
  this.checkDelivery(this.records.get(id),this.live.get(id));
 }}
 accept(id,event,{historical=false}={}){const r=this.records.get(id);if(!r||this.retention.retired.has(id))return;
  if(r.execution==='headless')return;
  // Identity is immutable once captured: a competing notify cannot change the
  // resumable conversation, completion state, or managed workflow output.
  if(r.sessionId&&event.sessionId&&event.sessionId!==r.sessionId)return;
  const resumedAt=this.live.get(id)?.resumedAt;
  if(resumedAt&&Number.isFinite(event.ts)&&event.ts<resumedAt)return;
  const completion=['complete','Stop'].includes(event.type);
  // A CLI can replay notify files, including turns no longer in the 30-answer
  // display history. Never let an old turn complete a later managed workflow.
  if(completion&&typeof event.turnId==='string'&&((r.completedTurnIds||[]).includes(event.turnId)||r.turns.some(turn=>turn.id===event.turnId)))return;
  if(r.workflow?.continued&&!r.workflowCompleted&&Number.isFinite(event.ts)&&event.ts<r.workflow.startedAt)return;
  if(!r.sessionId&&typeof event.sessionId==='string'&&/^[a-f0-9-]{36}$/.test(event.sessionId))r.sessionId=event.sessionId;
  // Draining a closed process only retires its event identities. A delayed
  // completion cannot save canceled work, announce an old answer, or set the
  // state of the new turn. The provider retains the original conversation.
  if(historical){
   if(completion&&typeof event.turnId==='string')r.completedTurnIds=[...(r.completedTurnIds||[]),event.turnId];
   this.save(r);return;
  }
  // A late hook may identify the resumable session, but cannot undo Stop or
  // commit a managed deliverable after cancellation has started.
  if(r.state==='stopping'){this.save(r);return}
  if(event.type==='artifact'){
   if(event.taskId===r.id&&event.requestKey===r.artifactRequestKey&&typeof event.path==='string'){
    r.pendingArtifacts=[...(r.pendingArtifacts||[]),{path:event.path,label:event.label,open:event.open===true,ts:event.ts,requestKey:event.requestKey}].slice(-8);this.save(r);
   }
   return;
  }
  const live=this.live.get(id),pending=live?.pendingDelivery;
  if(event.type==='UserPromptSubmit'){
   if(pending&&(r.provider!=='claude'||event.requestKey!==pending.key||!Number.isFinite(event.ts)||event.ts<pending.sentAt||normalizedPrompt(event.prompt)!==normalizedPrompt(pending.text)))return;
   // Proof for Claude: this hook matched the pending delivery's key and text.
   if(pending&&live)live.unsentPaste=false;
   this.finishDelivery(r,live);this.touch(r,{conversation:true});r.state='working';r.error=null;live?.detector?.reset();live?.inputBoundary?.reset();
  }
  if(event.type==='PermissionRequest'){this.cancelSubmit(live);r.state='needs input';r.error='Claude is waiting for your approval. Review the requested action in its terminal.'}
  if(event.type==='StopFailure'){this.clearDelivery(live);r.state='error';r.error='The provider reported a failed turn. See the terminal.'}
  if(completion){
   this.finishDelivery(r,live);
   this.touch(r,{conversation:true});
   if(typeof event.turnId==='string')r.completedTurnIds=[...(r.completedTurnIds||[]),event.turnId];
   const text=typeof event.text==='string'?event.text:'';
   const pending=(r.pendingArtifacts||[]).filter(item=>item.requestKey===r.artifactRequestKey&&(!event.ts||item.ts<=event.ts));
   let output={artifacts:[],errors:[]};
   try{output=captureTurnArtifacts(this.root,r,event,{candidates:pending})}catch(error){output.errors=[String(error.message||error).slice(0,200)]}
   r.pendingArtifacts=[];
   // "Open it when it's done" is honoured once, on the first turn that produced a file.
   if(r.openWhenDone&&output.artifacts.length){
    output.artifacts=promiseOpen(output.artifacts);
    if(output.artifacts.some(item=>item?.open===true))delete r.openWhenDone;
   }
   if((text.trim()||output.artifacts.length||output.errors.length)&&!r.turns.some(t=>t.id===event.turnId)){r.turns.push({id:event.turnId,ts:event.ts||Date.now(),text:text.slice(0,100000),...(output.artifacts.length?{artifacts:output.artifacts}:{}),...(output.errors.length?{artifactErrors:output.errors}:{})});r.turns=r.turns.slice(-30)}
   r.state=this.live.get(id)?.inputBoundary?.hasDraft?'editing':'ready';r.error=null;
   this.live.get(id)?.detector?.reset();
   if(text.trim()&&r.workflow&&!r.workflowCompleted&&!r.skipWorkflowCompletion)saveWorkflowResult(this.root,r,text);
   r.skipWorkflowCompletion=false;
  }
  this.save(r);
 }
 close(){this.closed=true;this.cancelSchedule(this.timer);this.cancelSchedule(this.retentionTimer);if(this.idleTimer)this.cancelSchedule(this.idleTimer);for(const id of [...this.live.keys()])this.stop(id)}
}
