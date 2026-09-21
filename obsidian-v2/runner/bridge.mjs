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
import {closeClaudeSignIn} from './claude-signin.mjs';
import {taskSummary} from '../shared/work-feed.mjs';
import {configuredVault} from './runtime.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {ROOT,VOICE_MODELS,validateSelection} from '../shared/contract.mjs';
import {assertVault,vaultPath,writeJson} from './core.mjs';
import {cliStatus} from './cli-runtime.mjs';
import {readJson,selection,health,enqueue,routeVoice} from './bridge-core.mjs';
import {preconnectJev,prepareJev,dropPreparedJev,drainDetachedClassifiers,classifierProcesses} from './jev.mjs';
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
const hub=new VoiceHub({load:()=>readJson(root,`${ROOT}/voice-announcements.json`,[]),save:items=>writeJson(root,`${ROOT}/voice-announcements.json`,items),emit:e=>{for(const res of listeners.values())res.write(`data: ${JSON.stringify(e)}\n\n`)}});
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
const knownTurns=new Set(terminals.list().flatMap(t=>t.turns.map(turn=>`${t.id}:${turn.id}`)));
const attentionEpisodes=new WorkAttentionEpisodes(terminals.list());
terminals.onRemove=r=>{for(const key of knownTurns)if(key.startsWith(r.id+':'))knownTurns.delete(key);attentionEpisodes.remove(r.id);artifacts.remove(r.id)};
terminals.onChange=r=>{
 if(r.execution==='headless'||r.background)return;
 if(!['needs input','error'].includes(r.state))hub.resolveTaskAttention(r.id);
 for(const turn of r.turns){const key=`${r.id}:${turn.id}`;if(!knownTurns.has(key)){
  knownTurns.add(key);
  const outcome=artifactOutcomeSpeech(r,turn);artifacts.publish(r,turn,outcome);
  // Only the viewer can confirm that the worker's output was displayed.
  const artifactFailure=turn.artifactErrors?.length>0;
  const spoken=outcome;
  hub.publish(key,spoken,{appScope:r.appScope||(r.execution==='native'?'native':'web'),kind:artifactFailure||r.workflowCompleted&&r.workflowStatus==='error'&&r.error?'completion-error':'completion',taskId:r.id,label:completionLabel(r,turn)});
 }}
 const attention=attentionEpisodes.next(r);
 if(attention)hub.publish(attention.id,workAttentionSpeech(r.provider,attention.state,attention.reason),{appScope:r.appScope||(r.execution==='native'?'native':'web'),kind:attention.state==='error'?'error':'attention',taskId:r.id,label:completionLabel(r)});
};
// A real capture start (wake) also warms the Codex binary, off this event loop; see cli-warmup.mjs.
// Connecting, failing and retrying live in speech-events.mjs: a speech service that is not accepting
// sockets must never be able to take the bridge down.
const speechLink=speechEvents(speech.replace(/^http/,'ws')+'/events',e=>{try{preconnectJev()}catch{}let message;try{message=JSON.parse(String(e.data))}catch{return}try{warmOnWake(message)}catch{}try{hub.capture(message)}catch{}});

const origins=new Set(['http://127.0.0.1:3217','http://localhost:3217','http://127.0.0.1:3218','app://obsidian.md']);
const uuid=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
async function body(req,max=20000){let size=0;const chunks=[];for await(const b of req){size+=b.length;if(size>max)throw new Error('Request too large');chunks.push(b)}return Buffer.concat(chunks)}
const list=dir=>{const p=vaultPath(root,`${ROOT}/${dir}`);return fs.existsSync(p)?fs.readdirSync(p).filter(n=>n.endsWith('.json')).map(n=>readJson(root,`${ROOT}/${dir}/${n}`,null)).filter(Boolean):[]};
async function speechHealth(){try{const r=await fetch(`${speech}/health`,{signal:AbortSignal.timeout(1500)});return r.ok?await r.json():null}catch{return null}}
function providerHealth(){return Object.fromEntries(['codex','claude'].map(provider=>[provider,cliStatus(provider)]))}
function bridgeStatus(){const providers=providerHealth();return {selection:selection(root),health:{ts:new Date().toISOString(),pid:process.pid,busy:[...terminals.live.keys()].some(id=>['working','starting'].includes(terminals.get(id).state)),active:terminals.live.size,pending:0,providers},providers,vault:root}}
server.removeListener('request',booting);
server.on('request',async(req,res)=>{
 const origin=req.headers.origin;
 if(req.headers.host!=='127.0.0.1:3219'||(origin&&!origins.has(origin))){res.writeHead(403);res.end();return}
 if(origin)res.setHeader('Access-Control-Allow-Origin',origin);
 res.setHeader('Vary','Origin');res.setHeader('Cache-Control','no-store');
 res.setHeader('Access-Control-Allow-Headers','Content-Type,X-V2-Request,X-V2-Selection,X-V2-Work,X-V2-Token,X-V2-Surface,X-V2-App');
 res.setHeader('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');res.setHeader('Access-Control-Max-Age','600');
 if(req.method==='OPTIONS'){res.writeHead(204);res.end();return}
 const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value))};
 const appScope=req.headers['x-v2-app']==='native'?'native':'web';
 const scopedTask=id=>{const task=terminals.get(id);if(!taskInScope(task,appScope))throw new Error('This terminal belongs to the other app.');return task};
 const voiceJson=(full,cached=false)=>{
  const {decision:_decision,origin:_origin,...value}=full;
  if(value.conversationResetError)return json({error:value.conversationResetError},400);
  try{const {revision,...current}=readCurrentState(root,appScope);const conversationSuperseded=value.conversationSuperseded||(value.conversationEpoch??0)!==readConversationEpoch(root,value.provider,appScope);return json({...value,...(conversationSuperseded?{conversationSuperseded:true}:{}),current,currentRevision:revision})}
  catch(error){if(cached)return json(value);throw error}
 };
 if((req.headers['x-v2-app']&&!['native','web'].includes(req.headers['x-v2-app']))||!bridgeAuth?.accepts(appScope==='native'?'POST':req.method,req.headers))return json({error:'Bridge authentication required'},401);
 try{
  const url=new URL(req.url,'http://127.0.0.1:3219');
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
   const client=url.searchParams.get('client');if(!uuid(client))throw new Error('Invalid voice surface');
   attachVoiceEvents(client,res,listeners,hub);return;
  }
  if(url.pathname==='/artifacts/file'&&req.method==='GET'){
   let result;try{result=readArtifact(root,url.searchParams.get('id'))}catch{return json({error:'This saved artifact is unavailable.'},404)}
   const {artifact,bytes}=result;
   res.writeHead(200,{'Content-Type':artifact.mime,'Content-Length':artifact.bytes,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Content-Disposition':'inline'});
   res.end(bytes);return;
  }
  if(url.pathname==='/artifacts/claim'&&req.method==='POST'){
   const b=JSON.parse((await body(req)).toString()),client=hub.live().find(item=>item.id===b.client);
   if(!client||client.kind!==appScope||!listeners.has(b.client)||b.visible!==true||b.mode!=='idle')return json({action:null});
   // Refresh an existing connection without taking an audio playback lease.
   hub.presence({...client,id:b.client,visible:true,mode:'idle',focus:false,claim:false});
   if(hub.owner&&hub.owner!==b.client)return json({action:null});
   const current=readCurrentState(root,appScope),provider=selection(root).provider;
   const action=artifacts.claim(b.client,(target,artifact)=>target.provider===provider&&target.epoch===readConversationEpoch(root,provider,appScope)&&current[provider]===artifact.taskId);
   return json({action});
  }
  if(url.pathname==='/artifacts/ack'&&req.method==='POST'){
   const b=JSON.parse((await body(req)).toString());if(typeof b.ok!=='boolean')throw new Error('Invalid artifact confirmation');
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
   if(url.pathname==='/voice/surface'){if(b.kind!==appScope)throw new Error('Voice surface belongs to a different app.');if(!listeners.has(b.id)){hub.leave(b.id);return b.focus?json({error:'Voice connection is reconnecting. Try again.'},503):json(null)}return json(hub.presence(b))}
   if(url.pathname==='/voice/ack'){hub.ack(b.id,b.client,!!b.ok);return json({ok:true})}
   if(url.pathname==='/voice/leave'){hub.leave(b.id);return json({ok:true})}
   if(typeof b.id!=='string'||b.id.length>400||typeof b.text!=='string'||b.text.length>2000)throw new Error('Invalid announcement');
   // The terminal publisher already announces these runs with full answer text.
   if(b.id.startsWith('run:')&&terminals.records.has(b.id.slice(4)))return json({ok:true});
   hub.publish(b.id,speechText(b.text,700),{appScope});return json({ok:true});
  }
  if(url.pathname==='/usage'&&req.method==='GET'){const provider=url.searchParams.get('provider')||'codex';if(!['codex','claude'].includes(provider))return json({error:'Unknown provider'},400);const gone=new AbortController();res.on('close',()=>gone.abort());return json(await (provider==='codex'?getCodexUsage():getClaudeUsage({signal:gone.signal})))}
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
   json({ok:true});lifecycle?.stop('idle shutdown request');dropPreparedJev();closeClaudeSignIn();terminals.close();clearInterval(artifactTimer);speechLink.stop();for(const response of listeners.values())response.end();server.close();setTimeout(()=>server.closeAllConnections(),500).unref();return;
  }
  if(url.pathname==='/status'&&req.method==='GET')return json(bridgeStatus());
  if(url.pathname==='/state'&&req.method==='GET')return json({...bridgeStatus(),runs:list('runs').sort((a,b)=>(b.ts_started||'').localeCompare(a.ts_started||'')).slice(0,20),queue:[]});
  if(url.pathname==='/selection'&&req.method==='POST'){const chosen=validateSelection(JSON.parse((await body(req)).toString()));writeJson(root,`${ROOT}/provider.json`,chosen);return json(chosen)}
  if(url.pathname==='/queue'&&req.method==='POST'){const b=JSON.parse((await body(req)).toString());return json(terminals.startWorkflow({id:b.id,skill:b.skill,args:b.args||{},selection:b.selection||selection(root),execution:'headless',appScope}))}
  if(url.pathname==='/report'&&req.method==='GET')return json(readVoiceReport(root,url.searchParams.get('path')||'',list('runs'),list('voice-results')));
  if(url.pathname==='/voice/config'){
   if(req.method==='GET')return json(VOICE_MODELS);
   if(req.method==='POST')return json({error:'Voice routing is fixed: Luna for Codex, Haiku for Claude.'},405);
  }
  if(url.pathname==='/voice/health'&&req.method==='GET'){const s=await speechHealth();return json({ok:!!s?.ok&&!!s?.stt?.ok,engine:'Whisper / Kokoro',speech:s,worker:!!health(root)})}
  if(url.pathname==='/voice/cancel'&&req.method==='POST'){const b=JSON.parse((await body(req)).toString());if(!uuid(b.id))throw new Error('Invalid request ID');writeJson(root,`${ROOT}/voice-cancelled/${b.id}.json`,{ts:Date.now()});active.get(b.id)?.abort();return json({ok:true})}
  if(url.pathname==='/voice/transcript'){
   const since=readJson(root,`${ROOT}/voice-clear.json`,{ts:0}).ts;
   const records=list('voice-results').filter(r=>r.ts>since).sort((a,b)=>a.ts-b.ts).slice(-30);if(req.method==='GET')return json({path:'system/voice/transcript',content:records.map(r=>`**You (${r.provider}):** ${r.transcript}\n\n**Agent (${r.model||'direct command'}):** ${r.reply}`).join('\n\n---\n\n')||'No voice requests yet.'});
   // Transcript records double as durable duplicate protection; clear the display without deleting receipts.
   if(req.method==='DELETE'){writeJson(root,`${ROOT}/voice-clear.json`,{ts:Date.now()});return json({ok:true})}
  }
  if(url.pathname==='/voice/speak'&&['POST','GET'].includes(req.method)){
   const b=req.method==='GET'?{text:url.searchParams.get('text')}:JSON.parse((await body(req)).toString());if(typeof b.text!=='string'||!b.text.trim()||b.text.length>2000)throw new Error('Invalid speech text');
   const stop=new AbortController();res.on('close',()=>stop.abort());const out=await fetch(`${speech}/speak?text=${encodeURIComponent(speechText(spokenFlow(selectSpokenAnswer(b.text,{mode:'reply'}))))}`,{signal:AbortSignal.any([stop.signal,AbortSignal.timeout(60000)])});if(!out.ok)throw new Error('Local speech playback is unavailable');
   res.writeHead(200,{'Content-Type':'audio/wav'});for await(const chunk of out.body){if(res.destroyed)break;if(!res.write(chunk)&&!await waitForResponseDrain(res))break}if(!res.destroyed)res.end();return;
  }
  if(['/voice/audio','/voice/text'].includes(url.pathname)&&req.method==='POST'){
   const id=req.headers['x-v2-request'];if(!uuid(id))throw new Error('Invalid request ID');
   const chosen=validateSelection(JSON.parse(req.headers['x-v2-selection']||'null'));
   if(fs.existsSync(vaultPath(root,`${ROOT}/voice-cancelled/${id}.json`)))throw new Error('Voice request cancelled');
   const receipt=readJson(root,`${ROOT}/voice-results/${id}.json`,null);if(receipt){if((receipt.appScope||'web')!==appScope||receipt.provider!==chosen.provider||(receipt.requestedWorkerModel??receipt.workerModel)!==chosen.model)throw new Error('Request ID already belongs to a different selection');return voiceJson(receipt,true)}
   // Corrupt current settings must be detected before claiming, transcribing,
   // classifying or dispatching work. Durable receipts remain readable above.
   reconcileCurrent(root,terminals,{scope:appScope});
   const conversationEpoch=readConversationEpoch(root,chosen.provider,appScope);
   if(active.size)throw new Error('Another voice request is being processed. Wait or cancel it first.');
   const controller=new AbortController();active.set(id,controller);
   const disconnected=()=>{if(!res.writableEnded)controller.abort()};
   res.on('close',disconnected);if(res.destroyed)disconnected();
   // Persist intent before calling a provider; interrupted requests cannot silently replay after restart.
   const claim=`${ROOT}/voice-requests/${id}.json`;
   let claimed=false,stage='receiving',diagnostic={id,...chosen,ts:new Date().toISOString(),appScope,source:url.pathname==='/voice/audio'?'audio':'text'};
   // Keep failure evidence with the existing duplicate guard, never in successful
   // voice memory. Diagnostics must not prevent a response or mask its error.
   const recordDiagnostic=fields=>{if(claimed){diagnostic={...diagnostic,stage,...fields,updatedAt:new Date().toISOString()};try{writeJson(root,claim,diagnostic)}catch{}}};
   try{
    if(fs.existsSync(vaultPath(root,claim)))throw new Error('This voice request was already submitted. Start a new request to retry.');
    writeJson(root,claim,{...diagnostic,stage});claimed=true;
    let transcript;
    if(url.pathname==='/voice/text')transcript=JSON.parse((await body(req)).toString()).transcript;
    else{
     const audio=await body(req,8*1024*1024);if(audio.length<1000)throw new Error('Recording was too short.');
     stage='transcribing';preconnectJev();try{prepareJev({provider:chosen.provider})}catch{}
     const stt=await fetch(`${speech}/stt`,{method:'POST',headers:{'Content-Type':req.headers['content-type']||'audio/webm'},body:audio,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
     if(!stt.ok)throw new Error('Local transcription failed. Check the V2 speech service.');transcript=(await stt.json()).text;
    }
    stage='validating';if(typeof transcript==='string')diagnostic.transcript=transcript.slice(0,4000);
    if(controller.signal.aborted)throw new Error('Voice request cancelled');
    const work=JSON.parse(req.headers['x-v2-work']||'null');
    if(uuid(work?.targetId))diagnostic.workTarget=work.targetId;
    const supplied=typeof req.headers['x-v2-surface']==='string'?req.headers['x-v2-surface']:null;
    const surface=supplied?hub.live().find(item=>item.id===supplied):null;
    if(supplied&&(!surface||surface.kind!==appScope))throw new Error('Voice surface belongs to another app or is disconnected.');
    const client=supplied||hub.live().find(item=>item.id===hub.owner&&item.kind===appScope)?.id;
    const target=artifactTarget(client,chosen.provider,conversationEpoch,appScope);
    stage='routing';recordDiagnostic({});
    const result=await routeVoice(root,{id,transcript,selection:chosen,terminalMode:!!work,workTarget:work?.targetId||null,conversationEpoch,appScope,origin:req.headers['x-v2-origin']==='test'?'test':'live'},controller.signal,undefined,terminals,{updateCurrent:change=>setCurrent(root,terminals,{...change,scope:appScope}),onDispatch:(taskId,epoch)=>artifacts.bind(taskId,target?{...target,epoch}:null),
     // Reopen a registered file on the surface that asked. Bind the task to
     // this surface first: the claim path only serves the current conversation.
     reopenArtifact:({id:requestId,taskId,artifact})=>{
      if(!target)throw new Error('No connected dashboard can display that file right now.');
      const task=terminals.get(taskId);
      artifacts.bind(taskId,{...target,epoch:conversationEpoch});
      if(!artifacts.publish(task,{id:`reopen:${requestId}`,artifacts:[{...artifact,open:true,isFinal:true}]},''))throw new Error('That file was already queued to open.');
      hub.emit({type:'pending'});
     }});
    stage='responding';const response=voiceJson(result);stage='completed';recordDiagnostic({completedAt:new Date().toISOString()});return response;
   }catch(error){recordDiagnostic({error:String(error.message||error).slice(0,1000),failedAt:new Date().toISOString(),cancelled:controller.signal.aborted});throw error}
   finally{res.off('close',disconnected);active.delete(id)}
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
 const plugin=vaultPath(root,'.obsidian/plugins/agentic-os-v2');
 if(fs.existsSync(plugin))fs.copyFileSync(bridgeAuth.file,vaultPath(root,'.obsidian/plugins/agentic-os-v2/bridge-auth.json'));
 console.log(`V2 bridge :3219 · ${root} · speech ${speech}`);
 for(const [provider,info] of Object.entries(installedProviders))console.log(`${provider}: ${info.version||info.detail} · ${info.command||'unavailable'} (${info.source||'none'})`);
}
process.on('uncaughtExceptionMonitor',error=>lifecycle?.mark('uncaught-exception',{code:error.code||error.name}));
process.on('exit',code=>{if(code===0)lifecycle?.stop('process exit');else lifecycle?.mark('exit',{exitCode:code})});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{{const open=classifierProcesses();if(open.total)lifecycle?.mark('classifiers-open-at-shutdown',{reason:`running=${open.running} detached=${open.detached}`})}lifecycle?.stop(signal);closeClaudeSignIn();for(const c of active.values())c.abort();drainDetachedClassifiers({timeoutMs:12000}).then(drained=>{if(drained.remaining)console.error(`[shutdown] ${drained.remaining} classifier process(es) did not confirm closure.`)});terminals.close();clearInterval(artifactTimer);speechLink.stop();for(const response of listeners.values())response.end();server.close()});
