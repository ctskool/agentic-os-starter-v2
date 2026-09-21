import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hedgeClassifier,readJevConfig,jevState,parseJevResult,jevRequestBody,classifyJev,preconnectJev,adoptDetached,adoptUnconfirmed,detachedClassifiers,classifierProcesses,drainDetachedClassifiers,JEV_REVISION,JEV_ACK} from '../runner/jev.mjs';
import {commandFor} from '../runner/adapters.mjs';

const unhandled=[];process.on('unhandledRejection',error=>unhandled.push(error));
const tick=(ms=0)=>new Promise(resolve=>setTimeout(resolve,ms));
const config=(mode='fastpath',fields={})=>({key:'sk-or-test-key-000000',mode:{codex:mode,claude:mode},theta:0.9,deadlineMs:600,tier2kind:false,...fields});
const decision=(fields={})=>({route:'tier3',tier:3,skill:null,p:0.97,kind:null,revision:JEV_REVISION,pinned:true,ms:5,socketReused:true,...fields});
// Behaves like executeCli: settles late, and rejects as soon as it is aborted.
function model(text='{"tier":2,"reply":"Here is a quick answer."}',ms=40){
 const seen={signal:null,aborted:false,calls:0};
 const run=signal=>{seen.signal=signal;seen.calls++;return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>resolve({text}),ms);
  const stop=()=>{clearTimeout(timer);seen.aborted=true;reject(new Error('Voice request cancelled'))};
  if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true});
 })};
 return {run,seen};
}
const hedge=(fields={})=>{const logs=[];return {logs,result:hedgeClassifier({root:'unused',id:'request-1',provider:'codex',state:()=>({transcript:'make a guide'}),validate:()=>true,config:config(),classify:async()=>decision(),log:(_root,_id,_boundary,entry)=>logs.push(entry),...fields})}};

test('mode off runs only the existing classifier with the caller\'s own signal',async()=>{
 const m=model(),signal=new AbortController().signal;let classified=0;
 const {result}=hedge({config:config('off'),signal,run:m.run,classify:async()=>{classified++;return decision()}});
 const value=await result;
 assert.equal(value.exited,false);assert.equal(value.jev,null);assert.equal(m.seen.signal,signal);assert.equal(classified,0);
});
test('a missing key is off even when a mode is configured',async()=>{
 const m=model();let classified=0;
 const value=await hedge({config:config('fastpath',{key:''}),run:m.run,classify:async()=>{classified++;return decision()}}).result;
 assert.equal(value.exited,false);assert.equal(classified,0);
});
test('shadow records Jev and never exits early, even on a confident tier 3',async()=>{
 const m=model(),{result,logs}=hedge({config:config('shadow'),run:m.run});
 const value=await result;await tick(5);
 assert.equal(value.exited,false);assert.equal(m.seen.aborted,false);assert.match(value.output.text,/quick answer/);
 assert.equal(logs.length,1);assert.equal(logs[0].earlyExit,false);assert.equal(logs[0].jev.route,'tier3');assert.equal(logs[0].mode,'shadow');
});
test('fastpath exits early on a confident pinned tier 3 only after the candidate validates, then aborts and keeps ownership of the loser',async()=>{
 const m=model(),order=[];
 const {result,logs}=hedge({run:signal=>{order.push('run');return m.run(signal)},validate:text=>{order.push(m.seen.aborted?'validate-after-abort':'validate-before-abort');return JSON.parse(text).reply===JEV_ACK}});
 const value=await result;
 assert.equal(value.exited,true);assert.deepEqual(JSON.parse(value.output.text),{tier:3,reply:JEV_ACK});
 assert.deepEqual(order,['run','validate-before-abort']);assert.equal(m.seen.aborted,true);
 await tick(10);
 assert.equal(detachedClassifiers(),0);
 assert.ok(logs.some(entry=>entry.earlyExit===true));assert.ok(logs.some(entry=>entry.loserCleanup==='confirmed'));
});
test('every exclusion, a missing threshold and every unusable Jev answer leave the model in charge',async()=>{
 const cases=[
  {excluded:['separateTasks']},{excluded:['acceptedOffer']},{excluded:['pendingSkill']},{excluded:['compound']},
  {config:config('fastpath',{theta:null})},
  {classify:async()=>decision({p:0.89})},{classify:async()=>decision({p:null})},
  {classify:async()=>decision({route:'tier2',tier:2})},{classify:async()=>decision({route:'workflow:weekly-review',tier:1,skill:'weekly-review'})},
  {classify:async()=>decision({pinned:false,revision:'typesafe/jev-9'})},
  {classify:async()=>{throw new Error('Jev deadline')}},{classify:async()=>{throw new Error('Jev HTTP 500')}},
  {state:()=>{throw new Error('no state')}},
  {validate:()=>null},{validate:()=>{throw new Error('Voice router returned an invalid response. Please rephrase.')}},
 ];
 for(const fields of cases){
  const m=model(),value=await hedge({run:m.run,...fields}).result;
  assert.equal(value.exited,false,JSON.stringify(Object.keys(fields)));assert.equal(m.seen.aborted,false);assert.match(value.output.text,/quick answer/);
 }
});
test('a model that finishes first wins, including when both settle together',async()=>{
 const fast=model(undefined,1),value=await hedge({run:fast.run,classify:async()=>{await tick(25);return decision()}}).result;
 assert.equal(value.exited,false);assert.equal(fast.seen.aborted,false);
 const instant={run:async()=>({text:'{"tier":2,"reply":"Instant."}'})};
 const tie=await hedge({run:instant.run,classify:async()=>decision()}).result;
 assert.equal(tie.exited,false);assert.match(tie.output.text,/Instant/);
});
test('a model failure is reported exactly as before',async()=>{
 await assert.rejects(hedge({run:async()=>{throw new Error('codex exited 1.')},classify:async()=>decision({route:'tier2',tier:2})}).result,/codex exited 1/);
});
test('cancellation before Jev answers cancels both sides and never dispatches',async()=>{
 const controller=new AbortController(),m=model();let jevSignal;
 const pending=hedge({signal:controller.signal,run:m.run,classify:(_state,options)=>{jevSignal=options.signal;return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('Jev cancelled'))))}}).result;
 await tick(5);controller.abort();
 await assert.rejects(pending,/cancelled/);assert.equal(m.seen.aborted,true);assert.equal(jevSignal.aborted,true);
});
test('cancellation that lands while the candidate validates does not exit early',async()=>{
 const controller=new AbortController(),m=model();
 const pending=hedge({signal:controller.signal,run:m.run,validate:()=>{controller.abort();return true}}).result;
 await assert.rejects(pending,/cancelled/);
});
test('an unconfirmed loser shutdown is reported, counted until it closes, and two of them suspend hedging',async()=>{
 drainDetachedClassifiers();
 const closers=[],reports=[];
 const stuck=()=>{let close;const closed=new Promise(resolve=>{close=resolve});closers.push(close);return signal=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{const error=new Error('Voice request cancelled; process shutdown could not be confirmed.');error.cleanupUnconfirmed=true;error.closed=closed;reject(error)}))};
 for(const id of ['stuck-1','stuck-2']){const value=await hedge({id,run:stuck(),log:(_r,_i,_b,entry)=>reports.push(entry)}).result;assert.equal(value.exited,true)}
 await tick(5);
 assert.equal(detachedClassifiers(),2);assert.equal(reports.filter(entry=>entry.loserCleanup==='unconfirmed').length,2);
 const m=model(),{result,logs}=hedge({id:'while-suspended',run:m.run});
 const value=await result;await tick(5);
 assert.equal(value.exited,false);assert.equal(m.seen.aborted,false);assert.equal(logs[0].suspended,true);
 closers.forEach(close=>close());await tick(5);
 assert.equal(detachedClassifiers(),0);assert.equal(reports.filter(entry=>entry.loserCleanup==='confirmed-late').length,2);
 const again=await hedge({id:'after-recovery',run:model().run}).result;await tick(5);
 assert.equal(again.exited,true);
});
test('requests hedged at the same moment cannot exceed the cap on detached classifiers',async()=>{
 const closers=[];
 const stuck=()=>{let close;const closed=new Promise(resolve=>{close=resolve});closers.push(close);return signal=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>resolve({text:'{"tier":2,"reply":"The model answered."}'}),40);signal.addEventListener('abort',()=>{clearTimeout(timer);const error=new Error('Voice request cancelled; process shutdown could not be confirmed.');error.cleanupUnconfirmed=true;error.closed=closed;reject(error)})})};
 // All three pass the cap check before any of them has adopted a loser.
 const values=await Promise.all(['same-1','same-2','same-3'].map(id=>hedge({id,run:stuck(),classify:async()=>{await tick(5);return decision()}}).result));
 assert.equal(values.filter(value=>value.exited).length,2);assert.equal(detachedClassifiers(),2);
 const waited=values.find(value=>!value.exited);assert.match(waited.output.text,/The model answered/);
 closers.forEach(close=>close());await tick(60);assert.equal(detachedClassifiers(),0);
});
test('shutdown drainage waits for closure within its bound and reports what did not close',async()=>{
 const controller=new AbortController();let close;const pending=new Promise(done=>{close=done});
 adoptDetached('drain-check',pending,controller);assert.equal(controller.signal.aborted,true);assert.equal(detachedClassifiers(),1);
 const started=Date.now(),stuck=await drainDetachedClassifiers({timeoutMs:40});
 assert.deepEqual(stuck,{drained:0,remaining:1});assert.ok(Date.now()-started>=35);assert.equal(detachedClassifiers(),1);
 setTimeout(close,15);
 const waited=await drainDetachedClassifiers({timeoutMs:500});
 assert.deepEqual(waited,{drained:1,remaining:0});assert.equal(detachedClassifiers(),0);
 assert.deepEqual(await drainDetachedClassifiers(),{drained:0,remaining:0});
});
test('shutdown waits for a running classifier that only reports an unconfirmed closure after it is aborted',async()=>{
 let close;const closed=new Promise(resolve=>{close=resolve});
 // Like the adapter: aborted now, rejects later with cleanupUnconfirmed, closes later still.
 const slowToDie=signal=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>setTimeout(()=>{const error=new Error('Voice request cancelled; process shutdown could not be confirmed.');error.cleanupUnconfirmed=true;error.closed=closed;reject(error)},40)));
 const pending=hedge({id:'dies-slowly',config:config('shadow'),run:slowToDie,classify:async()=>decision({route:'tier2',tier:2})}).result.catch(error=>error);
 await tick(5);assert.deepEqual(classifierProcesses(),{running:1,detached:0,total:1});
 setTimeout(close,120);
 const result=await drainDetachedClassifiers({timeoutMs:2000});
 assert.deepEqual(result,{drained:1,remaining:0});assert.deepEqual(classifierProcesses(),{running:0,detached:0,total:0});
 assert.match((await pending).message,/could not be confirmed/);
 // A process that never closes is reported, not waited on forever.
 let finish;const never=hedge({id:'never-dies',config:config('shadow'),run:()=>new Promise(resolve=>{finish=resolve}),classify:async()=>decision({route:'tier2',tier:2})}).result;
 await tick(5);const stuck=await drainDetachedClassifiers({timeoutMs:60});assert.equal(stuck.remaining,1);
 finish({text:JSON.stringify({tier:2,reply:'late'})});await never;await tick(5);assert.equal(classifierProcesses().total,0);
});
test('a loser that is slow to close is one process, counted once',async()=>{
 let close;const slow=signal=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{close=()=>reject(new Error('Voice request cancelled'))}));
 const value=await hedge({id:'slow-loser',run:slow}).result;assert.equal(value.exited,true);
 assert.deepEqual(classifierProcesses(),{running:0,detached:1,total:1});
 const waiting=await drainDetachedClassifiers({timeoutMs:40});assert.deepEqual(waiting,{drained:0,remaining:1});
 close();await tick(5);assert.deepEqual(classifierProcesses(),{running:0,detached:0,total:0});
});
test('a request Jev could not see in full never exits early',async()=>{
 const long='Please research the launch. '.repeat(80)+'Actually do not start anything.';
 const state=jevState({transcript:long});assert.equal(state.flags.transcript_truncated,true);assert.equal(state.transcript.includes('do not start'),false);
 assert.equal(jevState({transcript:'Make a guide.'}).flags.transcript_truncated,false);
 const m=model(),{result,logs}=hedge({run:m.run,state:()=>state});
 const value=await result;await tick(5);
 assert.equal(value.exited,false);assert.equal(m.seen.aborted,false);assert.ok(logs[0].excluded.includes('truncated'));
});
test('a classifier that fails without confirming its shutdown stays owned until it closes',async()=>{
 for(const mode of ['shadow','fastpath']){
  let close;const closed=new Promise(resolve=>{close=resolve}),reports=[];
  const failing=()=>{const error=new Error('Worker timed out after 60 seconds; process shutdown could not be confirmed.');error.cleanupUnconfirmed=true;error.closed=closed;return Promise.reject(error)};
  await assert.rejects(hedge({id:`unconfirmed-${mode}`,config:config(mode),run:failing,classify:async()=>decision({route:'tier2',tier:2}),log:(_r,_i,_b,entry)=>reports.push(entry)}).result,/could not be confirmed/);
  await tick(5);assert.equal(detachedClassifiers(),1,mode);assert.ok(reports.some(entry=>entry.loserCleanup==='unconfirmed'));
  close();await tick(5);assert.equal(detachedClassifiers(),0,mode);assert.ok(reports.some(entry=>entry.loserCleanup==='confirmed-late'));
 }
 assert.equal(adoptUnconfirmed('ordinary-failure',new Error('codex exited 1.')),false);assert.equal(detachedClassifiers(),0);
});
test('cleanup outcomes are delivered to a subscriber, including ones that already happened',async()=>{
 const value=await hedge({id:'cleanup-subscriber',run:model().run}).result;assert.equal(value.exited,true);
 await tick(10);const late=[];value.cleanup(outcome=>late.push(outcome));assert.deepEqual(late,['confirmed']);
 const waiting=await hedge({id:'no-exit',run:model().run,classify:async()=>decision({route:'tier2',tier:2})}).result;assert.equal(waiting.cleanup,null);
});
test('under the test runner the real configuration is never read',()=>{
 assert.ok(process.env.NODE_TEST_CONTEXT,'this guard relies on the Node test runner marker');
 assert.deepEqual(readJevConfig({read:()=>({key:'sk-or-abcdefghijklmnop',mode:'fastpath',theta:0.9})}),{key:'',mode:{codex:'off',claude:'off'},theta:null,deadlineMs:600,tier2kind:false,rulebook:'v1',openVeto:false});
 assert.equal(preconnectJev({request:()=>assert.fail('no network in tests')}),false);
});
test('shadow logging failures never reach the voice request',async()=>{
 const value=await hedge({config:config('shadow'),run:model().run,log:()=>{throw new Error('disk full')}}).result.catch(error=>error);
 await tick(5);assert.equal(value.exited,false);
});

test('configuration fails closed',()=>{
 const read=value=>()=>value;
 assert.deepEqual(readJevConfig({env:{},read:()=>{throw new Error('missing')}}),{key:'',mode:{codex:'off',claude:'off'},theta:null,deadlineMs:600,tier2kind:false,rulebook:'v1',openVeto:false});
 assert.equal(readJevConfig({env:{},read:read({key:'not-a-key',mode:'fastpath'})}).key,'');
 assert.deepEqual(readJevConfig({env:{},read:read({key:'sk-or-abcdefghijklmnop',mode:{codex:'shadow',claude:'launch'}})}).mode,{codex:'shadow',claude:'off'});
 for(const theta of [0.5,1.01,'high',-1])assert.equal(readJevConfig({env:{},read:read({theta})}).theta,null);
 assert.equal(readJevConfig({env:{},read:read({theta:0.93,deadlineMs:50})}).theta,0.93);
 assert.equal(readJevConfig({env:{},read:read({deadlineMs:50})}).deadlineMs,600);
 assert.equal(readJevConfig({env:{AOS_JEV_KEY:'sk-or-from-environment-1',AOS_JEV_MODE:'shadow'},read:read({})}).mode.codex,'shadow');
});
test('the state sent to Jev is minimal and capped at 4 KB',()=>{
 const long='x'.repeat(20000);
 const state=jevState({transcript:long,separateTasks:true,target:{title:long,state:'ready',turns:[{text:long}],secret:'never'},exchanges:Array.from({length:6},()=>({you:long,jarvis:long,pendingSkill:'content-cascade',lookup:{plan:['private']}})),reports:Array.from({length:60},(_,i)=>`report-${i}`)});
 assert.ok(Buffer.byteLength(JSON.stringify(state))<=4096);
 assert.deepEqual(Object.keys(state).sort(),['flags','recent_exchanges','saved_reports','selected_task','transcript']);
 assert.ok(state.recent_exchanges.length<=2);assert.equal(JSON.stringify(state).includes('never'),false);assert.equal(JSON.stringify(state).includes('private'),false);
 assert.equal(state.flags.separate_tasks,true);
});
test('Jev answers are validated before use',()=>{
 const payload=(choice,probabilities,modelName=JEV_REVISION)=>({model:modelName,answers:{route:{type:'choice',choice,probabilities}}});
 assert.equal(parseJevResult(payload('tier3',{tier2:0.1,tier3:0.9})).p,0.9);
 assert.equal(parseJevResult(payload('tier3',{tier2:0.1,tier3:0.9},'typesafe/jev-2')).pinned,false);
 assert.equal(parseJevResult(payload('workflow:weekly-review',null)).skill,'weekly-review');
 assert.throws(()=>parseJevResult(payload('tier4',null)),/Invalid Jev route/);
 assert.throws(()=>parseJevResult(payload('tier3',{tier2:0.6,tier3:0.4})),/distribution/);
 assert.throws(()=>parseJevResult({answers:{}}),/Invalid Jev route/);
 const body=jevRequestBody({transcript:'hello'},{tier2kind:true});
 assert.deepEqual(Object.keys(body.questions),['route','tier2kind']);assert.equal(body.provider.allow_fallbacks,false);
 assert.deepEqual(Object.keys(jevRequestBody({transcript:'hello'}).questions),['route']);
});
function fakeRequest({status=200,body,delay=0,hang=false}){
 return (_options,onResponse)=>{const req=new EventEmitter();req.reusedSocket=true;req.destroyed=false;req.destroy=()=>{req.destroyed=true};
  req.end=()=>{if(hang)return;setTimeout(()=>{if(req.destroyed)return;const response=new EventEmitter();response.statusCode=status;response.resume=()=>{};onResponse(response);response.emit('data',Buffer.from(JSON.stringify(body)));response.emit('end')},delay)};return req};
}
test('the Jev client enforces its deadline, status and cancellation',async()=>{
 const ok={model:JEV_REVISION,answers:{route:{type:'choice',choice:'tier3',probabilities:{tier2:0.05,tier3:0.95}}}};
 const value=await classifyJev({transcript:'make a guide'},{key:'k',request:fakeRequest({body:ok})});
 assert.equal(value.route,'tier3');assert.equal(value.pinned,true);assert.equal(value.socketReused,true);
 await assert.rejects(classifyJev({transcript:'x'},{key:'k',deadlineMs:20,request:fakeRequest({hang:true})}),error=>/Jev deadline/.test(error.message)&&error.ms>=15&&typeof error.socketReused==='boolean');
 await assert.rejects(classifyJev({transcript:'x'},{key:'k',request:fakeRequest({status:429,body:{}})}),/Jev HTTP 429/);
 const controller=new AbortController();const pending=classifyJev({transcript:'x'},{key:'k',signal:controller.signal,request:fakeRequest({hang:true})});controller.abort();
 await assert.rejects(pending,/Jev cancelled/);
});
test('pre-connect is inert when Jev is off and debounced when it is on',()=>{
 let opened=0;const request=()=>{opened++;const req=new EventEmitter();req.end=()=>{};req.destroy=()=>{};return req};
 assert.equal(preconnectJev({config:config('off'),request}),false);assert.equal(preconnectJev({config:config('shadow',{key:''}),request}),false);
 const now=Date.now()+10*60*1000;
 assert.equal(preconnectJev({config:config('shadow'),now,request}),true);assert.equal(preconnectJev({config:config('shadow'),now:now+1000,request}),false);
 assert.equal(opened,1);
});
test('each classifier attempt owns its artifacts; a worker reusing the request ID cannot collide with it',t=>{
 const vault=fs.mkdtempSync(path.join(os.tmpdir(),'voice-jev-artifacts-'));t.after(()=>fs.rmSync(vault,{recursive:true,force:true}));
 const cli={command:'fake-cli',prefix:[]};
 for(const provider of ['codex','claude']){
  const model=provider==='codex'?'gpt-5.6-luna':'haiku';
  const attempt=commandFor(vault,{id:'req-1',artifactId:'req-1.cls.general.1',provider,model},cli);
  const worker=commandFor(vault,{id:'req-1',provider,model,skill:'voice-ask'},cli);
  assert.match(attempt.final,/req-1\.cls\.general\.1\.final\.md$/);assert.match(worker.final,/req-1\.final\.md$/);assert.notEqual(attempt.final,worker.final);
 }
});
test('no unhandled rejections escaped',async()=>{await tick(20);assert.deepEqual(unhandled,[])});

test('the confidence of the second answer is recorded only when it is usable',()=>{
 const payload=(kind,probabilities,extra={})=>({model:JEV_REVISION,answers:{route:{type:'choice',choice:'tier2',probabilities:{tier2:0.9,tier3:0.1}},tier2kind:{type:'choice',choice:kind,...(probabilities?{probabilities}:{}),...extra}}});
 assert.equal(parseJevResult(payload('local-open',{'local-open':0.93,written:0.07})).kp,0.93);
 assert.equal(parseJevResult(payload('local-open',null,{confidence:0.91})).kp,0.91);
 // Not the most probable kind, or an unusable distribution: the kind is recorded, its confidence is not usable.
 for(const broken of [payload('local-open',{'local-open':0.4,written:0.6}),payload('local-open',{'local-open':'high'}),payload('local-open',{written:1}),payload('local-open',null)]){const parsed=parseJevResult(broken);assert.equal(parsed.kind,'local-open');assert.equal(parsed.kp,null);assert.equal(parsed.route,'tier2')}
 assert.equal(parseJevResult(payload('sideways',{sideways:1})).kind,null);
 // Jev has one job. Whatever kind it reports, no configuration gives that kind authority.
 assert.deepEqual(Object.keys(readJevConfig({env:{},read:()=>({labels:{localOpen:'fastpath'},labelTheta:{localOpen:0.9}})})).sort(),['deadlineMs','key','mode','openVeto','rulebook','theta','tier2kind']);
});
