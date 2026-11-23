import {VoiceHub} from './voice-hub.mjs';
import {ArtifactHandoff,artifactSpeech} from './artifact-handoff.mjs';
import {readArtifact} from './artifacts.mjs';
import {artifactOutcomeSpeech} from './artifact-speech.mjs';
import {WorkAttentionEpisodes} from './work-attention.mjs';
import {attachVoiceEvents} from './voice-events.mjs';
import {fastVoiceStatus} from './fast-voice.mjs';
import {createJiti} from 'jiti';
import {readVoiceReport} from './voice-documents.mjs';
import {getCodexUsage} from './codexUsage.mjs';
import {getClaudeUsage} from './claudeUsage.mjs';
import {claudeUsageReading} from './claude-login.mjs';
import {closeClaudeSignIn} from './claude-signin.mjs';
import {taskSummary} from '../shared/work-feed.mjs';
import {readDashboard,saveDashboard,registerDashboardSkill,discoverDashboardSkills,prepareDashboardSkill,assertDashboardReplay} from './dashboard.mjs';
import {configuredVault} from './runtime.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {ROOT,VOICE_MODELS,validateSelection} from '../shared/contract.mjs';
import {assertVault,vaultPath,writeJson} from './core.mjs';
import {cliStatus} from './cli-runtime.mjs';
import {readJson,selection,health} from './bridge-core.mjs';
import {handleVoiceHttp,voiceJson,voiceRequestId as uuid} from './voice-request.mjs';
import {voiceReceiptTransport} from './voice-receipts.mjs';
import {createLiveBridge} from './live/routes.mjs';
import {liveSpeechMode} from './live/speech-mode.mjs';
import {preconnectJev,dropPreparedJev,drainDetachedClassifiers,classifierProcesses} from './jev.mjs';
import {warmOnWake} from './cli-warmup.mjs';
import {NativeTerminalManager} from './native-terminals.mjs';
import {readCurrentState,readConversationEpoch,setCurrent,taskInScope,reconcileCurrent} from './current-conversations.mjs';
import {replaceDaily} from './note-edits.mjs';
import {resolveSpeechService,spokenFlow} from './speech-service.mjs';
import {speechEvents} from './speech-events.mjs';
import {createBridgeAuth} from './bridge-auth.mjs';
import {startLifecycle} from './lifecycle.mjs';
import {waitForResponseDrain} from './stream-backpressure.mjs';
import {selectSpokenAnswer} from './spoken-answer.mjs';
import {speakStreamQuery} from './voice-speed.mjs';
import {readVoicePrefs,saveVoicePrefs,speakPrefsQuery,voiceChoices} from './voice-prefs.mjs';
import {writeVoiceWords,saveVoiceWords} from './voice-words.mjs';
import {scheduleTick,scheduleView,editSchedule} from './schedule.mjs';
import {taskLabel} from './task-updates.mjs';
import {completionLabel} from './voice-conversation-cues.mjs';
const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root=assertVault(configuredVault());
// Claim the singleton port before recovering sessions, collecting hook events,
// warming providers or connecting speech. Duplicate launches must have no side effects.
const booting=(_req,res)=>{res.writeHead(503,{'Content-Type':'application/json','Retry-After':'1'});res.end(JSON.stringify({error:'V2 bridge is starting'}))};
const server=http.createServer(booting);
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(3219,'127.0.0.1',resolve)});
// While any voice request is being handled its follow-up may be on its way to a terminal: nothing is idle-closed.
const terminals=new NativeTerminalManager(root,{voiceBusy:()=>active.size>0});
const speech=await resolveSpeechService(process.env.AOS_V2_SPEECH_URL);
const active=new Map();
let bridgeAuth=null;
let lifecycle=null;
const {workAttentionSpeech,speechText}=await createJiti(import.meta.url).import('../shared/speech-text.ts');
const listeners=new Map();
const localPlaybacks=new Set();
const hub=new VoiceHub({load:()=>readJson(root,`${ROOT}/voice-announcements.json`,[]),save:items=>writeJson(root,`${ROOT}/voice-announcements.json`,items),emit:e=>{for(const res of listeners.values())res.write(`data: ${JSON.stringify(e)}\n\n`);if(e.type==='owner')liveBridge.sweep()},
 canSpeak:()=>readVoicePrefs(root).voiceMode!=='live',onPublish:item=>liveBridge.calls.completion(item)});
const liveBridge=createLiveBridge({root,runtimeDir:path.join(base,'.runtime'),hub,listeners,active,prefs:()=>readVoicePrefs(root),provider:()=>selection(root).provider,
 tasks:scope=>terminals.list().filter(task=>taskInScope(task,scope)&&!task.background),
 readEpoch:(provider,scope)=>readConversationEpoch(root,provider,scope),
 readContext:call=>{
  const chosen=selection(root),current=readCurrentState(root,call.appScope);
  return {selection:chosen,workTarget:current[chosen.provider],appScope:call.appScope,conversationEpoch:readConversationEpoch(root,chosen.provider,call.appScope),revision:current.revision};
 },
 requestContext:()=>({root,terminals,hub,artifacts,artifactTarget,active,speech,liveView:(reply,scope)=>voiceJson(root,scope,(value,status)=>status===400?{reply:value.error}:value,reply)}),
 speechMode:liveSpeechMode({speech,authFile:path.join(base,'.runtime','speech-auth.json')}),
 stopLocalAudio:()=>{for(const playback of localPlaybacks)playback.abort()}});
const liveTimer=setInterval(()=>liveBridge.sweep(),1000);liveTimer.unref();
const artifacts=new ArtifactHandoff({load:()=>readJson(root,`${ROOT}/artifact-handoffs.json`,{}),save:state=>writeJson(root,`${ROOT}/artifact-handoffs.json`,state),onExpired:item=>{
 const replaced=hub.retireCompletion(item.completionId),outcome=replaced&&item.completionText?artifactOutcomeSpeech({}, {text:item.completionText})+' ':'';
 hub.publish(`artifact:${item.id}`,outcome+artifactSpeech([item.artifact],'failed',item.target.kind),{appScope:item.target.kind,kind:'completion-error',taskId:item.artifact.taskId});
}});
// Leases must settle even if a lost/reloaded viewer never polls again.
const artifactTimer=setInterval(()=>{try{artifacts.sweep()}catch{lifecycle?.mark('artifact-sweep-failed')}},5000);artifactTimer.unref();
function artifactTarget(client,provider,epoch,appScope='web'){
 const surface=hub.live().find(item=>item.id===client);
 return surface&&surface.kind===appScope&&listeners.has(client)?{client,kind:surface.kind,provider,epoch}:null;
}
const knownTurns=new Set([...terminals.records.values()].flatMap(t=>[
 ...t.turns.map(turn=>`${t.id}:${turn.id}`),...(t.workflowCompleted&&t.workflow?.job?[`${t.id}:workflow:${t.workflow.job.id}`]:[])
]));
const attentionEpisodes=new WorkAttentionEpisodes(terminals.list());
terminals.onRemove=r=>{for(const key of knownTurns)if(key.startsWith(r.id+':'))knownTurns.delete(key);attentionEpisodes.remove(r.id);artifacts.remove(r.id)};
terminals.onChange=r=>{
 const dashboardOnly=r.execution==='headless'||r.background;
 if(dashboardOnly&&readVoicePrefs(root).voiceMode!=='live')return;
 const appScope=r.appScope||(r.execution==='native'?'native':'web');
 const runId=r.workflowCompleted&&r.workflow?.job?.id;
 const runKey=runId&&`${r.id}:workflow:${runId}`;
 const run=runKey&&!knownTurns.has(runKey)?readJson(root,`${ROOT}/runs/${runId}.json`,null):null;
 if(run)knownTurns.add(runKey);
 const liveInfo={liveCallId:r.activeLiveCallId,taskLabel:taskLabel(r),summary:run?.summary,deliverable:run?.deliverable_path||r.resultPath};
 if(!['needs input','error'].includes(r.state))hub.resolveTaskAttention(r.id);
 for(const turn of r.turns){const key=`${r.id}:${turn.id}`;if(!knownTurns.has(key)){
  knownTurns.add(key);
  const outcome=artifactOutcomeSpeech(r,turn);if(!dashboardOnly)artifacts.publish(r,turn,outcome);
  // Only the viewer can confirm that the worker's output was displayed.
  const artifactFailure=turn.artifactErrors?.length>0;
  const spoken=outcome;
  const blocked=/^\s*BLOCKED:/i.test(turn.text);
  hub.publish(key,spoken||run?.summary||turn.text,{appScope,kind:artifactFailure||run?.status==='error'||blocked?'completion-error':'completion',taskId:r.id,label:completionLabel(r,turn),...liveInfo,liveCallId:turn.liveCallId||liveInfo.liveCallId,summary:r.error||liveInfo.summary||(blocked?turn.text:undefined)||spoken});
 }}
 if(dashboardOnly&&run&&!r.turns.length){
  hub.publish(runKey,run.summary,{appScope,kind:run.status==='error'?'completion-error':'completion',taskId:r.id,...liveInfo});
 }
 const attention=attentionEpisodes.next(r);
 if(attention&&!(attention.state==='error'&&run?.status==='error'&&(dashboardOnly||r.turns.length)))hub.publish(attention.id,workAttentionSpeech(r.provider,attention.state,attention.reason),{appScope,kind:attention.state==='error'?'error':'attention',taskId:r.id,label:completionLabel(r),...liveInfo,summary:r.error||attention.reason});
};
// A real capture start (wake) also warms the Codex binary, off this event loop; see cli-warmup.mjs.
// Connecting, failing and retrying live in speech-events.mjs: a speech service that is not accepting
// sockets must never be able to take the bridge down.
const speechLink=speechEvents(speech.replace(/^http/,'ws')+'/events',e=>{let message;try{message=JSON.parse(String(e.data))}catch{return}
 if(liveBridge.calls.audioHeld){
  if(message.type==='hello')liveBridge.calls.speechBoot(message.bootId);
  if(message.type==='hotkey'||message.type==='capture-request')liveBridge.calls.hotkey();
  return;
 }
 try{preconnectJev()}catch{}try{warmOnWake(message)}catch{}try{hub.capture(message)}catch{}
});

const origins=new Set(['http://127.0.0.1:3217','http://localhost:3217','http://127.0.0.1:3218','app://obsidian.md']);
async function body(req,max=20000){let size=0;const chunks=[];for await(const b of req){size+=b.length;if(size>max)throw new Error('Request too large');chunks.push(b)}return Buffer.concat(chunks)}
const list=dir=>{const p=vaultPath(root,`${ROOT}/${dir}`);return fs.existsSync(p)?fs.readdirSync(p).filter(n=>n.endsWith('.json')).map(n=>readJson(root,`${ROOT}/${dir}/${n}`,null)).filter(Boolean):[]};
// Kept up to date for the local voice service: at start, every ten minutes, and whenever the member teaches
// or forgets a word. A failure here never touches a voice request.
let voiceWordsNow=null;
const refreshVoiceWords=()=>{const list=writeVoiceWords(root);return voiceWordsNow={words:list.words,yours:list.yours,learned:list.learned,ignored:list.ignored,learn:list.learn}};
setTimeout(()=>{try{refreshVoiceWords()}catch{}},3000).unref();
setInterval(()=>{try{refreshVoiceWords()}catch{}},600000).unref();
// Scheduled workflows (schedule.mjs): the same background run a dashboard button starts, started by the clock.
// Nothing is scheduled unless the member added it. A look every half minute; a fault here never reaches a request.
const scheduleLook=()=>{scheduleTick(root,(job,id)=>terminals.startWorkflow({id,skill:job.skill,args:{},selection:selection(root),execution:'headless',appScope:'web'}))};
const scheduleTimer=setInterval(scheduleLook,30000);scheduleTimer.unref();
// And once as soon as the bridge has finished starting, so one that comes up in the last seconds before
// midnight still catches that day's last job.
setImmediate(scheduleLook);
async function speechHealth(){try{const r=await fetch(`${speech}/health`,{signal:AbortSignal.timeout(1500)});return r.ok?await r.json():null}catch{return null}}
function providerHealth(){return Object.fromEntries(['codex','claude'].map(provider=>[provider,cliStatus(provider)]))}
function bridgeStatus(){const providers=providerHealth();return {selection:selection(root),health:{ts:new Date().toISOString(),pid:process.pid,busy:[...terminals.live.keys()].some(id=>['working','starting'].includes(terminals.get(id).state)),active:terminals.live.size,pending:0,providers},providers,vault:root}}
server.removeListener('request',booting);
server.on('request',async(req,res)=>{
 const origin=req.headers.origin;
 if(req.headers.host!=='127.0.0.1:3219'||(origin&&!origins.has(origin))){res.writeHead(403);res.end();return}
 if(origin)res.setHeader('Access-Control-Allow-Origin',origin);
 res.setHeader('Vary','Origin');res.setHeader('Cache-Control','no-store');
 res.setHeader('Access-Control-Allow-Headers','Content-Type,X-V2-Request,X-V2-Selection,X-V2-Work,X-V2-Token,X-V2-Surface,X-V2-App,X-V2-Surface-Secret,X-V2-Call');
 res.setHeader('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');res.setHeader('Access-Control-Max-Age','600');
 if(req.method==='OPTIONS'){res.writeHead(204);res.end();return}
 const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value))};
 const appScope=req.headers['x-v2-app']==='native'?'native':'web';
 const scopedTask=id=>{const task=terminals.get(id);if(!taskInScope(task,appScope))throw new Error('This terminal belongs to the other app.');return task};
 if((req.headers['x-v2-app']&&!['native','web'].includes(req.headers['x-v2-app']))||!bridgeAuth?.accepts(appScope==='native'?'POST':req.method,req.headers))return json({error:'Bridge authentication required'},401);
 try{
  const url=new URL(req.url,'http://127.0.0.1:3219');
  if(url.pathname==='/voice/surface/register'||url.pathname.startsWith('/voice/live/'))return await liveBridge.handle({url,req,res,appScope,body,json,uuid,acceptsToken:()=>bridgeAuth.accepts('POST',req.headers)});
  const verifySurface=id=>liveBridge?.verifySurface(id,appScope,req.headers['x-v2-surface-secret']);
  // Dashboard configuration is shared between surfaces. These routes retain the
  // bridge's existing origin, authentication and native/web ownership guards.
  if(url.pathname==='/dashboard'&&req.method==='GET')return json(readDashboard(root));
  if(url.pathname==='/dashboard/discover'&&req.method==='GET')return json(discoverDashboardSkills(root,{provider:url.searchParams.get('provider')}));
  if(url.pathname==='/dashboard'&&req.method==='POST')return json(saveDashboard(root,JSON.parse((await body(req)).toString())));
  if(url.pathname==='/dashboard/register'&&req.method==='POST')return json(registerDashboardSkill(root,JSON.parse((await body(req)).toString())));
  if(url.pathname==='/dashboard/launch'&&req.method==='POST'){
   const b=JSON.parse((await body(req)).toString());
   if(!uuid(b.id))throw new Error('Invalid task ID');
   const previous=terminals.records.get(b.id)||terminals.workflowRequest(b.id)?.record;
   if(previous)scopedTask(previous.id);
   const prepared=prepareDashboardSkill(root,{skill:b.skill,request:b.request,selection:b.selection||selection(root)});
   assertDashboardReplay(previous,prepared,appScope);
   readCurrentState(root,appScope);
   const task=terminals.start({id:b.id,...prepared,reveal:false,...(appScope==='native'?{execution:'native'}:{})});
   if(!previous)setCurrent(root,terminals,{provider:task.provider,id:task.id,scope:appScope});
   return json(task);
  }
  if(url.pathname.startsWith('/native/')){
   if(appScope!=='native')return json({error:'Native Obsidian authorization required'},403);
   if(req.method==='GET'&&url.pathname==='/native/pending')return json(terminals.pendingNative());
   if(req.method!=='POST')return json({error:'Method not allowed'},405);
   const b=JSON.parse((await body(req,50000)).toString());
   if(url.pathname==='/native/claim')return json(terminals.claimNative(b.id));
   if(url.pathname==='/native/event')return json(terminals.nativeEvent(b));
   if(url.pathname==='/native/presence')return json(terminals.nativePresence(b.sessions));
   if(url.pathname==='/native/submit-check')return json(terminals.submitNative(b));
   return json({error:'Native action not found'},404);
  }
  if(url.pathname==='/voice/events'&&req.method==='GET'){
   const client=url.searchParams.get('client');if(!uuid(client)&&!liveBridge?.surfaces.registered(client))throw new Error('Invalid voice surface');
   liveBridge?.surfaces.connect(client,appScope,req.headers['x-v2-surface-secret']);
   attachVoiceEvents(client,res,listeners,hub,id=>liveBridge?.surfaceGone(id));return;
  }
  if(url.pathname==='/artifacts/file'&&req.method==='GET'){
   let result;try{result=readArtifact(root,url.searchParams.get('id'))}catch{return json({error:'This saved artifact is unavailable.'},404)}
   const {artifact,bytes}=result;
   res.writeHead(200,{'Content-Type':artifact.mime,'Content-Length':artifact.bytes,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Content-Disposition':'inline'});
   res.end(bytes);return;
  }
  if(url.pathname==='/artifacts/claim'&&req.method==='POST'){
   const b=JSON.parse((await body(req)).toString());verifySurface(b.client);
   const client=hub.live().find(item=>item.id===b.client);
   if(!client||client.kind!==appScope||!listeners.has(b.client)||b.visible!==true||b.mode!=='idle')return json({action:null});
   // Refresh an existing connection without taking an audio playback lease.
   hub.presence({...client,id:b.client,visible:true,mode:client.mode==='live'?'live':'idle',focus:false,claim:false});
   if(hub.owner&&hub.owner!==b.client)return json({action:null});
   const current=readCurrentState(root,appScope),provider=selection(root).provider;
   const action=artifacts.claim(b.client,(target,artifact)=>target.provider===provider&&target.epoch===readConversationEpoch(root,provider,appScope)&&current[provider]===artifact.taskId);
   return json({action});
  }
  if(url.pathname==='/artifacts/ack'&&req.method==='POST'){
   const b=JSON.parse((await body(req)).toString());verifySurface(b.client);if(typeof b.ok!=='boolean')throw new Error('Invalid artifact confirmation');
   const {item,fresh}=artifacts.ack(b.id,b.client,b.ok,b.error);
   if(fresh){
    const replaced=hub.retireCompletion(item.completionId);
    const outcome=replaced&&item.completionText?artifactOutcomeSpeech({}, {text:item.completionText})+' ':'';
    hub.publish(`artifact:${item.id}`,outcome+artifactSpeech([item.artifact],item.state,item.target.kind),{appScope:item.target.kind,kind:b.ok?'artifact-confirmation':'completion-error',taskId:item.artifact.taskId});
   }
   return json({ok:true});
  }
  if(['/voice/surface','/voice/ack','/voice/leave','/voice/announce'].includes(url.pathname)&&req.method==='POST'){
   const b=JSON.parse((await body(req)).toString());
   // A late heartbeat must not revive a surface that cannot receive events.
   if(url.pathname==='/voice/surface'){verifySurface(b.id);if(b.kind!==appScope)throw new Error('Voice surface belongs to a different app.');if(!listeners.has(b.id)){hub.leave(b.id);return b.focus?json({error:'Voice connection is reconnecting. Try again.'},503):json(null)}return json(hub.presence(b))}
   if(url.pathname==='/voice/ack'){verifySurface(b.client);hub.ack(b.id,b.client,!!b.ok);return json({ok:true})}
   if(url.pathname==='/voice/leave'){verifySurface(b.id);hub.leave(b.id);liveBridge?.surfaceGone(b.id);return json({ok:true})}
   if(typeof b.id!=='string'||b.id.length>400||typeof b.text!=='string'||b.text.length>2000)throw new Error('Invalid announcement');
   // The terminal publisher already announces these runs with full answer text.
   const runId=b.id.startsWith('run:')?b.id.slice(4):null;
   const record=runId?terminals.records.get(runId):null;
   const liveCompletion=liveBridge?.calls.audioHeld&&uuid(runId);
   if(record&&(!liveCompletion||!(record.execution==='headless'||record.background)))return json({ok:true});
   hub.publish(b.id,speechText(b.text,700),{appScope,...(liveCompletion?{kind:'completion',taskId:runId}:{})});return json({ok:true});
  }
  if(url.pathname==='/usage'&&req.method==='GET'){const provider=url.searchParams.get('provider')||'codex';if(!['codex','claude'].includes(provider))return json({error:'Unknown provider'},400);const gone=new AbortController();res.on('close',()=>gone.abort());if(provider==='codex')return json(await getCodexUsage());return json(await claudeUsageReading({signal:gone.signal,getUsage:getClaudeUsage}))}
  if(url.pathname==='/notes/replace'&&req.method==='POST')return json(replaceDaily(root,JSON.parse((await body(req,1100000)).toString())));
  if(url.pathname==='/work'&&req.method==='GET'){const {revision,...current}=reconcileCurrent(root,terminals,{scope:appScope});return json({tasks:url.searchParams.get('summary')==='1'?terminals.list().filter(t=>taskInScope(t,appScope)).map(taskSummary):terminals.list().filter(t=>taskInScope(t,appScope)),vault:root,current,currentRevision:revision,attachmentProtocol:1})}
  if(url.pathname==='/work/current'&&req.method==='GET')return json(reconcileCurrent(root,terminals,{scope:appScope}));
  if(url.pathname==='/work/request'&&req.method==='GET'){scopedTask(url.searchParams.get('id'));return json(terminals.originalRequest(url.searchParams.get('id')))};
  if(url.pathname==='/work/answer'&&req.method==='GET'){const task=scopedTask(url.searchParams.get('id'));const turn=task.turns.find(t=>t.id===url.searchParams.get('turn'));if(!turn)return json({error:'Answer not found'},404);return json(turn)}
  if(url.pathname==='/work/output'&&req.method==='GET'){scopedTask(url.searchParams.get('id'));return json(terminals.output(url.searchParams.get('id'),Number(url.searchParams.get('cursor')||0),url.searchParams.get('instance')||''))};
  if(url.pathname.startsWith('/work/')&&req.method==='POST'){
   const b=JSON.parse((await body(req,50000)).toString());
   if(!['/work/current','/work/session','/work/start','/work/skill'].includes(url.pathname))scopedTask(b.id);
   else if(!['/work/current','/work/session'].includes(url.pathname)){
    const previous=terminals.records.get(b.id)||terminals.workflowRequest(b.id)?.record;
    if(previous)scopedTask(previous.id);
   }
   switch(url.pathname){
    case '/work/session':{if(!uuid(b.sessionId))throw new Error('Invalid app session');return json(reconcileCurrent(root,terminals,{scope:appScope,sessionId:b.sessionId,sessionMode:b.mode??'fresh'}))}
    case '/work/current':return json(setCurrent(root,terminals,{...b,scope:appScope}));
    case '/work/start':{readCurrentState(root,appScope);const existed=terminals.records.has(b.id),task=terminals.start({id:b.id,prompt:b.prompt,title:b.title,selection:b.selection||selection(root),...(appScope==='native'?{execution:'native'}:{})});if(!existed)setCurrent(root,terminals,{provider:task.provider,id:task.id,scope:appScope});return json(task)}
    case '/work/skill':return json(terminals.startWorkflow({id:b.id,skill:b.skill,args:b.args||{},selection:b.selection||selection(root),execution:'headless',appScope}));
    case '/work/input':terminals.input(b.id,b.data,b.instance);return json({ok:true});
    case '/work/send':return json(terminals.send(b.id,b.text));
    case '/work/ready':return json(terminals.markReady(b.id,{confirmedEmpty:b.confirmedEmpty}));
    case '/work/resize':terminals.resize(b.id,b.cols,b.rows,b.instance);return json({ok:true});
    case '/work/resume':return json(terminals.resume(b.id));
    case '/work/stop':return json(b.ifIdle===true?terminals.stopIfIdle(b.id):terminals.stop(b.id));
    case '/work/keep':return json(terminals.setKeep(b.id,b.keep));
   }
  }
  if(['/services','/work/services'].includes(url.pathname)&&req.method==='GET')return json({bridge:{online:true,pid:process.pid,uptimeSeconds:Math.round(process.uptime()),memoryMiB:Math.round(process.memoryUsage().rss/1048576)},surfaces:hub.live(),providers:providerHealth(),voice:fastVoiceStatus(),speech:{eventsConnected:speechLink.connected(),url:speech,shared:speech.endsWith(':3108'),health:await speechHealth(),captureEvents:hub.captureDiagnostics()},tasks:terminals.list().map(t=>({id:t.id,title:t.title,state:t.state,provider:t.provider})),legacyQueue:{online:!!health(root),pending:list('queue').length},shutdownCommand:'scripts/services.ps1 -Action Stop',note:'Only V2-owned services are stopped. The shared speech service and original V1 services are retained.'});
  if(url.pathname==='/shutdown'&&req.method==='POST'){
   if([...terminals.live.keys()].some(id=>terminals.get(id).execution!=='native')||active.size||classifierProcesses().total)return json({error:'Stop active terminal tasks and voice requests first. Saved conversations and message-box drafts are retained.'},409);
   // Persist intent before releasing the port so recovery cannot undo an explicit Stop.
   fs.writeFileSync(path.join(base,'.runtime/services-paused.json'),JSON.stringify({ts:new Date().toISOString(),reason:'idle shutdown request'}));
   json({ok:true});lifecycle?.stop('idle shutdown request');dropPreparedJev();closeClaudeSignIn();void liveBridge?.calls.shutdown();terminals.close();clearInterval(artifactTimer);clearInterval(scheduleTimer);clearInterval(liveTimer);speechLink.stop();for(const response of listeners.values())response.end();server.close();setTimeout(()=>server.closeAllConnections(),500).unref();return;
  }
  if(url.pathname==='/status'&&req.method==='GET')return json(bridgeStatus());
  if(url.pathname==='/state'&&req.method==='GET')return json({...bridgeStatus(),runs:list('runs').sort((a,b)=>(b.ts_started||'').localeCompare(a.ts_started||'')).slice(0,20),queue:[]});
  if(url.pathname==='/selection'&&req.method==='POST'){const chosen=validateSelection(JSON.parse((await body(req)).toString()));writeJson(root,`${ROOT}/provider.json`,chosen);liveBridge?.sweep();return json(chosen)}
  if(url.pathname==='/queue'&&req.method==='POST'){const b=JSON.parse((await body(req)).toString());return json(terminals.startWorkflow({id:b.id,skill:b.skill,args:b.args||{},selection:b.selection||selection(root),execution:'headless',appScope}))}
  if(url.pathname==='/report'&&req.method==='GET')return json(readVoiceReport(root,url.searchParams.get('path')||'',list('runs'),list('voice-results')));
  // How voice sounds in this vault: spoken replies on or off, which voice, how fast. Both screens read and
  // write it here, so a change on one shows on the other.
  if(url.pathname==='/voice/prefs'&&req.method==='GET')return json(readVoicePrefs(root));
  if(url.pathname==='/voice/prefs'&&req.method==='POST'){const prefs=saveVoicePrefs(root,JSON.parse((await body(req)).toString()));liveBridge?.sweep();return json(prefs)}
  // The words voice listens for: learned from the names of this vault's notes, plus the member's own.
  if(url.pathname==='/schedule'&&req.method==='GET')return json(scheduleView(root));
  // A save must name the revision it was made from, so a screen holding an old copy cannot undo a pause.
  // The schedule is sent in its stored shape: {paused, jobs: [{id, skill, at, days, enabled}]}.
  if(url.pathname==='/schedule'&&req.method==='POST'){const b=JSON.parse((await body(req)).toString());if(typeof b?.revision!=='string'||!b.schedule)throw new Error('Send {revision, schedule}; the revision comes from the last read.');editSchedule(root,()=>b.schedule,{revision:b.revision});return json(scheduleView(root))}
  // Reading shows the list as last built (at start, every ten minutes, and after a change): it never scans the vault.
  if(url.pathname==='/voice/words'&&req.method==='GET')return json(voiceWordsNow||refreshVoiceWords());
  if(url.pathname==='/voice/words'&&req.method==='POST'){saveVoiceWords(root,JSON.parse((await body(req)).toString()));return json(refreshVoiceWords())}
  if(url.pathname==='/voice/voices'&&req.method==='GET'){let service=null;try{const answer=await fetch(`${speech}/voices`,{signal:AbortSignal.timeout(3000)});if(answer.ok)service=await answer.json()}catch{}return json(voiceChoices(service))}
  if(url.pathname==='/voice/config'){
   if(req.method==='GET')return json(VOICE_MODELS);
   if(req.method==='POST')return json({error:'Voice routing is fixed: Luna for Codex, Haiku for Claude.'},405);
  }
  if(url.pathname==='/voice/health'&&req.method==='GET'){const s=await speechHealth();return json({ok:!!s?.ok&&!!s?.stt?.ok,engine:'Whisper / Kokoro',speech:s,worker:!!health(root)})}
  if(url.pathname==='/voice/cancel'&&req.method==='POST'){const b=JSON.parse((await body(req)).toString());if(!uuid(b.id))throw new Error('Invalid request ID');writeJson(root,`${ROOT}/voice-cancelled/${b.id}.json`,{ts:Date.now()});active.get(b.id)?.abort();return json({ok:true})}
  if(url.pathname==='/voice/transcript'){
   const since=readJson(root,`${ROOT}/voice-clear.json`,{ts:0}).ts;
   const records=list('voice-results').filter(r=>r.ts>since&&voiceReceiptTransport(r)==='local').sort((a,b)=>a.ts-b.ts).slice(-30);if(req.method==='GET')return json({path:'system/voice/transcript',content:records.map(r=>`**You (${r.provider}):** ${r.transcript}\n\n**Agent (${r.model||'direct command'}):** ${r.reply}`).join('\n\n---\n\n')||'No voice requests yet.'});
   // Transcript records double as durable duplicate protection; clear the display without deleting receipts.
   if(req.method==='DELETE'){writeJson(root,`${ROOT}/voice-clear.json`,{ts:Date.now()});return json({ok:true})}
  }
  if(url.pathname==='/voice/speak'&&['POST','GET'].includes(req.method)){
   const b=req.method==='GET'?{text:url.searchParams.get('text')}:JSON.parse((await body(req)).toString());if(typeof b.text!=='string'||!b.text.trim()||b.text.length>2000)throw new Error('Invalid speech text');
   // Spoken replies switched off for this vault: no audio is ever sent, whatever a screen believed. The
   // screens treat this answer as "said, silently".
   if(liveBridge?.calls.audioHeld||!readVoicePrefs(root).spokenReplies)return json({muted:true});
   const stop=new AbortController();res.on('close',()=>stop.abort());localPlaybacks?.add(stop);
   try{// A GET is the player that plays audio as it arrives: it is sent sentence by sentence (voice-speed.mjs).
   // A POST is the buffered fallback, which decodes one complete file and keeps getting exactly that.
   const out=await fetch(`${speech}/speak?text=${encodeURIComponent(speechText(spokenFlow(selectSpokenAnswer(b.text,{mode:'reply'}))))}${speakStreamQuery(req.method)}${speakPrefsQuery(readVoicePrefs(root))}`,{signal:AbortSignal.any([stop.signal,AbortSignal.timeout(60000)])});if(!out.ok)throw new Error('Local speech playback is unavailable');
   res.writeHead(200,{'Content-Type':'audio/wav'});
   // A reply that broke off while being spoken is cut, not ended: the player then reports an interruption
   // instead of treating half a reply as the whole one.
   try{for await(const chunk of out.body){if(res.destroyed)break;if(!res.write(chunk)&&!await waitForResponseDrain(res))break}}catch{res.destroy();return}
   if(!res.destroyed)res.end();return;
   }finally{localPlaybacks?.delete(stop)}
  }
  if(['/voice/audio','/voice/text'].includes(url.pathname)&&req.method==='POST'){
   const surface=req.headers['x-v2-surface'];verifySurface(surface);
   if(liveBridge?.calls.audioHeld&&(url.pathname==='/voice/audio'||liveBridge.calls.call.ownerSurface!==surface||liveBridge.calls.call.appScope!==appScope))throw new Error('Live call in progress.');
   return await handleVoiceHttp({root,terminals,hub,artifacts,artifactTarget,active,speech},req,res,{body,json,appScope,source:url.pathname==='/voice/audio'?'audio':'text'});
  }
  json({error:'Not found'},404);
 }catch(e){if(!res.headersSent)json({error:String(e.message||e),...(typeof e?.code==='string'&&/^TERMINAL_[A-Z_]+$/.test(e.code)?{code:e.code}:{})},400);else res.end()}
});
{
 // Mint only after binding succeeds: a duplicate launch must not rotate a live bridge's token.
 bridgeAuth=createBridgeAuth(path.join(base,'.runtime'));
 const installedProviders=providerHealth();
 lifecycle=startLifecycle(path.join(base,'.runtime'),{service:'v2-bridge',version:JSON.parse(fs.readFileSync(path.join(base,'package.json'),'utf8')).version,providers:installedProviders});
 lifecycle.mark('listening',{port:3219});
 liveBridge.sweep();
 const plugin=vaultPath(root,'.obsidian/plugins/agentic-os-v2');
 if(fs.existsSync(plugin))fs.copyFileSync(bridgeAuth.file,vaultPath(root,'.obsidian/plugins/agentic-os-v2/bridge-auth.json'));
 console.log(`V2 bridge :3219 · ${root} · speech ${speech}`);
 for(const [provider,info] of Object.entries(installedProviders))console.log(`${provider}: ${info.version||info.detail} · ${info.command||'unavailable'} (${info.source||'none'})`);
}
process.on('uncaughtExceptionMonitor',error=>lifecycle?.mark('uncaught-exception',{code:error.code||error.name}));
process.on('exit',code=>{if(code===0)lifecycle?.stop('process exit');else lifecycle?.mark('exit',{exitCode:code})});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{{const open=classifierProcesses();if(open.total)lifecycle?.mark('classifiers-open-at-shutdown',{reason:`running=${open.running} detached=${open.detached}`})}lifecycle?.stop(signal);closeClaudeSignIn();void liveBridge.calls.shutdown();for(const c of active.values())c.abort();drainDetachedClassifiers({timeoutMs:12000}).then(drained=>{if(drained.remaining)console.error(`[shutdown] ${drained.remaining} classifier process(es) did not confirm closure.`)});terminals.close();clearInterval(artifactTimer);clearInterval(scheduleTimer);clearInterval(liveTimer);speechLink.stop();for(const response of listeners.values())response.end();server.close()});
