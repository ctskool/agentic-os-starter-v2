import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {ROOT,validateSelection} from '../shared/contract.mjs';
import {vaultPath,writeJson} from '../runner/core.mjs';
import {CONVERSATION_IDLE_MS,readCurrentState,reconcileCurrent,readConversationEpoch,setCurrent,taskInScope} from '../runner/current-conversations.mjs';
import {readJson,routeVoice} from '../runner/bridge-core.mjs';
import {ArtifactHandoff,artifactSpeech} from '../runner/artifact-handoff.mjs';
import {artifactOutcomeSpeech} from '../runner/artifact-speech.mjs';
import {VoiceHub} from '../runner/voice-hub.mjs';
import {registerArtifact,readArtifact} from '../runner/artifacts.mjs';
import {NativeTerminalManager} from '../runner/native-terminals.mjs';
import {localDate} from '../runner/brief-voice.mjs';
import {classifierProcesses as ownedClassifiers,drainDetachedClassifiers} from '../runner/jev.mjs';
import {strictRules} from '../runner/voice-strict-rules.mjs';

// Exercise the real HTTP handler body without importing the bridge's top-level
// port binding, provider warmup, speech socket, or TerminalManager lifecycle.
const source=fs.readFileSync(new URL('../runner/bridge.mjs',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const marker="server.on('request',async(req,res)=>{";
const start=source.indexOf(marker),end=source.indexOf('\n});\n{\n // Mint',start);
assert.ok(start>=0&&end>start,'Bridge request handler must remain available for isolated endpoint checks');
const createHandler=new Function('deps',`const {preconnectJev=()=>false,closeClaudeSignIn=()=>{},classifierProcesses=()=>({running:0,detached:0,total:0}),root,fs,ROOT,origins,bridgeAuth,uuid,body,terminals,readCurrentState,reconcileCurrent,readConversationEpoch,setCurrent,taskInScope,readJson,vaultPath,writeJson,validateSelection,selection,routeVoice,active,speech,fetch,taskSummary,artifacts,artifactSpeech,artifactOutcomeSpeech,hub,listeners,artifactTarget,readArtifact}=deps;return async(req,res)=>{${source.slice(start+marker.length,end)}\n};`);
const chosen={provider:'codex',model:'gpt-6-astra'};
const uuid=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);

function fixture(t,{beforeBody=async()=>{},beforeModel=async()=>{},scope='web',accepts=()=>true,speechTranscript=null,classifierProcesses,closeClaudeSignIn}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'current-voice-endpoints-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const records=new Map(),workflows=new Map(),calls=[],active=new Map();let bodyReads=0,models=0,speechCalls=0;
 const artifacts=new ArtifactHandoff(),hub=new VoiceHub(),listeners=new Map(),client=crypto.randomUUID();
 listeners.set(client,{});hub.presence({id:client,kind:scope,visible:true,mode:'idle',focus:true,claim:false});
 const artifactTarget=(id,provider,epoch,appScope)=>listeners.has(id)&&hub.live().some(item=>item.id===id&&item.kind===appScope)?{client:id,kind:appScope,provider,epoch}:null;
 const add=(provider='codex',appScope=scope)=>{const task={id:crypto.randomUUID(),provider,model:provider==='codex'?'gpt-6-astra':'sonnet',title:'Fixture '+provider,state:'ready',created:Date.now(),conversationActivityAt:Date.now(),turns:[],execution:appScope==='native'?'native':'cli'};records.set(task.id,task);return task};
 const terminals={records,live:new Map(),list:()=>[...records.values()],get(id){const task=records.get(id);if(!task)throw new Error('Task not found');return task},workflowRequest:id=>workflows.get(id)||null,
  start(options){if(records.has(options.id))return this.get(options.id);const task={...options.selection,id:options.id,title:options.title||options.prompt,prompt:options.prompt,state:'working',turns:[],execution:options.execution||'cli'};records.set(task.id,task);calls.push({kind:'start',id:task.id});return task},
  startWorkflow(options){const prior=workflows.get(options.id);if(prior){if(options.execution==='headless'&&!['headless','script'].includes(prior.record.execution))throw new Error('Task ID belongs to a different workflow or app.');return prior.record}const record=this.start({...options,prompt:'Fixture workflow'});record.appScope=options.appScope;if(['metrics-pull','github-trending'].includes(options.skill))record.execution='script';workflows.set(options.id,{record,workflow:{job:options}});return record},
  continueWorkflow(target,options){const record=this.get(target);if(workflows.has(options.id))return record;workflows.set(options.id,{record,workflow:{job:options}});calls.push({kind:'continue-workflow',id:target,request:options.id});return record},
  send(id,text){const task=this.get(id);calls.push({kind:'send',id,text});return task}
 };
 const handler=createHandler({...(classifierProcesses?{classifierProcesses}:{}),...(closeClaudeSignIn?{closeClaudeSignIn}:{}),root,fs,ROOT,origins:new Set(),bridgeAuth:{accepts},uuid,terminals,readCurrentState,reconcileCurrent,readConversationEpoch,setCurrent,taskInScope,readJson,vaultPath,writeJson,validateSelection,selection:()=>chosen,active,artifacts,artifactSpeech,artifactOutcomeSpeech,hub,listeners,artifactTarget,readArtifact,
  body:async req=>{bodyReads++;await beforeBody(req);return Buffer.isBuffer(req.payload)?req.payload:Buffer.from(JSON.stringify(req.payload))},speech:'http://fixture-speech',fetch:async(url,options)=>{assert.equal(url,'http://fixture-speech/stt');assert.equal(typeof speechTranscript,'string','Endpoint fixture must not contact speech or a model');assert.equal(options.method,'POST');speechCalls++;return {ok:true,json:async()=>({text:speechTranscript})}},taskSummary:task=>task,
  routeVoice:(root,request,signal,_execute,manager,options)=>routeVoice(root,request,signal,async(_root,job)=>{models++;await beforeModel();assert.equal(job.model,job.provider==='codex'?'gpt-5.6-luna':'haiku');return{text:'{"tier":3,"reply":"Working on the request."}'}},manager,{...options,resolveCli:()=>({command:'unused-test-cli',prefix:[]})})
 });
 const request=async(url,payload={},headers={},method='POST')=>{
  const response=Object.assign(new EventEmitter(),{headersSent:false,writableEnded:false,status:null,value:null,setHeader(){},writeHead(status,headers){this.status=status;this.headersSent=true;this.headers=headers},end(text){this.writableEnded=true;this.value=Buffer.isBuffer(text)?text:text?JSON.parse(text):null}});
  await handler({url,method,payload,headers:{host:'127.0.0.1:3219','x-v2-app':scope,...headers}},response);return response;
 };
 const voice=(transcript,{id=crypto.randomUUID(),targetId=null,selection=chosen,audio=false}={})=>request(audio?'/voice/audio':'/voice/text',audio?Buffer.alloc(2000):{transcript},{'x-v2-request':id,'x-v2-selection':JSON.stringify(selection),'x-v2-work':JSON.stringify({targetId}),'x-v2-surface':client});
 return {root,records,workflows,calls,active,terminals,add,request,voice,artifacts,hub,client,state:()=>readCurrentState(root,scope),counts:()=>({bodyReads,models}),speechCalls:()=>speechCalls,file:path.join(root,ROOT,'current-conversations.json')};
}

for(const audio of [false,true])for(const target of ['stopped','missing','other-app','other-provider'])for(const lookup of [false,true])test(`${audio?'audio':'text'} ${lookup?'saved lookup':'report opening'} bypasses ${target} native conversation ownership and lifecycle`,async t=>{
 const transcript=lookup?'What was the top AI news today?':'Can you pull up the morning Intel brief for me?';
 const f=fixture(t,{scope:'native',speechTranscript:transcript}),task=f.add(target==='other-provider'?'claude':'codex',target==='other-app'?'web':'native');
 task.state='stopped';task.pid=null;task.sessionId=crypto.randomUUID();
 if(target==='missing')f.records.delete(task.id);
 // Reproduce a remembered legacy ID without choosing or adopting it into the
 // native app. Merely reading valid current settings must not resume a task.
 const state=id=>({current:{codex:id,claude:null},revision:7,contextEpochs:{codex:3,claude:0}});
 writeJson(f.root,`${ROOT}/current-conversations.json`,{version:2,scopes:{native:state(task.id),web:state(null)}});
 const before=fs.readFileSync(f.file,'utf8'),report=`inbox/research/morning-intel/${localDate()}-intel.md`;
 fs.mkdirSync(path.dirname(path.join(f.root,report)),{recursive:true});fs.writeFileSync(path.join(f.root,report),'## Top Story\nA saved public headline.\n');
 f.terminals.get=()=>assert.fail('A local report request must not inspect the selected worker');
 f.terminals.list=()=>assert.fail('A local report request must not scan terminal state');
 const response=await f.voice(transcript,{targetId:task.id,audio});
 assert.equal(response.status,200,JSON.stringify(response.value));assert.equal(response.value.deliverable,report);
 if(lookup){assert.match(response.value.reply,/saved public headline/);assert.equal(response.value.reveal,null)}else{assert.equal(response.value.reveal,'open');assert.equal(response.value.reply,'')}
 assert.equal(response.value.engine,'rules');assert.equal(response.value.model,null);assert.equal(response.value.workerModel,null);
 const retained=target==='stopped';
 assert.equal(response.value.workTarget,retained?task.id:null);assert.equal(response.value.current.codex,retained?task.id:null);assert.equal(response.value.conversationEpoch,retained?3:4);
 assert.deepEqual(response.value.workIds,[]);assert.equal(response.value.queued,null);assert.equal(f.calls.length,0);assert.equal(f.counts().models,0);assert.equal(f.terminals.live.size,0);
 assert.equal(f.speechCalls(),audio?1:0);
 if(retained){assert.equal(f.state().revision,7);assert.ok(readJson(f.root,`${ROOT}/current-conversations.json`).scopes.native.selectionActivity.codex>=task.created)}
 else {assert.equal(f.state().codex,null);assert.equal(f.state().revision,8);assert.equal(f.records.has(task.id),target!=='missing')}
 const receipt=readJson(f.root,`${ROOT}/voice-results/${response.value.id}.json`);assert.equal(receipt.deliverable,report);assert.equal(receipt.workTarget,retained?task.id:null);
});

for(const target of ['missing','other-app','other-provider'])test(`native work still rejects a ${target} selected conversation after intent routing`,async t=>{
 const f=fixture(t,{scope:'native'}),task=f.add(target==='other-provider'?'claude':'codex',target==='other-app'?'web':'native');
 if(target==='missing')f.records.delete(task.id);
 const response=await f.voice('Create a visual explainer',{targetId:task.id});
 assert.equal(response.status,400);assert.match(response.value.error,target==='missing'?/unavailable/:target==='other-app'?/other app/:/different provider/);
 assert.equal(f.calls.length,0);assert.equal(f.counts().models,0);assert.equal(f.terminals.live.size,0);assert.equal(f.state().codex,null);
});

test('completed voice artifact binds to its originating app and announces opening only after confirmation',async t=>{
 const f=fixture(t,{scope:'native'}),response=await f.voice('Create a visual explainer');assert.equal(response.status,200);
 const taskId=response.value.workIds[0],artifact={id:'a'.repeat(64),taskId,turnId:'turn',path:'system/v2/artifacts/a.png',label:'Explainer',mime:'image/png',bytes:50,open:true};
 assert.equal(f.artifacts.targets[taskId].client,f.client);f.artifacts.publish({id:taskId},{id:'turn',artifacts:[artifact]});
 assert.equal((await f.request('/artifacts/claim',{client:f.client,visible:false,mode:'idle'})).value.action,null);
 const claim=await f.request('/artifacts/claim',{client:f.client,visible:true,mode:'idle'});assert.equal(claim.status,200);assert.equal(claim.value.action.artifact.id,artifact.id);
 assert.equal(f.hub.items.length,0);const ack=await f.request('/artifacts/ack',{id:claim.value.action.id,client:f.client,ok:true});assert.equal(ack.status,200);
 assert.match(f.hub.items[0].text,/opened the image in Obsidian/);
 await f.request('/artifacts/ack',{id:claim.value.action.id,client:f.client,ok:true});assert.equal(f.hub.items.length,1);
});

test('fresh conversation blocks an old pending reveal without erasing its saved artifact',async t=>{
 const f=fixture(t,{scope:'native'}),response=await f.voice('Create a visual explainer'),taskId=response.value.workIds[0];
 f.artifacts.publish({id:taskId},{id:'turn',artifacts:[{id:'a'.repeat(64),taskId,turnId:'turn',path:'a.png',open:true}]});
 setCurrent(f.root,f.terminals,{provider:'codex',id:null,scope:'native'});
 const claim=await f.request('/artifacts/claim',{client:f.client,visible:true,mode:'idle'});assert.equal(claim.value.action,null);assert.equal(f.artifacts.items[0].artifact.taskId,taskId);
});

test('artifact file endpoint serves the validated immutable bytes and rejects arbitrary or altered files',async t=>{
 const f=fixture(t),task=f.add(),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rD8AAAAASUVORK5CYII=','base64');
 fs.writeFileSync(path.join(f.root,'diagram.png'),png);
 const artifact=registerArtifact(f.root,{taskId:task.id,turnId:'turn',path:'diagram.png',open:true});
 const output=await f.request('/artifacts/file?id='+artifact.id,{}, {},'GET');
 assert.equal(output.status,200);assert.equal(output.headers['Content-Type'],'image/png');assert.deepEqual(output.value,png);
 for(const id of ['../../CLAUDE.md','a'.repeat(40)]){
  const denied=await f.request('/artifacts/file?id='+encodeURIComponent(id),{}, {},'GET');assert.equal(denied.status,404);assert.doesNotMatch(JSON.stringify(denied.value),/AppData|Users|ENOENT/);
 }
 fs.writeFileSync(path.join(f.root,artifact.path),Buffer.from('changed'));
 assert.equal((await f.request('/artifacts/file?id='+artifact.id,{}, {},'GET')).status,404);
});

for(const audio of [false,true])test(`corrupt current state prevents ${audio?'audio':'text'} voice claims and execution`,async t=>{
 const f=fixture(t),id=crypto.randomUUID();writeJson(f.root,`${ROOT}/current-conversations.json`,{broken:true});
 const before=fs.readFileSync(f.file,'utf8'),response=await f.voice('Research RubyGems',{id,audio});
 assert.equal(response.status,400);assert.match(response.value.error,/conversation settings are invalid/);
 assert.deepEqual(f.counts(),{bodyReads:0,models:0});assert.equal(f.calls.length,0);assert.equal(f.active.size,0);
 assert.equal(fs.existsSync(path.join(f.root,ROOT,'voice-requests',id+'.json')),false);assert.equal(fs.existsSync(path.join(f.root,ROOT,'voice-results',id+'.json')),false);assert.equal(fs.readFileSync(f.file,'utf8'),before);
});

test('successful voice response publishes current state without storing it in the durable receipt',async t=>{
 const f=fixture(t),claude=f.add('claude');setCurrent(f.root,f.terminals,{provider:'claude',id:claude.id});
 const response=await f.voice('Research RubyGems');assert.equal(response.status,200);assert.equal(f.calls.length,1);
 assert.deepEqual(response.value.current,{codex:response.value.workIds[0],claude:claude.id});assert.equal(response.value.currentRevision,f.state().revision);
 const saved=readJson(f.root,`${ROOT}/voice-results/${response.value.id}.json`);assert.equal(saved.current,undefined);assert.equal(saved.currentRevision,undefined);
});

test('duplicate voice response uses the latest current map without dispatch or resetting a later selection',async t=>{
 const f=fixture(t),id=crypto.randomUUID(),first=await f.voice('Research RubyGems',{id});assert.equal(first.status,200);
 const next=f.add();await f.request('/work/current',{provider:'codex',id:next.id});const before=f.state(),counts=f.counts();
 const replay=await f.voice('Research RubyGems',{id});assert.equal(replay.status,200);assert.deepEqual(replay.value.workIds,first.value.workIds);assert.equal(replay.value.current.codex,next.id);assert.equal(replay.value.currentRevision,before.revision);
 assert.deepEqual(f.state(),before);assert.deepEqual(f.counts(),counts);assert.equal(f.calls.length,1);
 fs.writeFileSync(f.file,'{broken');const offline=await f.voice('Research RubyGems',{id});assert.equal(offline.status,200);assert.deepEqual(offline.value.workIds,first.value.workIds);assert.equal(offline.value.current,undefined);assert.equal(f.calls.length,1);
});

test('standalone new-task response clears only its provider and returns that current map immediately',async t=>{
 const f=fixture(t),codex=f.add(),claude=f.add('claude');for(const task of [codex,claude])setCurrent(f.root,f.terminals,{provider:task.provider,id:task.id});
 const response=await f.voice('Start a new task',{targetId:codex.id});assert.equal(response.status,200);assert.equal(response.value.currentReset,true);assert.deepEqual(response.value.current,{codex:null,claude:claude.id});assert.equal(response.value.currentRevision,3);assert.equal(f.calls.length,0);assert.equal(f.counts().models,0);
});

test('a replayed reset failure stays an error without dispatching or claiming a fresh conversation',async t=>{
 const f=fixture(t),id=crypto.randomUUID(),task=f.add();setCurrent(f.root,f.terminals,{provider:'codex',id:task.id});const before=f.state();
 writeJson(f.root,`${ROOT}/voice-results/${id}.json`,{id,provider:'codex',requestedWorkerModel:chosen.model,currentReset:true,conversationResetError:"I couldn't start a fresh conversation. Try New conversation again."});
 const response=await f.voice('Start a new conversation',{id});assert.equal(response.status,400);assert.match(response.value.error,/couldn't start a fresh conversation/);assert.deepEqual(f.state(),before);assert.equal(f.calls.length,0);assert.equal(f.counts().models,0);
});

test('a new conversation chosen while voice upload is pending cannot be undone by that older request',async t=>{
 let entered,release;const started=new Promise(resolve=>entered=resolve),wait=new Promise(resolve=>release=resolve);
 const f=fixture(t,{beforeBody:async req=>{if(req.url==='/voice/text'){entered();await wait}}}),task=f.add();setCurrent(f.root,f.terminals,{provider:'codex',id:task.id});
 const pending=f.voice('Research RubyGems',{targetId:task.id});await started;await f.request('/work/current',{provider:'codex',id:null});const fresh=f.state();release();const response=await pending;
 assert.equal(response.status,200);assert.equal(f.calls.length,1);assert.equal(f.calls[0].id,task.id);assert.deepEqual(f.state(),fresh);assert.equal(response.value.current.codex,null);assert.equal(response.value.conversationEpoch,0);assert.equal(response.value.conversationSuperseded,true);assert.equal(readConversationEpoch(f.root,'codex'),1);
});

for(const scope of ['web','native'])for(const provider of ['codex','claude'])test(`${scope} ${provider} expiry during transcription selects fresh work without reviving the captured task`,async t=>{
 let entered,release;const started=new Promise(resolve=>entered=resolve),wait=new Promise(resolve=>release=resolve);
 const f=fixture(t,{scope,speechTranscript:'Create a visual explainer about solar power',beforeBody:async req=>{if(req.url==='/voice/audio'){entered();await wait}}});
 const task=f.add(provider),selected={provider,model:provider==='codex'?'gpt-6-astra':'sonnet'};
 setCurrent(f.root,f.terminals,{provider,id:task.id,scope});
 const pending=f.voice('ignored audio',{audio:true,targetId:task.id,selection:selected});await started;
 const expired=Date.now()-CONVERSATION_IDLE_MS-1;task.created=expired;task.conversationActivityAt=expired;
 // Simulate the dashboard's ordinary refresh crossing the idle boundary while
 // the submitted audio is still transcribing, without waiting thirty minutes.
 const settings=readJson(f.root,`${ROOT}/current-conversations.json`);settings.scopes[scope].selectionActivity[provider]=expired;
 writeJson(f.root,`${ROOT}/current-conversations.json`,settings);
 assert.equal((await f.request('/work',{}, {},'GET')).status,200);assert.equal(f.state()[provider],null);release();
 const response=await pending;assert.equal(response.status,200,JSON.stringify(response.value));
 assert.notEqual(response.value.conversationSuperseded,true);assert.equal(response.value.conversationEpoch,1);
 assert.equal(response.value.workIds.length,1);assert.notEqual(response.value.workIds[0],task.id);
 assert.equal(f.state()[provider],response.value.workIds[0]);assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'start');
 assert.equal(f.artifacts.targets[response.value.workIds[0]].epoch,1);assert.equal(f.records.get(task.id).state,'ready');
 assert.equal(f.counts().models,0);
});

for(const scope of ['web','native'])test(`${scope} app initialization resets idle selection once and preserves active work and history`,async t=>{
 const f=fixture(t,{scope}),idle=f.add(),active=f.add('claude'),sessionId=crypto.randomUUID();active.state='working';
 for(const task of [idle,active])setCurrent(f.root,f.terminals,{provider:task.provider,id:task.id,scope});
 const response=await f.request('/work/session',{sessionId});assert.equal(response.status,200);
 assert.equal(response.value.codex,null);assert.equal(response.value.claude,active.id);assert.equal(f.records.size,2);assert.equal(f.calls.length,0);
 await f.request('/work/current',{provider:'codex',id:idle.id});const selected=f.state();
 const replay=await f.request('/work/session',{sessionId});assert.equal(replay.status,200);assert.deepEqual(f.state(),selected);
 assert.equal((await f.request('/work/session',{sessionId:'invalid'})).status,400);assert.deepEqual(f.state(),selected);
});

test('app initialization requires authentication and an allowed origin before clearing any selection',async t=>{
 const f=fixture(t,{accepts:(_method,headers)=>headers['x-v2-token']==='fixture-token'}),task=f.add();
 setCurrent(f.root,f.terminals,{provider:'codex',id:task.id});const before=f.state(),sessionId=crypto.randomUUID();
 assert.equal((await f.request('/work/session',{sessionId})).status,401);
 assert.equal((await f.request('/work/session',{sessionId},{'x-v2-token':'fixture-token',origin:'https://hostile.example'})).status,403);
 assert.deepEqual(f.state(),before);assert.equal(f.counts().bodyReads,0);
});

test('additional web app sessions adopt both providers without changing existing context boundaries',async t=>{
 const f=fixture(t),codex=f.add(),claude=f.add('claude');
 for(const task of [codex,claude])setCurrent(f.root,f.terminals,{provider:task.provider,id:task.id});
 const before=f.state(),epochs=['codex','claude'].map(provider=>readConversationEpoch(f.root,provider));
 for(let page=0;page<3;page++){
  const response=await f.request('/work/session',{sessionId:crypto.randomUUID(),mode:'adopt'});assert.equal(response.status,200);assert.deepEqual(response.value,before);
  assert.deepEqual(['codex','claude'].map(provider=>readConversationEpoch(f.root,provider)),epochs);
 }
 assert.equal(f.calls.length,0);assert.equal(f.counts().models,0);
});

test('native app sessions reject web adoption before changing their current conversation',async t=>{
 const f=fixture(t,{scope:'native'}),task=f.add();setCurrent(f.root,f.terminals,{scope:'native',provider:'codex',id:task.id});
 const before=f.state(),epoch=readConversationEpoch(f.root,'codex','native');
 for(const mode of ['adopt','invalid']){const response=await f.request('/work/session',{sessionId:crypto.randomUUID(),mode});assert.equal(response.status,400);assert.match(response.value.error,/session mode/)}
 assert.deepEqual(f.state(),before);assert.equal(readConversationEpoch(f.root,'codex','native'),epoch);
});

for(const scope of ['web','native'])for(const provider of ['codex','claude'])test(`${scope} ${provider} accepted speech protects its selection while the classifier is pending`,async t=>{
 const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
 let task;const f=fixture(t,{scope,beforeModel:async()=>{
  t.mock.timers.tick(1000);
  const poll=await f.request('/work',{}, {},'GET');assert.equal(poll.status,200);
  assert.equal(f.state()[provider],task.id,'real interaction refreshes activity before a slow model can cross the old idle boundary');
 }});
 task=f.add(provider);task.created=now-CONVERSATION_IDLE_MS+10;task.conversationActivityAt=task.created;
 setCurrent(f.root,f.terminals,{provider,id:task.id,scope,now:task.created});
 const response=await f.voice('Why did you choose that approach?',{targetId:task.id,selection:{provider,model:provider==='codex'?'gpt-6-astra':'sonnet'}});
 assert.equal(response.status,200,JSON.stringify(response.value));assert.equal(f.counts().models,1);
 assert.deepEqual(response.value.workIds,[task.id]);assert.notEqual(response.value.conversationSuperseded,true);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'send');assert.equal(readConversationEpoch(f.root,provider,scope),0);
});

test('replaying a completed response after a fresh start marks it superseded without deleting its work',async t=>{
 const f=fixture(t),id=crypto.randomUUID(),first=await f.voice('Research RubyGems',{id});assert.equal(first.status,200);assert.equal(first.value.conversationSuperseded,undefined);
 await f.request('/work/current',{provider:'codex',id:null});const replay=await f.voice('Research RubyGems',{id});assert.equal(replay.status,200);assert.equal(replay.value.conversationSuperseded,true);assert.deepEqual(replay.value.workIds,first.value.workIds);assert.equal(replay.value.current.codex,null);assert.equal(f.calls.length,1);
});

test('manual-start retries cannot retarget a newer current conversation',async t=>{
 const f=fixture(t),id=crypto.randomUUID(),payload={id,prompt:'Fixture request',selection:chosen};
 const first=await f.request('/work/start',payload);assert.equal(first.status,200);const next=f.add();setCurrent(f.root,f.terminals,{provider:'codex',id:next.id});const before=f.state();
 const replay=await f.request('/work/start',payload);assert.equal(replay.status,200);assert.equal(replay.value.id,id);assert.deepEqual(f.state(),before);assert.equal(f.calls.length,1);
});

for(const endpoint of ['/work/skill','/queue'])test(`${endpoint} rejects a terminal continuation identity without retargeting it as a button job`,async t=>{
 const f=fixture(t),original=f.add(),id=crypto.randomUUID();setCurrent(f.root,f.terminals,{provider:'codex',id:original.id});
 const first=await f.voice('Run the weekly review',{id,targetId:original.id});assert.equal(first.status,200);assert.equal(f.records.has(id),false);assert.ok(f.workflows.has(id));assert.equal(f.calls[0].kind,'continue-workflow');
 const next=f.add();setCurrent(f.root,f.terminals,{provider:'codex',id:next.id});const before=f.state();
 const replay=await f.request(endpoint,{id,skill:'weekly-review',args:{},selection:chosen});assert.equal(replay.status,400);assert.match(replay.value.error,/different workflow or app/);assert.deepEqual(f.state(),before);assert.equal(f.calls.length,1);
});

for(const endpoint of ['/work/skill','/queue'])for(const scope of ['web','native'])for(const selection of [chosen,{provider:'claude',model:'sonnet'}])test(`${endpoint} ${scope} ${selection.provider} button bypasses voice routing and preserves its current conversation`,async t=>{
 const f=fixture(t,{scope}),current=f.add(selection.provider);setCurrent(f.root,f.terminals,{provider:selection.provider,id:current.id,scope});const before=f.state();
 let executeCalls=0;
 const manager=new NativeTerminalManager(f.root,{directory:path.join(f.root,'headless-tasks'),spawn:()=>assert.fail('Button must never open a PTY'),resolveNativeCli:()=>assert.fail('Button must never open a native terminal'),execute:async()=>{executeCalls++;return {status:'ok',text:'# Weekly report\nVerified fixture output'}}});
 f.terminals.startWorkflow=options=>{const task=manager.startWorkflow(options);f.records.set(task.id,task);return task};
 try{
  const id=crypto.randomUUID(),response=await f.request(endpoint,{id,skill:'weekly-review',selection});assert.equal(response.status,200);assert.equal(response.value.execution,'headless');assert.equal(response.value.appScope,scope);
  await manager.live.get(id).done;assert.equal(executeCalls,1);assert.equal(f.counts().models,0);assert.deepEqual(f.state(),before);assert.equal(f.hub.items.length,0);
  assert.equal((await f.request(endpoint,{id,skill:'weekly-review',selection})).status,200);assert.equal(executeCalls,1);
  const selected=await f.request('/work/current',{provider:selection.provider,id});assert.equal(selected.status,400);assert.match(selected.value.error,/not a voice conversation/);assert.deepEqual(f.state(),before);
 }finally{manager.close()}
});

test('foreign-provider current changes and receipt replays cannot affect either provider map',async t=>{
 const f=fixture(t),codex=f.add(),claude=f.add('claude');for(const task of [codex,claude])setCurrent(f.root,f.terminals,{provider:task.provider,id:task.id});
 const id=crypto.randomUUID(),first=await f.voice('Research RubyGems',{id,targetId:codex.id});assert.equal(first.status,200);const before=f.state();
 const selected=await f.request('/work/current',{provider:'codex',id:claude.id});assert.equal(selected.status,400);
 const replay=await f.voice('Research RubyGems',{id,selection:{provider:'claude',model:'sonnet'}});assert.equal(replay.status,400);assert.match(replay.value.error,/different selection/);assert.deepEqual(f.state(),before);assert.equal(f.calls.length,1);
});

test('native dispatch and web dispatch keep separate terminal owners and current maps',async t=>{
 const f=fixture(t,{scope:'native'}),native=await f.voice('Create a visual explainer');
 assert.equal(native.status,200);const nativeId=native.value.workIds[0];assert.equal(f.terminals.get(nativeId).execution,'native');
 const webId=crypto.randomUUID(),web=await f.request('/work/start',{id:webId,prompt:'A separate browser task',selection:chosen},{'x-v2-app':'web'});
 assert.equal(web.status,200);assert.equal(web.value.execution,'cli');
 assert.equal(readCurrentState(f.root,'native').codex,nativeId);assert.equal(readCurrentState(f.root,'web').codex,webId);
 const nativeList=await f.request('/work?summary=1',{}, {},'GET'),webList=await f.request('/work?summary=1',{}, {'x-v2-app':'web'},'GET');
 assert.deepEqual(nativeList.value.tasks.map(task=>task.id),[nativeId]);assert.deepEqual(webList.value.tasks.map(task=>task.id),[webId]);
 for(const endpoint of ['/work/send','/work/stop','/work/resume','/work/start','/work/skill']){
  const result=await f.request(endpoint,{id:webId,text:'Do not dispatch this',prompt:'A separate browser task',selection:chosen,skill:'weekly-review'});
  assert.equal(result.status,400,endpoint);assert.match(result.value.error,/other app/);
 }
 assert.equal(f.calls.length,2);
});

test('native control commands require native identity and authenticated reads',async t=>{
 const f=fixture(t,{accepts:(method,headers)=>method==='GET'||headers['x-v2-token']==='fixture-token'}),calls=[];
 f.terminals.pendingNative=()=>{calls.push('pending');return {actions:[]}};
 f.terminals.claimNative=id=>{calls.push(id);return {action:{id}}};
 assert.equal((await f.request('/native/pending',{}, {},'GET')).status,403);
 assert.equal((await f.request('/native/pending',{}, {'x-v2-app':'native'},'GET')).status,401);
 const headers={'x-v2-app':'native','x-v2-token':'fixture-token'},id=crypto.randomUUID();
 assert.equal((await f.request('/native/pending',{},headers,'GET')).status,200);
 assert.equal((await f.request('/native/claim',{id},headers)).value.action.id,id);
 assert.deepEqual(calls,['pending',id]);
});

test('an originating voice surface cannot be claimed by the other app',async t=>{
 const f=fixture(t,{scope:'native'});
 const result=await f.request('/voice/text',{transcript:'Create a visual explainer'},{'x-v2-app':'web','x-v2-request':crypto.randomUUID(),'x-v2-selection':JSON.stringify(chosen),'x-v2-work':JSON.stringify({targetId:null}),'x-v2-surface':f.client});
 assert.equal(result.status,400);assert.match(result.value.error,/another app/);assert.equal(f.calls.length,0);
 const presence=await f.request('/voice/surface',{id:f.client,kind:'native',visible:true,mode:'idle'},{'x-v2-app':'web'});
 assert.equal(presence.status,400);assert.equal(f.hub.live().find(item=>item.id===f.client).kind,'native');
});

test('idle shutdown is refused while a would-be strict-rules check is owned: waiting for the answer, queued, or running',async t=>{
 const f=fixture(t,{classifierProcesses:ownedClassifiers});
 let runQueued,finishCheck;
 const refused=async window=>{const response=await f.request('/shutdown');assert.equal(response.status,409,window);assert.match(response.value.error,/voice requests first/)};
 const strict=strictRules({root:f.root,id:crypto.randomUUID(),config:{open:'shadow',ui:'shadow'},log:()=>{},defer:callback=>{runQueued=callback},evaluate:()=>new Promise(resolve=>{finishCheck=()=>resolve({kind:'open',stage:'resolver',reason:'no-match'})})});
 assert.equal(await strict.atBoundary({transcript:'Pop open the plan',validateText:()=>null}),null);
 assert.equal(f.active.size,0);
 await refused('waiting for the answer');
 // The caller has its answer; the check is queued for a later turn of the event loop.
 strict.returned();for(let i=0;i<50&&!runQueued;i++)await new Promise(resolve=>setTimeout(resolve,2));
 await refused('check queued');
 runQueued();for(let i=0;i<50&&!finishCheck;i++)await new Promise(resolve=>setTimeout(resolve,2));
 await refused('check running');
 finishCheck();for(let i=0;i<50&&ownedClassifiers().total;i++)await new Promise(resolve=>setTimeout(resolve,2));
 assert.equal(ownedClassifiers().total,0);assert.deepEqual(await drainDetachedClassifiers({timeoutMs:50}),{drained:0,remaining:0});
});

test('a refused idle shutdown does not close Claude sign-in renewals; a later renewal still starts',async t=>{
 let closedCalls=0;const f=fixture(t,{classifierProcesses:()=>({running:0,detached:0,checks:1,total:1}),closeClaudeSignIn:()=>{closedCalls++}});
 const response=await f.request('/shutdown');assert.equal(response.status,409);assert.equal(closedCalls,0,'the latch is only set once shutdown is really under way');
 const signin=await import('../runner/claude-signin.mjs?refused-shutdown='+crypto.randomUUID());let launches=0;
 const child=Object.assign(new EventEmitter(),{pid:77,exitCode:null,signalCode:null,stdin:{on(){},end(){}},stdout:{resume(){}},stderr:{resume(){}}});
 const flight=signin.renewClaudeSignIn({identity:'after-refusal',launch:()=>{launches++;return child},find:()=>({command:'unused-test-cli',prefix:[]}),track:()=>{},draining:()=>false});
 assert.equal(launches,1);child.exitCode=0;child.emit('close',0);assert.deepEqual(await flight,{ok:false});
});
