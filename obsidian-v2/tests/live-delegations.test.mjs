import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {setTimeout as wait} from 'node:timers/promises';
import {createLiveBridge} from '../runner/live/routes.mjs';
import {LiveTurns} from '../runner/live/turns.mjs';
import {livePromised} from '../runner/live/calls.mjs';
import {LiveAnswers} from '../runner/live/answers.mjs';
import {liveHistory} from '../runner/live/snapshot.mjs';
import {VoiceHub} from '../runner/voice-hub.mjs';
import {handleVoiceRequest,handleVoiceHttp,voiceRequestId as uuid} from '../runner/voice-request.mjs';
import {readJson,routeVoice} from '../runner/bridge-core.mjs';
import {readConversationEpoch,readCurrentState,setCurrent} from '../runner/current-conversations.mjs';
import {voiceMemory} from '../runner/voice-router.mjs';
import {readVoiceReport} from '../runner/voice-documents.mjs';
import {liveSpeechMode,speechBusy,speechRestarted,speechUpdate} from '../runner/live/speech-mode.mjs';
import {writeJson} from '../runner/core.mjs';
import {ROOT} from '../shared/contract.mjs';
import {manualClock} from './live-test-clock.mjs';

const chosen={provider:'claude',model:'sonnet'};
const readReportPath='notes/live-only.md';
const deferred=()=>{let resolve;const promise=new Promise(fn=>{resolve=fn});return {promise,resolve}};
const flush=()=>new Promise(setImmediate);
const plans=f=>f.requests.filter(item=>item.options?.phase==='plan').length;
async function until(check){
 for(let attempt=0;attempt<250;attempt++){const value=check();if(value)return value;await wait(3)}
 assert.fail('Timed out in the Live bridge fixture');
}
async function fixture(t,{mode='voice',context=true,speechMode,route,hasSkill,modelReply={tier:2,reply:'The saved reading is available.'}}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'live-delegations-')));
 const clock=manualClock(),hubTime=clock.now();
 const active=new Map(),listeners=new Map(),frames=[],creates=[],requests=[],work=[],prompts=[],broadcasts=[],tasks=new Map();
 const prefs={voiceMode:'live',liveConfirm:mode,liveIdleHangupMin:30,liveCarryToday:false,liveGreeting:false};
 let snapshot='Today (fixture)\n- First plan',offset=0,seq=0,upstream;
 const transport={
  async create(_key,body){creates.push(body);return {id:'session-'+creates.length,answerSdp:'fixture answer'}},
  async attach(_key,id,{onEvent}){upstream=onEvent;return {send(event){
   frames.push(event);
   if(event.type==='session.close')queueMicrotask(()=>onEvent({type:'session.closed',event_id:'closed-'+id,usage:{seconds:1}}));
  },close(){}}}
 };
 const terminals={live:new Map(),get:id=>tasks.get(id),list:()=>[...tasks.values()],
  start:job=>{work.push(['start',job]);tasks.set(job.id,{id:job.id,...job.selection,execution:'cli',state:'working',title:job.title,created:Date.now(),turns:[]});return {id:job.id}},
  startWorkflow:job=>{work.push(['workflow',job]);tasks.set(job.id,{id:job.id,...job.selection,execution:'cli',state:'working',title:job.skill,created:Date.now(),turns:[]});return {id:job.id}},
  continueWorkflow:(id,job)=>{work.push(['workflow',job]);return {id}},
  stop:id=>{work.push(['stop',id]);tasks.get(id).state='stopped'},
  send:(id,prompt)=>work.push(['send',id,prompt]),
  sendWhenFree:(id,prompt)=>work.push([['starting','working'].includes(tasks.get(id)?.state)?'queue':'send',id,prompt])
 };
 const saved=()=>{const current=readCurrentState(root);return {selection:chosen,workTarget:current.claude,conversationEpoch:readConversationEpoch(root,'claude'),appScope:'web',revision:current.revision}};
 const hub=new VoiceHub({now:()=>hubTime,canSpeak:()=>prefs.voiceMode!=='live',emit:e=>broadcasts.push(e),onPublish:item=>bridge.calls.completion(item)});
 const ctx={root,active,hub,terminals,routeOptions:{resolveCli:()=>true,...(hasSkill?{hasSkill}:{}),jev:{mode:'off'}},
  route:route??((root,request,signal,_execute,terminals,options)=>routeVoice(root,request,signal,
   async(_vault,_job,prompt)=>{prompts.push(prompt);return {text:JSON.stringify(modelReply)}},terminals,options))};
 const bridge=createLiveBridge({root,runtimeDir:root,hub,listeners,active,prefs:()=>prefs,provider:()=>chosen.provider,readContext:saved,
  readEpoch:()=>saved().conversationEpoch,requestContext:()=>ctx,
  delegationHandle:(...args)=>{requests.push({request:args[1],options:args[2]});return handleVoiceRequest(...args)},
  authorization:()=>({ready:true}),key:()=> 'fixture',transport,snapshot:async()=>snapshot,speechMode,now:clock.now,limits:{snapshotRefresh:0},
  delegationTiming:{schedule:clock.schedule,sleep:clock.sleep}});
 t.after(async()=>{await bridge.calls.shutdown();fs.rmSync(root,{recursive:true,force:true})});
 const lease=bridge.surfaces.register('web');bridge.surfaces.connect(lease.surfaceId,'web',lease.surfaceSecret);listeners.set(lease.surfaceId,{end(){}});
 hub.presence({id:lease.surfaceId,kind:'web',visible:true,mode:'live',focus:true});
 const post=async(route,payload,headers={})=>{
  const url=new URL(route,'http://fixture.invalid'),res=new EventEmitter();
  return bridge.handle({url,req:{method:payload===undefined?'GET':'POST',headers:{'x-v2-app':'web','x-v2-surface':lease.surfaceId,'x-v2-call':answer?.callSecret,...headers}},
   res,appScope:'web',body:async()=>Buffer.from(JSON.stringify(payload)),json:(value,status=200)=>({value,status}),acceptsToken:()=>true,uuid});
 };
 let answer;
 const start=async()=>{
  answer=await bridge.calls.start({ownerSurface:lease.surfaceId,appScope:'web',sdp:'fixture offer'});
  emit('session.resumed');
  if(context)await post('/voice/live/context',{...saved(),peerConnected:true});
  return answer;
 };
 const emit=(type,fields={})=>upstream({type,event_id:'event-'+(++seq),...fields});
 const input=(text,opts={})=>{offset+=20;emit('session.input_transcript.delta',{offset_ms:offset,delta:text,...opts});return offset};
 const delegate=(id='turn-'+(++seq),at=offset)=>{emit('session.delegation.created',{delegation:{id,offset_ms:at}});return id};
 const turn=(text,id)=>{
  input(text,{turn_id:'user-'+(seq+1)});const result=delegate(id);clock.advance(200);return result;
 };
 const appends=()=>frames.filter(frame=>frame.type.endsWith('.append'));
 const say=(fragment,id)=>until(()=>appends().find(event=>event.content.includes(fragment)&&(!id||event.delegation_id===id)));
 const idle=()=>until(()=>!bridge.calls.call?.routing&&active.size===0);
 const stage=async text=>{turn(text);return until(()=>bridge.calls.call?.staged)};
 const typed=async transcript=>{
  const id=randomUUID(),res=new EventEmitter(),req={headers:{'x-v2-request':id,'x-v2-selection':JSON.stringify(chosen),'x-v2-work':JSON.stringify({targetId:saved().workTarget}),'x-v2-surface':lease.surfaceId}};
  const result=await handleVoiceHttp(ctx,req,res,{body:async()=>Buffer.from(JSON.stringify({transcript})),json:value=>value,appScope:'web',source:'text'});
  return {id,result,receipt:readJson(root,`${ROOT}/voice-results/${id}.json`,null)};
 };
 return {root,post,start,emit,input,delegate,turn,stage,idle,appends,say,requests,work,prompts,creates,frames,broadcasts,prefs,active,bridge,hub,lease,tasks,saved,typed,
  now:clock.now,advance:clock.advance,setSnapshot:value=>{snapshot=value},get call(){return bridge.calls.call}};
}
function assertAppends(events){
 assert.equal(new Set(events.map(e=>e.event_id)).size,events.length);
 for(const e of events){
  assert.match(e.event_id,/^evt_[0-9a-f]{32}$/);assert.equal(typeof e.content,'string');assert.equal('text' in e,false);assert.equal('client_event_id' in e,false);assert.ok(Buffer.byteLength(e.content)<=500);
  assert.ok(['session.commentary.append','session.thinking.append'].includes(e.type));
  assert.ok(e.delegation_id===null||typeof e.delegation_id==='string');
 }
}

test('turn assembly uses offsets, includes delayed fragments before the anchor, and keeps 90 seconds',()=>{
 const turns=new LiveTurns(0);
 const add=(offset,text,at=offset,type='session.input_transcript.delta')=>turns.add({type,offset_ms:offset,delta:text},at);
 add(0,'Pruned');add(96000,'Earlier question');add(97000,'Earlier answer',97000,'session.output_transcript.delta');
 add(100030,'Show my');add(100070,'A different request');add(100040,' schedule',100080);
 const first=turns.take(100045,100090);
 assert.equal(first.text,'Show my schedule');assert.equal(first.lastAt,100080);
 assert.deepEqual(first.preceding,[{role:'user',text:'Earlier question'},{role:'assistant',text:'Earlier answer'}]);
 assert.equal(turns.take(100075,100095).text,'A different request');
});

test('delegations register before settling, route anchored text once, and refuse missing or stale context',async t=>{
 const f=await fixture(t,{context:false});await f.start();
 let id=f.turn('Open the dashboard');await f.say('Say that again',id);await f.idle();assert.equal(f.requests.length,0);
 await f.post('/voice/live/context',{...f.saved(),conversationEpoch:4});
 id=f.turn('Open the dashboard');await f.say('Say that again',id);await f.idle();assert.equal(f.requests.length,0);
 await f.post('/voice/live/context',f.saved());
 const anchor=f.input('Open the', {offset_ms:100,turn_id:'first'});
 f.delegate('anchored',140);
 const requestId=f.bridge.calls.recovery.delegations.get(JSON.stringify([f.call.sessionId,'anchored']));
 assert.ok(uuid(requestId));assert.equal(f.requests.length,0);
 f.emit('session.input_transcript.delta',{offset_ms:130,delta:' dashboard',turn_id:'first'});
 f.emit('session.input_transcript.delta',{offset_ms:160,delta:'future words',turn_id:'next'});
 f.delegate('anchored',anchor);
 f.advance(199);assert.equal(f.requests.length,0);f.advance(1);
 await until(()=>f.requests.length);await f.idle();
 assert.equal(f.requests[0].request.id,requestId);assert.equal(f.requests[0].request.transcript,'Open the dashboard');
 assert.equal(f.requests[0].options.phase,'plan');assert.equal(f.requests[0].options.transport,'live');
 assert.equal(f.requests.length,1);assert.equal(f.active.size,0);
});

test('read payloads split, stay owner-only, and defer spoken results until resume',async t=>{
 const spoken='Read this useful fact. '.repeat(36).trim(),written=spoken+' Excerpt from the saved report.';
 const f=await fixture(t,{route:async()=>({kind:'read',reply:written,spokenReply:spoken,panels:['documents'],deliverable:readReportPath,workIds:[]})});
 fs.mkdirSync(path.join(f.root,'notes'));fs.writeFileSync(path.join(f.root,readReportPath),'owner report');
 await f.start();f.emit('session.paused');const id=f.turn('Read the private report');await f.idle();
 assert.equal(f.appends().some(e=>e.type==='session.commentary.append'),false);
 await f.say('Excerpt from the saved report',id);
 assert.equal((await f.post('/voice/live/updates?cursor=0',undefined,{'x-v2-call':'wrong'})).status,403);
 const events=(await f.post('/voice/live/updates?cursor=0')).value.events;
 assert.deepEqual(events.find(e=>e.type==='effect').reply.panels,['documents']);
 assert.equal(f.broadcasts.some(e=>e.type==='effect'),false);
 const report='/voice/live/report?path='+encodeURIComponent(readReportPath);
 assert.equal((await f.post(report)).value.content,'owner report');
 assert.equal((await f.post(report,undefined,{'x-v2-surface':'wrong'})).status,403);
 assert.equal((await f.post('/voice/live/report?path=notes/untold.md')).status,404);
 f.emit('session.resumed');await f.say('Read this useful fact.',id);
 assert.equal(f.appends().filter(e=>e.delegation_id===id).length,2);
 f.emit('session.paused');const dropped=f.turn('Another read');await f.idle();
 const call=f.call;await f.bridge.calls.invalidate('Ended for the test.');
 assert.equal(call.answers.held.length,0);
 assert.ok(!f.appends().some(e=>e.delegation_id===dropped&&e.type==='session.commentary.append'));
 assertAppends(f.appends());
});

test('voice affirmation waits for its undo window, commits once, and never accepts a bare yes alone',async t=>{
 const f=await fixture(t);await f.start();
 let id=f.turn('Yes');await f.say("Tell me what you'd like me to do.",id);await f.idle();
 const staged=await f.stage('Run morning intel');assert.equal(staged.mode,'voice');
 assert.match((await f.say('Say yes to go ahead.')).content,/^Just to check/);assert.equal(f.work.length,0);
 const affirmedAt=f.now();
 id=f.turn('Yes please');await f.say('Starting ');assert.equal(f.work.length,0);
 await f.idle();
 assert.equal(f.call.staged.undoUntil,affirmedAt+1500);
 f.advance(affirmedAt+1499-f.now());assert.equal(f.work.length,0);
 f.advance(1);
 await until(()=>f.work.length===1);await f.idle();
 assert.equal(f.work[0][0],'workflow');assert.equal(f.requests.filter(req=>req.options.phase==='commit').length,1);
 assert.equal((await f.post('/voice/live/confirm',{actionId:staged.actionId})).status,409);
 await f.post('/voice/live/context',f.saved());
 id=f.turn('Yes');await f.say("Tell me what you'd like me to do.",id);assert.equal(f.work.length,1);
 assertAppends(f.appends());
});

test('auto announces and stages a cancel-only action, then commits once at 2500 ms',async t=>{
 const f=await fixture(t,{mode:'auto'});await f.start();
 const stage=await f.stage('Run morning intel');await f.idle();
 assert.match((await f.say('Starting ')).content,/^Starting .+…$/);
 const update=f.call.updates.events.find(event=>event.type==='staged');
 assert.equal(update.mode,'auto');assert.equal(update.actionId,stage.actionId);
 assert.equal(update.expiresAt,f.now()+2500);
 assert.equal((await f.post('/voice/live/confirm',{actionId:stage.actionId})).status,409);
 f.emit('session.input_transcript.delta',{offset_ms:stage.anchor,delta:' delayed fragment'});
 f.emit('session.input_transcript.delta',{offset_ms:stage.anchor+1,delta:' '});
 f.advance(2499);assert.equal(f.work.length,0);f.advance(1);await f.idle();
 assert.equal(f.work.length,1);assert.equal(f.work[0][0],'workflow');assert.equal(f.call.staged,null);
 assert.deepEqual(f.requests.map(r=>r.options.phase),['plan','commit']);
});

for(const mode of ['auto','voice']){
 async function arm(f){
  const stage=await f.stage('Run morning intel');await f.idle();
  if(mode==='voice'){const id=f.turn('Yes');await f.say('Starting ');await f.idle()}
  return stage;
 }
 test(`${mode} keeps the action armed during thanks and routes an independent inbox request`,async t=>{
  const f=await fixture(t,{mode});await f.start();
  const stage=await arm(f);
  const thanks=f.input('great thanks',{turn_id:'thanks'});
  f.emit('session.output_transcript.delta',{offset_ms:thanks+1,delta:'You can say stop.'});
  f.input('I found my notebook',{turn_id:'notebook'});
  assert.equal(f.call.staged,stage);
  const request='and also check my inbox',id=f.turn(request);
  await f.idle();assert.ok(f.appends().some(event=>event.delegation_id===id));
  assert.equal(f.call.staged,stage);assert.equal(f.work.length,0);
  f.advance(stage.undoUntil-f.now());await f.idle();
  assert.deepEqual(f.requests.map(r=>[r.options.phase,r.request.transcript]),[
   ['plan','Run morning intel'],['plan',request],['commit','Run morning intel']]);
  assert.equal(f.work.length,1);
 });
 test(`${mode} catches standalone, trailing and split cancellations at the end of the window`,async t=>{
  const f=await fixture(t,{mode});await f.start();
  const phrases=[['wait'],['stop'],['okay wait'],['no stop'],['hang on, cancel that'],['ca','ncel']];
  for(const deltas of phrases){
   const stage=await arm(f);f.advance(stage.undoUntil-f.now()-1);
   for(const delta of deltas){
    const offset=f.input(delta,{turn_id:'cancel-'+stage.actionId});
    if(delta==='ca'){
     assert.equal(f.call.staged,stage);
     f.emit('session.output_transcript.delta',{offset_ms:offset+1,delta:'Starting the task.'});
    }
   }
   assert.equal(f.call.staged,null);
   const id=f.delegate();f.advance(200);await f.say('Cancelled.',id);await f.idle();
   assert.deepEqual(f.work,[]);
  }
  assert.equal(f.requests.length,phrases.length);
  assert.ok(f.requests.every(r=>r.options.phase==='plan'&&r.request.transcript==='Run morning intel'));
 });
 test(`${mode} checks user text already buffered when arming the undo timer`,async t=>{
  const f=await fixture(t,{mode});await f.start();
  async function requestWhileSettling(deltas){
   if(mode==='voice'){await f.stage('Run morning intel');await f.idle()}
   f.input(mode==='voice'?'Yes':'Run morning intel',{turn_id:'request'});
   const id=f.delegate();
   for(const delta of deltas)f.input(delta,{turn_id:'after'});
   f.advance(200);await f.idle();return id;
  }
  await requestWhileSettling(['ca','ncel']);
  const cancel=f.delegate();f.advance(200);await f.say('Cancelled.',cancel);await f.idle();
  assert.equal(f.call.staged,null);assert.equal(f.work.length,0);
  const id=await requestWhileSettling(['great thanks']);
  await f.say('Starting ');
  f.advance(f.call.staged.undoUntil-f.now());await f.idle();assert.equal(f.work.length,1);
 });
}

test('a follow-up using the shared router at the undo deadline cannot discard the earlier commit',async t=>{
 const gate=deferred(),commits=[];
 const f=await fixture(t,{mode:'auto',route:async(_root,request,_signal,_execute,_terminals,{phase})=>{
  if(phase==='commit'){commits.push(request.transcript);return {reply:'Done.'}}
  if(request.transcript==='Check my inbox')await gate.promise;
  return {kind:'action',action:{effects:[]},description:request.transcript};
 }});
 await f.start();
 const first=await f.stage('Run morning intel');await f.idle();
 const id=f.turn('Check my inbox');await until(()=>f.active.size);
 f.advance(first.undoUntil-f.now());assert.equal(f.call.staged,null);
 gate.resolve();await f.say('Starting Check my inbox');await f.idle();
 assert.deepEqual(commits,['Run morning intel']);
 f.advance(2500);await f.idle();assert.deepEqual(commits,['Run morning intel','Check my inbox']);
});

for(const affirmation of ['go ahead','Okay, go ahead'])test(`a fresh spoken offer is assembled from output deltas and accepted by "${affirmation}" through auto plan and commit`,async t=>{
 const f=await fixture(t,{mode:'auto',modelReply:{tier:3,reply:'Working on it.'}});await f.start();
 f.input('Any applications of the Riemann hypothesis?',{turn_id:'question'});
 const offer='Want me to start a research task on the Riemann hypothesis?';
 f.emit('session.output_transcript.delta',{turn_id:'offer',offset_ms:24,delta:'Want me to start a research'});
 f.emit('session.output_transcript.delta',{turn_id:'offer',offset_ms:26,delta:' '});
 f.emit('session.output_transcript.delta',{turn_id:'offer',offset_ms:28,delta:'task on the Riemann hypothesis?'});
 for(const delta of [affirmation.slice(0,-6),' ','ahead'])f.input(delta,{turn_id:'accept'});
 f.delegate();f.advance(200);await f.say('Starting ');await f.idle();
 assert.equal(f.requests[0].request.transcript,`Do what you just offered. You said: "${offer}". The user replied: "${affirmation}".`);
 assert.equal(f.work.length,0);f.advance(2500);await f.idle();
 assert.deepEqual(f.requests.map(r=>r.options.phase),['plan','commit']);assert.equal(f.work[0][0],'start');
 assert.match(f.work[0][1].prompt,/research task on the Riemann hypothesis/);
});

test('Live auto starts a literal slash skill once and answers status without a classifier',async t=>{
 const f=await fixture(t,{mode:'auto',hasSkill:(provider,_root,name)=>provider==='claude'&&name==='today'});await f.start();
 const existing={id:randomUUID(),...chosen,title:'Separate task',state:'working',created:Date.now(),turns:[]};
 f.tasks.set(existing.id,existing);setCurrent(f.root,{get:id=>f.tasks.get(id)},{provider:'claude',id:existing.id});
 await f.post('/voice/live/context',f.saved());
 const start=f.turn('slash today');await f.say('Starting /today…');await f.idle();
 existing.state='ready';
 assert.equal(f.work.length,0);f.advance(2500);await until(()=>f.work.length===1);await f.idle();
 assert.equal(f.work[0][0],'start');assert.equal(f.work[0][1].prompt,'/today');assert.equal(f.work[0][1].liveCallId,f.call.callId);
 // The hand-off stays open for the task's news: nothing is said on it yet, only a silent note.
 assert.equal(f.appends().filter(event=>event.delegation_id===start&&event.type==='session.commentary.append').length,0);
 assert.ok(f.appends().some(event=>event.delegation_id===start&&event.type==='session.thinking.append'));
 assert.equal(f.call.taskUpdates.open.get(f.work[0][1].id)?.delegation,start);
 await f.post('/voice/live/context',f.saved());
 const status=f.turn('How’s that going?');await f.say('/today is still running, 0 min in.',status);await f.idle();
 const work=f.tasks.get(f.work[0][1].id);work.state='ready';work.turns.push({id:'done',ts:Date.now(),text:'Saved the daily note.'});
 const finished=f.turn('Is that done yet?');await f.say('/today finished 0 min ago: Saved the daily note.',finished);
 assert.equal(f.prompts.length,0);assert.equal(f.work.length,1);
});

test('a read offer reads the last finished result without sending to a selected worker',async t=>{
 const f=await fixture(t,{mode:'destructive'});await f.start();
 f.turn('Draft a launch plan');await until(()=>f.work.length===1);await f.idle();
 await f.post('/voice/live/context',f.saved());
 let offset=f.input('Thanks.');
 f.emit('session.output_transcript.delta',{offset_ms:offset+1,delta:'Do you want to hear the result?'});
 let yes=f.turn('Yeah');await f.say('Nothing has finished yet.',yes);await f.idle();
 const job=f.work[0][1];
 f.hub.publish('plan-ready','Saved the launch plan.',{appScope:'web',kind:'completion',taskId:job.id,liveCallId:f.call.callId,deliverable:readReportPath});
 offset=f.input('Hello.');
 f.emit('session.output_transcript.delta',{offset_ms:offset+1,delta:'Want me to walk you through the summary?'});
 yes=f.turn('Yes');await f.say('Saved the launch plan.',yes);await f.idle();
 assert.ok(f.call.answers.reports.has(readReportPath));
 assert.equal(f.work.length,1);assert.equal(f.requests.length,2);
});

test('an accepted action offer starts fresh even with a selected worker',async t=>{
 const f=await fixture(t,{mode:'destructive',modelReply:{tier:3,reply:'Working on that.'}});await f.start();
 f.turn('Draft a launch plan');await until(()=>f.work.length===1);await f.idle();
 await f.post('/voice/live/context',f.saved());
 const selected=f.saved().workTarget;
 const offset=f.input('What next?');
 f.emit('session.output_transcript.delta',{offset_ms:offset+1,delta:'Want me to start a separate research task?'});
 f.turn('Yeah');await until(()=>f.work.length===2);await f.idle();
 assert.equal(f.work[1][0],'start');assert.notEqual(f.work[1][1].id,selected);
 assert.equal(f.requests.at(-2).request.workTarget,null);assert.equal(f.requests.at(-1).request.workTarget,null);
});

test('Live asks for a request when the last assistant utterance is absent, stale, later or has no offer',async t=>{
 const f=await fixture(t,{mode:'auto'});await f.start();
 const clarify=async words=>{const id=f.turn(words);await f.say("Tell me what you'd like me to do.",id);await f.idle()};
 await clarify('yes');
 const output=(offset,text)=>f.emit('session.output_transcript.delta',{offset_ms:offset,turn_id:'reply-'+offset,delta:text});
 output(25,'Shall I run the brief?');f.advance(60001);await clarify('okay');
 output(45,'Should I run the brief?');output(46,'The brief has already run.');output(120,'Should I run it again?');
 await clarify('sounds good');assert.deepEqual(f.requests,[]);
});

test('long offers retain a concrete trailing action within 400 characters',()=>{
 const turns=new LiveTurns(0),offer='I can start a research task on this if you like.';
 turns.add({type:'session.output_transcript.delta',offset_ms:1,delta:'Prior explanation. '.repeat(40)+offer},1);
 turns.add({type:'session.input_transcript.delta',offset_ms:60001,delta:'Sure'},60001);
 assert.equal(turns.take(60001,60201).offer,offer);
});

test('a correction or delayed negation cancels an affirmed action; corrections abort a pending plan',async t=>{
 const f=await fixture(t);await f.start();
 for(const fragment of ['use the other one instead',"No, don't do that"]){
  await f.stage('Run morning intel');await f.idle();
  const id=f.turn('Yes');await f.say('Starting ');await f.idle();
  f.advance(f.call.staged.undoUntil-f.now()-1);f.input(fragment);
  f.advance(1);await f.idle();assert.equal(f.call.staged,null);assert.equal(f.work.length,0);
 }
 f.input('Run morning intel');f.delegate('corrected');f.input('Actually, wait');
 await f.idle();assert.equal(f.call.staged,null);assert.equal(f.work.length,0);
 assertAppends(f.appends());
});

test('a correction during classification aborts the shared request before it can stage a mutation',async t=>{
 let aborted=false;
 const f=await fixture(t,{route:async(_root,_request,signal)=>{
  await new Promise((_,reject)=>{
   const abort=()=>{aborted=signal.aborted;reject(signal.reason)};
   signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });
 }});
 await f.start();const id=f.turn('Run morning intel');await until(()=>f.active.size);
 f.input('Actually, hold on');
 await f.idle();assert.equal(aborted,true);assert.equal(f.work.length,0);assert.equal(f.call.staged,undefined);
 assert.equal(f.appends().some(e=>e.delegation_id===id),false,'held until the caller is done');
 // Once they are quiet, a turn that ended in a cancel answers the held hand-off, so it cannot keep the call awake.
 f.advance(2500);await f.bridge.calls.sweep();await f.idle();
 const own=f.appends().filter(e=>e.delegation_id===id);
 assert.equal(own.length,1);assert.equal(own[0].content,'Cancelled.');assert.equal(f.work.length,0);
});

test('click alone confirms, once; cancel, expiry, changed target, and a different generation refuse',async t=>{
 const f=await fixture(t,{mode:'click'});await f.start();
 let s=await f.stage('Run morning intel');await f.idle();
 const yes=f.turn('Yes');await f.say('Tap Confirm on screen.',yes);await f.idle();assert.equal(f.work.length,0);
 assert.equal((await f.post('/voice/live/confirm',{actionId:s.actionId},{'x-v2-call':'wrong'})).status,403);
 const [accepted,duplicate]=await Promise.all([f.post('/voice/live/confirm',{actionId:s.actionId}),f.post('/voice/live/confirm',{actionId:s.actionId})]);
 assert.equal(accepted.status,200,accepted.value.error);assert.equal(duplicate.status,409);assert.equal(f.work.length,1);
 await f.post('/voice/live/context',f.saved());
 s=await f.stage('Run morning intel');await f.idle();
 assert.equal((await f.post('/voice/live/cancel',{actionId:s.actionId})).status,200);
 assert.equal((await f.post('/voice/live/confirm',{actionId:s.actionId})).status,409);
 s=await f.stage('Run morning intel');await f.idle();
 const otherTask={id:randomUUID(),...chosen,execution:'cli',state:'ready',created:Date.now(),turns:[]};
 f.tasks.set(otherTask.id,otherTask);setCurrent(f.root,{get:id=>f.tasks.get(id)},{provider:'claude',id:otherTask.id});
 assert.match((await f.post('/voice/live/confirm',{actionId:s.actionId})).value.error,/target/);
 await f.post('/voice/live/context',f.saved());
 s=await f.stage('Run morning intel');await f.idle();
 assert.equal(s.expiresAt,f.now()+45000);
 f.advance(44999);assert.equal(f.call.staged,s);
 f.advance(1);assert.equal(f.call.staged,null);
 assert.ok(f.call.updates.events.some(event=>event.type==='staged-expired'));
 assert.equal((await f.post('/voice/live/confirm',{actionId:s.actionId})).status,409);
 s=await f.stage('Run morning intel');await f.idle();s.captured.gen--;
 assert.equal((await f.post('/voice/live/confirm',{actionId:s.actionId})).status,409);
 assert.equal(f.work.length,1);
});

test('destructive mode starts new work immediately but still asks for a click to stop',async t=>{
 const f=await fixture(t,{mode:'destructive'});await f.start();
 f.turn('Draft an essay about thunderstorms');await until(()=>f.work.length);await f.idle();
 assert.equal(f.work[0][0],'start');assert.equal(f.call.staged,undefined);
 await f.post('/voice/live/context',f.saved());
 const stop=await f.stage('Stop that task');await f.idle();
 assert.equal(stop.mode,'click');assert.equal(f.work.length,1);
 assert.equal((await f.post('/voice/live/confirm',{actionId:stop.actionId})).status,200);
 assert.equal(f.work[1][0],'stop');
});

test('routing holds the shared gate and sends one progress message; overlap and Local are refused',async t=>{
 const gate=deferred();
 const f=await fixture(t,{route:async()=>{await gate.promise;return {kind:'read',reply:'Finished the lookup.'}}});
 await f.start();
 const id=f.turn('Check the saved reading');await until(()=>f.active.size===1);
 const progressAt=f.now()+8000;
 await assert.rejects(f.typed('Typed during the lookup'),/Another voice request/);
 const overlap=f.turn('Another question');await f.say('One second',overlap);
 const progress=()=>f.appends().filter(e=>e.delegation_id===id&&e.content==='Still looking…');
 f.advance(progressAt-f.now()-1);assert.equal(progress().length,0);
 f.advance(1);assert.equal(progress().length,1);
 f.advance(20000);assert.equal(progress().length,1);
 assert.equal(f.requests.length,1);assert.equal(f.active.size,1);
 gate.resolve();await f.say('Finished the lookup.',id);await f.idle();
 f.active.set('local-request',new AbortController());
 const busy=f.turn('Another saved reading');await f.say('One second',busy);assert.equal(f.requests.length,1);
 f.active.clear();
 assertAppends(f.appends());
});

test('a pending task plan stays quiet past the read progress threshold',async t=>{
 const gate=deferred();
 const f=await fixture(t,{route:async()=>{await gate.promise;return {kind:'read',reply:'Ready.'}}});
 await f.start();const id=f.turn('Draft a research brief');await until(()=>f.active.size===1);
 f.advance(12000);assert.equal(f.appends().some(event=>event.delegation_id===id&&event.content==='Still looking…'),false);
 gate.resolve();await f.say('Ready.',id);await f.idle();
});

test('snapshot refresh waits for a pending delegation and supplies only the changed section',async t=>{
 const gate=deferred();
 const f=await fixture(t,{route:async()=>{await gate.promise;return {kind:'read',reply:'Done.'}}});
 await f.start();f.turn('Check that');await until(()=>f.active.size);
 f.setSnapshot('Today (fixture)\n- New agenda');await f.bridge.sweep();await flush();
 assert.equal(f.appends().some(e=>e.delegation_id===null),false);
 gate.resolve();await f.idle();f.advance(4000);await f.bridge.sweep();
 const refresh=await f.say('New agenda');assert.equal(refresh.delegation_id,null);
 assert.equal(refresh.type,'session.thinking.append');assert.doesNotMatch(refresh.content,/First plan/);
 await f.bridge.sweep();await flush();assert.equal(f.appends().filter(e=>e.delegation_id===null).length,1);
 assertAppends(f.appends());
});

test('appends with an unknown outcome are tracked and never retried',()=>{
 const frames=[],call={state:'active',paused:false,socket:{send(event){frames.push(event);throw new Error('Unknown send outcome')}}};
 const answers=new LiveAnswers(call);
 answers.speak('one','Private fixture reply');answers.resume();answers.resume();
 assert.equal(frames.length,1);assert.equal(answers.attempts.get(frames[0].event_id),'unknown');
 assertAppends(frames);
});

test('typed work and mixed work turns are excluded from every sideband append; completion cards remain on screen',async t=>{
 const f=await fixture(t,{mode:'destructive'});await f.start();
 const typedMarker='CINNAMON-POSITIVE-TYPED',followMarker='JUNIPER-MIXED-FOLLOWUP',doneMarker='OCHRE-TYPED-COMPLETION',liveMarker='harbor lighthouse';
 const first=await f.typed('Draft a launch plan about '+typedMarker);
 assert.equal(first.receipt.transport,'local');assert.equal(first.receipt.liveCallId,undefined);
 const typedTask=first.result.workIds[0];assert.ok(typedTask);
 f.hub.publish('typed-completion',doneMarker,{appScope:'web',kind:'completion',taskId:typedTask});
 setCurrent(f.root,{get:id=>f.tasks.get(id)},{provider:'claude',id:null});
 await f.post('/voice/live/context',f.saved());
 f.turn('Draft a launch plan about '+liveMarker);
 await until(()=>f.work.length===2);await f.idle();
 await f.post('/voice/live/context',f.saved());
 const workId=f.saved().workTarget;assert.ok(workId&&workId!==typedTask);
 const follow=await f.typed('Revise it and include '+followMarker);
 assert.equal(follow.receipt.transport,'local');assert.equal(follow.result.workIds[0],workId);
 f.tasks.get(workId).turns.push({id:'typed-turn',text:followMarker,ts:Date.now()});
 f.hub.publish('mixed-completion',followMarker,{appScope:'web',kind:'completion',taskId:workId});
 f.hub.publish('other-app','Unrelated app',{appScope:'native',kind:'completion',taskId:randomUUID()});
 const id=f.turn('Why is anisotropic filtering used in a renderer?');await f.say('saved reading',id);await f.idle();
 const prompts=f.prompts.at(-1);
 assert.match(prompts,/harbor lighthouse/);
 assert.doesNotMatch(prompts,new RegExp([typedMarker,followMarker,doneMarker].join('|')));
 const memory=voiceMemory(f.root,'claude','web','live',f.call.callId);
 assert.ok(memory.some(exchange=>exchange.you.includes(liveMarker)));
 assert.doesNotMatch(JSON.stringify(memory),new RegExp([typedMarker,followMarker,doneMarker].join('|')));
 assert.deepEqual(voiceMemory(f.root,'claude','web','live','different-call'),[]);
 const appends=f.appends();
 assert.doesNotMatch(JSON.stringify(appends),new RegExp([typedMarker,followMarker,doneMarker].join('|')));
 assertAppends(appends);
 const cards=(await f.post('/voice/live/updates?cursor=0')).value.events.filter(e=>e.type==='completion');
 assert.deepEqual(cards.map(card=>card.taskId),[typedTask,workId]);assert.equal(f.broadcasts.some(e=>e.type==='completion'),false);
 const presence={id:f.lease.surfaceId,kind:'web',visible:true,mode:'idle'};
 assert.equal(f.hub.presence(presence),null);
 await f.advance(4000);await f.bridge.sweep();
 assert.doesNotMatch(JSON.stringify(f.appends()),new RegExp([typedMarker,followMarker,doneMarker].join('|')));
 await f.bridge.calls.invalidate('Hang up.');
 assert.equal(f.hub.presence(presence),null);
 f.prefs.voiceMode='local';assert.match(f.hub.presence(presence).text,/updates from 2 tasks/);
 assert.equal(f.appends().length,appends.length);
 assert.doesNotMatch(liveHistory(f.root,'web'),new RegExp([typedMarker,followMarker,doneMarker].join('|')));
 assert.match(liveHistory(f.root,'web'),/harbor lighthouse/);
});

test('Live report references do not authorize an ordinary report read or a Local receipt replay',async t=>{
 const f=await fixture(t);await f.start();
 fs.mkdirSync(path.join(f.root,'notes'));fs.writeFileSync(path.join(f.root,readReportPath),'fixture');
 const receipt={id:randomUUID(),provider:'claude',requestedWorkerModel:'sonnet',transport:'live',liveCallId:f.call.callId,deliverable:readReportPath};
 writeJson(f.root,`${ROOT}/voice-results/${receipt.id}.json`,receipt);
 assert.throws(()=>readVoiceReport(f.root,readReportPath,[],[receipt]),/Only referenced/);
 const ctx={root:f.root,active:f.active};
 const request={id:receipt.id,selection:chosen,transcript:'Attempt replay'};
 await assert.rejects(handleVoiceRequest(ctx,request,{source:'text'}),/different selection/);
 await assert.rejects(handleVoiceRequest(ctx,{...request,liveCallId:'other-call'},{source:'live'}),/different selection/);
});

test('the startup carry summary contains only earlier Live receipts from today and this app',async t=>{
 const f=await fixture(t);f.prefs.liveCarryToday=true;
 const save=(transcript,fields)=>{
  const id=randomUUID();
  writeJson(f.root,`${ROOT}/voice-results/${id}.json`,{id,ts:Date.now()-1000,appScope:'web',origin:'live',transport:'live',transcript,reply:'Live answer',...fields});
 };
 save('Carry this Live request',{});save('LOCAL-HISTORY-MARKER',{transport:'local'});
 save('OTHER-APP-MARKER',{appScope:'native'});save('YESTERDAY-MARKER',{ts:Date.now()-86400000});save('TEST-RECEIPT-MARKER',{origin:'test'});
 await f.start();
 const {session}=f.creates[0];assert.equal(session.input,undefined);
 const summary=session.instructions.slice(session.instructions.indexOf('Earlier calls today'));
 assert.match(summary,/Carry this Live request/);assert.doesNotMatch(summary,/(?:LOCAL-HISTORY|OTHER-APP|YESTERDAY|TEST-RECEIPT)-MARKER/);
 assert.ok(Buffer.byteLength(summary)<=1000);
 assert.match(session.instructions,/They ask to stop, cancel or drop work/);
});

function speechFixture(){
 const clock=manualClock(0),requests=[];let bootId='boot-1',modeCap=true,answer='idle';
 const speechMode=liveSpeechMode({speech:'http://127.0.0.1:3220',readAuth:()=>({bootId:'boot-1',modeSecret:'fixture'}),now:clock.now,enabled:true,
  timeout:clock.timeout,sleep:clock.sleep,
  fetchImpl:async(url,options)=>{
   options.signal.throwIfAborted();
   if(url.endsWith('/health'))return Response.json({bootId,mode:modeCap});
   const body=JSON.parse(options.body);requests.push(body);
   if(options.headers['X-V2-Mode-Secret']!=='fixture')return Response.json({}, {status:403});
   const state=typeof answer==='function'?answer(body):answer;
   return state==='unknown'?Response.json({}, {status:409}):Response.json({state,bootId});
  }});
 return {speechMode,requests,advance:clock.advance,setBoot:value=>{bootId=value},setMode:value=>{modeCap=value},setAnswer:value=>{answer=value}};
}

test('Windows holds create for idle, sends owner hotkey updates, and releases on hangup',async t=>{
 const speech=speechFixture();speech.setAnswer(body=>body.capture==='off'&&speech.requests.length<3?'busy':'idle');
 const f=await fixture(t,{speechMode:speech.speechMode}),started=f.start();
 await until(()=>speech.requests.length===1);await flush();
 speech.advance(219);await flush();assert.equal(speech.requests.length,1);assert.equal(f.creates.length,0);
 speech.advance(1);await until(()=>speech.requests.length===2);await flush();assert.equal(f.creates.length,0);
 speech.advance(220);await started;
 assert.deepEqual(speech.requests.map(e=>e.capture),['off','off','off']);
 assert.ok(speech.requests.every(e=>e.lease===speech.requests[0].lease));
 assert.equal(f.creates.length,1);
 f.bridge.calls.hotkey();
 assert.ok((await f.post('/voice/live/updates?cursor=0')).value.events.some(e=>e.type==='hotkey'));
 assert.equal(f.broadcasts.some(e=>e.type==='hotkey'),false);
 await f.bridge.calls.invalidate('Done');assert.equal(speech.requests.at(-1).capture,'on');
});

test('Windows start declines busy timeout or missing capability before creating GPT-Live',async t=>{
 const speech=speechFixture();const f=await fixture(t,{speechMode:speech.speechMode});
 speech.setMode(false);await assert.rejects(f.start(),{message:speechUpdate});
 speech.setMode(true);speech.setAnswer('busy');
 const timedOut=assert.rejects(f.start(),{message:speechBusy});
 await until(()=>speech.requests.length===1);await flush();
 speech.advance(220);await until(()=>speech.requests.length===2);await flush();
 speech.advance(24779);await flush();assert.ok(f.call);assert.equal(speech.requests.at(-1).capture,'off');
 speech.advance(1);await timedOut;
 assert.equal(f.creates.length,0);assert.ok(speech.requests.filter(e=>e.capture==='off').length>1);
});

test('Windows renewal failure and a reboot mute and close the owning call',async t=>{
 for(const change of [speech=>speech.setAnswer('unknown'),speech=>speech.setBoot('boot-2')]){
  const speech=speechFixture(),f=await fixture(t,{speechMode:speech.speechMode});await f.start();
  const call=f.call;change(speech);speech.advance(19999);await f.bridge.sweep();
  assert.equal(speech.requests.some(e=>e.renew),false);
  speech.advance(1);await f.bridge.sweep();
  await until(()=>!f.call);
  assert.ok(speech.requests.some(e=>e.renew));
  assert.deepEqual(f.frames.slice(-2).map(e=>e.type),['session.input_audio.mute','session.close']);
  assert.ok((await call.updates.poll(0)).events.some(e=>e.reason===speechRestarted));
 }
});

test('a hand-off reports what it is doing: handed off, then starting and started, or answered, or dropped',async t=>{
 const phases=f=>f.call.updates.events.filter(event=>event.type==='activity').map(({key,phase,label})=>({key,phase,label}));
 const f=await fixture(t,{mode:'auto'});await f.start();
 const stage=await f.stage('Run morning intel');await f.idle();
 assert.deepEqual(phases(f),[{key:stage.delegation,phase:'handoff',label:''},{key:stage.delegation,phase:'starting',label:stage.description}]);
 f.advance(2500);await f.idle();assert.equal(f.work.length,1);
 assert.deepEqual(phases(f).at(-1),{key:stage.delegation,phase:'started',label:stage.description});
 assert.equal(phases(f).length,3);
 // The started event names the work it started, so the surface can keep its card up until that work finishes.
 const events=f.call.updates.events.filter(event=>event.type==='activity');
 assert.deepEqual(events.at(-1).taskIds,[f.work[0][1].id]);assert.equal(events.slice(0,-1).some(event=>'taskIds' in event),false);

 const cancelled=await fixture(t,{mode:'click'});await cancelled.start();
 const held=await cancelled.stage('Run morning intel');await cancelled.idle();
 await cancelled.post('/voice/live/cancel',{actionId:held.actionId});
 assert.deepEqual(phases(cancelled).map(item=>item.phase),['handoff','starting','dropped']);assert.equal(cancelled.work.length,0);

 const read=await fixture(t,{route:async()=>({kind:'read',reply:'Nothing urgent came in.',briefSource:'inbox/research/morning-intel/today.md'})});await read.start();
 const id=read.turn('Any important email today');await read.say('Nothing urgent came in.',id);await read.idle();
 assert.deepEqual(phases(read),[{key:id,phase:'handoff',label:''},{key:id,phase:'answered',label:'the morning brief'}]);

 // A status question answered from the tasks says so on its card, not "saved notes".
 const status=await fixture(t,{route:async()=>({kind:'read',reply:'Inbox Brief is still working, 2 minutes in.',decision:{rule:'router.taskStatus'}})});await status.start();
 const asked=status.turn('Why is this taking so long');await status.say('Inbox Brief is still working, 2 minutes in.',asked);await status.idle();
 assert.deepEqual(phases(status).at(-1),{key:asked,phase:'answered',label:'task status'});
});

test('a request refused because the selected task is busy says so; any other failure keeps the short retry',async t=>{
 const refusal='This task is working or needs terminal input. Wait for its answer, or type directly in its terminal.';
 let failure=refusal;
 const f=await fixture(t,{route:async()=>{throw new Error(failure)}});await f.start();
 let id=f.turn('Add a section about history to it');
 const spoken=await f.say('still working',id);await f.idle();
 assert.match(spoken.content,/^That task is still working, so I can't add to it yet\. Ask me again when it finishes, or say start a new task and what you want\.$/);
 assert.equal(f.appends().some(event=>/Say that again/.test(event.content)),false);
 failure='This conversation has an unfinished workflow. Continue it before starting another workflow in this terminal.';
 id=f.turn('Run the weekly review in there');await f.say('still working',id);await f.idle();
 failure='Something unexpected broke.';
 id=f.turn('Open the dashboard');await f.say('Say that again in a moment.',id);await f.idle();
 assert.equal(f.work.length,0);
});

test('on a call, a follow-up for a working task waits for it; if the task frees up first, it is sent at once',async t=>{
 const f=await fixture(t,{mode:'auto',modelReply:{tier:3,reply:'Working on that.'}});await f.start();
 f.turn('Draft a launch plan');await until(()=>f.call?.staged);await f.idle();f.advance(2500);await until(()=>f.work.length===1);await f.idle();
 await f.post('/voice/live/context',f.saved());
 const first=f.saved().workTarget;assert.equal(f.tasks.get(first).state,'working');
 let id=f.turn('Make the second half shorter and punchier');
 const stage=await until(()=>f.call?.staged);await f.idle();
 assert.match((await f.say('add that as soon as')).content,/^Got it\. I'll add that as soon as that task is free\.$/);
 f.advance(2500);await f.idle();
 assert.equal(f.work.length,2);assert.deepEqual(f.work[1].slice(0,2),['queue',first]);assert.match(f.work[1][2],/Make the second half shorter and punchier/);
 assert.equal(f.appends().some(event=>/Say that again|still working/.test(event.content)),false);
 // The same request, when the task finishes its turn inside the cancel window, is not refused for having changed.
 id=f.turn('Give it a stronger closing line');await until(()=>f.call?.staged);await f.idle();
 f.tasks.get(first).state='ready';
 f.advance(2500);await f.idle();
 assert.equal(f.work.length,3);assert.deepEqual(f.work[2].slice(0,2),['send',first]);
 assert.equal(f.appends().some(event=>/Say that again/.test(event.content)),false);
 assert.ok(stage.actionId);
});

// 2026-11-26 test calls: Live talked over the caller and only the tail of their request was routed.
test('turn assembly joins the caller’s words across Live talking over them, but not across a question', () => {
 const turns=new LiveTurns(0);
 const say=(at,text,user=true)=>turns.add({type:user?'session.input_transcript.delta':'session.output_transcript.delta',delta:text},at);
 say(30000,'Quick thing, your usage is at sixteen',false);
 say(33000,'On that');say(33100,' percent',false);say(33300,' outline');say(34000,' used.',false);say(34200,' make sure it has a cost section');
 assert.equal(turns.take(35000,35000).text,'On that outline make sure it has a cost section');
 const offer=new LiveTurns(0);
 offer.add({type:'session.input_transcript.delta',delta:'Any applications?'},10000);
 offer.add({type:'session.output_transcript.delta',delta:'Want me to research that?'},10500);
 offer.add({type:'session.input_transcript.delta',delta:'go ahead'},11000);
 assert.equal(offer.take(12000,12000).text,'go ahead');
 const late=new LiveTurns(0);
 late.add({type:'session.input_transcript.delta',delta:'First request'},10000);
 late.add({type:'session.output_transcript.delta',delta:'Okay.'},11000);
 late.add({type:'session.input_transcript.delta',delta:'Second request'},14000);
 assert.equal(late.take(15000,15000).text,'Second request','a pause longer than the talk-over gap starts a new turn');
});

test('Live promising work in its own words is recognised; offers, answers and report-backs are not', () => {
 for(const said of ["Sure. I'll do a quick deep-dive and save a clean note. I'll get that moving.","Got it, I'll pull what's shipping now, compare tradeoffs, and save a one-page note.","On it.","Let me look that up.","Gotcha, I'll bake that in.","Sure, starting that now.","I'll fold that in with the outline that's running now."])
  assert.equal(livePromised(said),true,said);
 for(const said of ['Want me to start a research task on that?',"Let me check. You've got three meetings today.","Research is still working. I'll tell you when it's done.","I'll let you know as soon as it's up.","Hi, Chase, ready when you are.","It's running now; I'll bring you the tradeoffs once it's ready.","It's still checking the file, so I'll share details once that's complete.","I'll keep that in mind.",
  // Neon review, 2026-11-26: talk, not work.
  "Let me explain.","Let me think.","I'll break it down for you.","I'll note that.","I'll skip that.","I'll keep it simple: three beats."])
  assert.equal(livePromised(said),false,said);
});

test('Live promises work and never hands it off: V2 takes the caller’s words itself, once, and says what it started', async t => {
 const f=await fixture(t,{mode:'auto'});await f.start();
 const at=f.input('Write three short YouTube hooks about AI coding agents and save a quick note',{turn_id:'u1'});
 f.emit('session.output_transcript.delta',{offset_ms:at+10,delta:"Sure, I'll get that moving."});
 f.advance(2999);await f.bridge.calls.sweep();await flush();assert.equal(f.requests.length,0,'Live may still hand it off');
 f.advance(1);await f.bridge.calls.sweep();f.advance(200);
 await until(()=>plans(f)===1);
 assert.match(f.requests[0].request.transcript,/three short YouTube hooks/);
 await until(()=>f.call.staged);
 // Said out loud, with the undo window open: V2 acted on its own reading of Live's words.
 const starting=f.appends().find(event=>event.type==='session.commentary.append'&&/^Starting/.test(event.content));
 assert.ok(starting);assert.equal(starting.delegation_id,null);
 f.advance(2500);await f.idle();assert.equal(f.work.length,1);
 f.advance(10000);await f.bridge.calls.sweep();f.advance(200);await flush();assert.equal(plans(f),1,'once per caller turn');
});

test('no rescue when Live answered, asked, or handed the work off itself', async t => {
 const f=await fixture(t,{mode:'auto'});await f.start();
 let at=f.input('How many meetings do I have today?',{turn_id:'u1'});
 f.emit('session.output_transcript.delta',{offset_ms:at+10,delta:'You have three, starting at ten.'});
 f.advance(5000);await f.bridge.calls.sweep();f.advance(200);await flush();
 at=f.input('Research the new Codex release',{turn_id:'u2'});
 f.emit('session.output_transcript.delta',{offset_ms:at+10,delta:'Want me to save it as a note too?'});
 f.advance(5000);await f.bridge.calls.sweep();f.advance(200);await flush();
 assert.equal(plans(f),0);
 f.input('Draft a launch plan and save it',{turn_id:'u3'});const id=f.delegate();
 f.emit('session.output_transcript.delta',{offset_ms:f.now(),delta:"On it, I'll get that moving."});
 f.advance(200);await until(()=>plans(f)===1);
 f.advance(5000);await f.bridge.calls.sweep();f.advance(200);await flush();
 assert.equal(plans(f),1);assert.ok(id);
});

test('the rest of a turn an earlier hand-off cut short starts at its first word', () => {
 const turns=new LiveTurns(0);
 turns.add({type:'session.input_transcript.delta',delta:'Do a deeper research pass',offset_ms:100},100);
 turns.skip(150);
 turns.add({type:'session.input_transcript.delta',delta:'. Check the web for agent workflows',offset_ms:200},200);
 assert.equal(turns.take(300,300).text,'Check the web for agent workflows');
});

test('a follow-up sent to the finished task in front is said as “Updating it now…”, not “Starting Continue that task”', async t => {
 const f=await fixture(t,{mode:'auto',modelReply:{tier:3,reply:'Working on that.'}});await f.start();
 f.turn('Draft a launch plan');await until(()=>f.call?.staged);await f.idle();f.advance(2500);await until(()=>f.work.length===1);await f.idle();
 await f.post('/voice/live/context',f.saved());
 const first=f.saved().workTarget;f.tasks.get(first).state='ready';
 f.turn('Make it shorter, five tight bullets');await until(()=>f.call?.staged);await f.idle();
 assert.ok(await f.say('Updating it now…'));
 assert.equal(f.appends().some(event=>/Starting Continue/.test(event.content)),false);
 f.advance(2500);await f.idle();assert.deepEqual(f.work[1].slice(0,2),['send',first]);
});

test('a hand-off made at a pause waits for the caller to finish and takes the rest of what they said', async t => {
 const f=await fixture(t,{mode:'auto'});await f.start();
 f.input('Research AI video editors and save it to my',{turn_id:'u1'});f.delegate();
 f.advance(100);f.input(' inbox. Take your time and be thorough.',{turn_id:'u1'});
 for(let i=0;i<5;i++){f.advance(200);await flush()}
 assert.equal(plans(f),0,'the caller only just stopped');
 for(let i=0;i<8;i++){f.advance(200);await flush()}
 await until(()=>plans(f)===1);
 assert.match(f.requests[0].request.transcript,/save it to my inbox\. Take your time and be thorough\./);
});

// 2026-11-26 test calls: "Start a timer test task. Wait six full minutes…" — Live handed off at the full stop, and the
// "Wait" cancelled that hand-off. Closed at once, Live never handed off the rest and the request was lost.
test('a hand-off cancelled by a “wait” inside the request is retaken with the whole turn when Live makes no new one', async t => {
 const f=await fixture(t,{mode:'auto'});await f.start();
 const id=f.turn('Start a timer test task.');
 f.input('Wait six full minutes, then save a short note.');
 await f.idle();assert.equal(f.appends().some(e=>e.delegation_id===id&&e.type==='session.commentary.append'),false);
 f.advance(2500);await f.bridge.calls.sweep();f.advance(200);
 await until(()=>plans(f)===1);
 assert.match(f.requests[0].request.transcript,/Start a timer test task\. ?Wait six full minutes, then save a short note\./);
 assert.equal(f.appends().some(e=>/^Superseded/.test(e.content)),false);
});

test('a held hand-off is closed quietly when Live hands off the rest itself', async t => {
 const f=await fixture(t,{mode:'auto'});await f.start();
 const id=f.turn('Start a timer test task.');
 f.input('Wait six full minutes, then save a short note.');await f.idle();
 const next=f.delegate();f.advance(200);
 const closed=await f.say('Superseded',id);assert.equal(closed.type,'session.commentary.append');
 await until(()=>plans(f)===1);assert.ok(next);
});

test('after a retake, Live’s own “starting that up” does not set off a second, empty rescue', async t => {
 const f=await fixture(t,{mode:'auto'});await f.start();
 f.turn('Start a timer test task.');
 f.input('Wait six full minutes, then save a short note.');await f.idle();
 f.emit('session.output_transcript.delta',{delta:'Sure thing, starting that up.'});
 f.advance(2500);await f.bridge.calls.sweep();f.advance(200);await until(()=>plans(f)===1);await f.idle();
 f.advance(2500);await f.idle();
 f.advance(4000);await f.bridge.calls.sweep();f.advance(200);await flush();await f.idle();
 assert.equal(plans(f),1);assert.equal(f.appends().some(e=>/Say that again/.test(e.content)),false);
});

test('words that run on from a hand-off are the same turn: no rescue for them', async t => {
 const f=await fixture(t,{mode:'auto'});await f.start();
 f.input('Research AI video editors and save it to my inbox.',{turn_id:'u1'});f.delegate();f.advance(200);
 await until(()=>plans(f)===1);
 f.advance(500);f.input(' Take your time and be thorough.',{turn_id:'u1'});
 f.emit('session.output_transcript.delta',{delta:"Got it, I'll get that moving."});
 for(let i=0;i<4;i++){f.advance(2500);await f.bridge.calls.sweep();f.advance(200);await flush();await f.idle()}
 assert.equal(plans(f),1);
});

test('a lone “Mm-hmm” from Live is not its acknowledgement: “Starting…” is still said', async t => {
 const f=await fixture(t,{mode:'auto'});await f.start();
 f.input('Write three hooks about coding agents and save a note',{turn_id:'u1'});const id=f.delegate();
 f.emit('session.output_transcript.delta',{delta:'Mm-hmm.'});f.advance(200);
 await until(()=>f.call?.staged);
 assert.ok(f.appends().some(e=>e.type==='session.commentary.append'&&/^Starting/.test(e.content)));assert.ok(id);
});

test('the two halves of a talked-over turn meet with a space, so “start a new task” is still heard', () => {
 const turns=new LiveTurns(0);
 turns.add({type:'session.input_transcript.delta',delta:'Also start a new task'},18000);
 turns.add({type:'session.output_transcript.delta',delta:'Sure.'},19000);
 turns.add({type:'session.input_transcript.delta',delta:'Write a three-line note and save it'},20000);
 assert.equal(turns.take(21000,21000).text,'Also start a new task Write a three-line note and save it');
});

// Tool hand-offs (runner/live/tools.mjs): an OpenAI model that has the conversation calls V2's tools with the request
// written out, so nothing is rebuilt from the transcript.
const toolCall=(f,callId,name,args)=>f.emit('response.event',{delegation_id:'d-'+callId,event:{type:'response.output_item.done',item:{type:'function_call',call_id:callId,name,arguments:JSON.stringify(args)}}});
const toolOutputs=f=>f.frames.filter(frame=>frame.type==='response.item.create').map(frame=>({callId:frame.item.call_id,...JSON.parse(frame.item.output)}));
async function toolFixture(t){
 const f=await fixture(t,{mode:'auto',modelReply:{tier:3,reply:'Working on that.'}});f.prefs.liveHandoff='tools';await f.start();
 return f;
}

test('tool hand-off: start_task is answered with what started and a task id, then the work starts', async t => {
 const f=await toolFixture(t);
 assert.equal(f.creates[0].session.delegation.type,'responses');
 assert.deepEqual(f.creates[0].session.delegation.responses.tools.map(tool=>tool.name),['start_task','follow_up_task','cancel_task','get_task_status','ask_vault']);
 f.input('Write three hooks and, uh, save a note',{turn_id:'u1'});
 f.emit('session.delegation.created',{delegation:{id:'d1',type:'delegation',target:'responses',response_id:'r1'}});
 toolCall(f,'call_1','start_task',{request:'Write three hooks about coding agents and save a note'});
 await until(()=>f.call?.staged);
 const [out]=toolOutputs(f);
 assert.equal(out.callId,'call_1');assert.equal(out.ok,true);assert.match(out.say,/^Starting /);assert.equal(out.task_id,'t1');assert.equal(out.status,'started');
 assert.deepEqual(out.tasks_in_this_call,[{task_id:'t1',request:'Write three hooks about coding agents and save a note'}]);
 const sent=f.frames.map(frame=>frame.type);assert.equal(sent[sent.indexOf('response.item.create')+1],'response.create');
 assert.equal(f.appends().some(e=>e.delegation_id!==null),false,'a tool hand-off takes no appends of its own');
 assert.equal(f.requests[0].request.transcript,'Write three hooks about coding agents and save a note');
 assert.deepEqual(f.requests[0].request.liveIntent,{kind:'new_work'});
 f.advance(2500);await f.idle();assert.equal(f.work.length,1);assert.equal(f.work[0][0],'start');
});

test('tool hand-off: the two halves of a request Live handed off too early become one task', async t => {
 const f=await toolFixture(t);
 toolCall(f,'call_1','start_task',{request:'Start a timer test task.'});await until(()=>f.call?.staged);
 // Not a cancel: the caller's words are not searched for "wait" in this mode.
 f.input(' Wait six full minutes, then save a short note.');assert.ok(f.call.staged);
 toolCall(f,'call_2','follow_up_task',{task_ref:'t1',change:'Wait six full minutes with a sleep command, then save a short note.'});
 await until(()=>toolOutputs(f).length===2);await until(()=>f.call?.staged);
 assert.equal(f.call.staged.request.transcript,'Start a timer test task. Wait six full minutes with a sleep command, then save a short note.');
 assert.equal(toolOutputs(f)[1].task_id,'t1','the model keeps the id it was given');
 f.advance(2500);await f.idle();assert.equal(f.work.length,1);
});

test('tool hand-off: cancel_task drops work that has not started, and stops work that has', async t => {
 const f=await toolFixture(t);
 toolCall(f,'call_1','start_task',{request:'Draft a quick one-pager on local voice models'});await until(()=>f.call?.staged);
 toolCall(f,'call_2','cancel_task',{task_ref:'latest'});
 await until(()=>toolOutputs(f).length===2);
 assert.equal(toolOutputs(f)[1].say,'Cancelled.');assert.equal(f.call.staged,null);
 f.advance(2500);await f.idle();assert.equal(f.work.length,0);
 toolCall(f,'call_3','start_task',{request:'Write a note on desk mics'});await until(()=>f.call?.staged);
 f.advance(2500);await until(()=>f.work.length===1);await f.idle();await f.post('/voice/live/context',f.saved());
 const id=f.work[0][1].id;
 toolCall(f,'call_4','cancel_task',{task_ref:'t2'});
 await until(()=>toolOutputs(f).length===4);assert.match(toolOutputs(f)[3].say,/^Stopping it/);
 f.advance(2500);await f.idle();assert.deepEqual(f.work.at(-1),['stop',id]);
});

test('tool hand-off: follow_up_task goes to the named task, whatever its wording', async t => {
 const f=await toolFixture(t);
 toolCall(f,'call_1','start_task',{request:'Draft a note comparing two desk mic setups'});await until(()=>f.call?.staged);
 f.advance(2500);await until(()=>f.work.length===1);await f.idle();await f.post('/voice/live/context',f.saved());
 const id=f.work[0][1].id;
 // "Write a budget pick…" reads as new work by its words; the tool call says which task it is for.
 toolCall(f,'call_2','follow_up_task',{task_ref:'t1',change:'Write a budget pick under a hundred bucks into it'});
 await until(()=>toolOutputs(f).length===2);
 assert.equal(toolOutputs(f)[1].task_id,'t1');
 f.advance(2500);await f.idle();
 assert.equal(f.work.length,2);assert.deepEqual(f.work[1].slice(0,2),['queue',id]);
});

test('tool hand-off: a tool call V2 cannot read is still answered', async t => {
 const f=await toolFixture(t);
 f.emit('response.event',{delegation_id:'d9',event:{type:'response.output_item.done',item:{type:'function_call',call_id:'call_9',name:'start_task',arguments:'{not json'}}});
 await until(()=>toolOutputs(f).length===1);
 assert.match(toolOutputs(f)[0].say,/Say it again/);assert.equal(f.work.length,0);
});
