import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {routeVoice} from '../runner/bridge-core.mjs';
import {setCurrent} from '../runner/current-conversations.mjs';
import {JEV_REVISION,detachedClassifiers} from '../runner/jev.mjs';

const unhandled=[];process.on('unhandledRejection',error=>unhandled.push(error));
const tick=(ms=0)=>new Promise(resolve=>setTimeout(resolve,ms));
const tier3=(p=0.97)=>({route:'tier3',tier:3,skill:null,p,kind:null,revision:JEV_REVISION,pinned:true,ms:4,socketReused:true});
const tier2=()=>({...tier3(0.96),route:'tier2',tier:2});
const workflow=skill=>({...tier3(0.96),route:`workflow:${skill}`,tier:1,skill});

function fixture(t,provider='codex'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-jev-parity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const selection={provider,model:provider==='codex'?'gpt-6-astra':'sonnet'},calls=[],tasks=[],shadow=[];
 const get=id=>{const task=tasks.find(task=>task.id===id);if(!task)throw new Error('Task not found');return task};
 const terminals={live:new Map(),list:()=>tasks,get,
  send(id,text){const task=get(id);task.state='working';calls.push({kind:'send',to:task.title,text});return task},
  start(options){const task={id:options.id,...options.selection,title:options.title,state:'working',turns:[]};tasks.push(task);calls.push({kind:'start',prompt:options.prompt,title:options.title,model:options.selection.model});return task},
  startWorkflow(options){const task={id:options.id,...options.selection,title:options.skill,state:'working',turns:[],workflow:{job:{skill:options.skill},destination:'fixture.md'}};tasks.push(task);calls.push({kind:'workflow',skill:options.skill,args:options.args});return task},
  continueWorkflow(id,options){const task=get(id);task.state='working';calls.push({kind:'continue-workflow',to:task.title,skill:options.skill,args:options.args});return task}};
 const add=(fields={})=>{const task={id:crypto.randomUUID(),...selection,title:'Sample visual guide',state:'ready',created:Date.now(),turns:[{text:'Saved the visual guide.',ts:Date.now()}],...fields};tasks.push(task);if(task.provider===provider)setCurrent(root,terminals,{provider,id:task.id});return task};
 return {root,selection,calls,tasks,terminals,add,shadow};
}
// Behaves like executeCli: answers late and rejects as soon as it is aborted.
const model=(answer,seen={})=>(_root,job,_prompt,options)=>new Promise((resolve,reject)=>{
 seen.calls=(seen.calls||0)+1;seen.artifactId=job.artifactId;
 const timer=setTimeout(()=>resolve({text:JSON.stringify(typeof answer==='function'?answer(options.user):answer)}),30);
 const stop=()=>{clearTimeout(timer);seen.aborted=true;reject(new Error('Voice request cancelled'))};
 if(options.signal?.aborted)stop();else options.signal?.addEventListener('abort',stop,{once:true});
});
const jevOptions=(fx,answer,fields={})=>({config:{key:'sk-or-test-key-000000',mode:{codex:'fastpath',claude:'fastpath'},theta:0.9,deadlineMs:600,tier2kind:false,...fields},classify:async state=>typeof answer==='function'?answer(state):answer,log:(_r,_i,_b,entry)=>fx.shadow.push(entry)});
const offConfig={config:{key:'',mode:{codex:'off',claude:'off'},theta:null,deadlineMs:600,tier2kind:false},classify:()=>assert.fail('Jev must not be consulted when it is off'),log:()=>assert.fail('nothing is recorded when Jev is off')};
const speak=(fx,transcript,{execute,jev,workTarget=null,signal,id=crypto.randomUUID(),extra={}}={})=>routeVoice(fx.root,{id,transcript,selection:fx.selection,terminalMode:true,workTarget,...extra},signal,execute,fx.terminals,{resolveCli:()=>({command:'unused-test-cli',prefix:[]}),updateCurrent:()=>{},...(jev?{jev}:{})});
const outcome=(receipt,{acknowledgment=false}={})=>({tier:receipt.tier,action:receipt.action,skill:receipt.skill,workerModel:receipt.workerModel,pendingSkill:receipt.pendingSkill||null,obsidian:receipt.obsidian,deliverable:receipt.deliverable,work:receipt.workIds.length,
 reply:acknowledgment&&receipt.action==='task'?'<acknowledgment>':receipt.reply});
// Runs the same conversation with Jev off, in shadow and with the fast path on.
// Shadow must always match off: it has no authority.
async function both(t,steps,{provider='codex',selected=false,acknowledgment=false}={}){
 const runs={};
 for(const mode of ['off','shadow','fastpath']){
  const fx=fixture(t,provider),target=selected?fx.add():null,receipts=[];
  for(const step of steps){
   const seen={};
   receipts.push({seen,receipt:await speak(fx,step.say,{execute:model(step.model,seen),workTarget:target?.id||null,jev:mode==='off'?offConfig:jevOptions(fx,step.jev,{mode:{codex:mode,claude:mode}})})});
   await tick(5);
  }
  runs[mode]={fx,receipts,calls:fx.calls,outcomes:receipts.map(item=>outcome(item.receipt,{acknowledgment}))};
 }
 assert.deepEqual(runs.shadow.calls,runs.off.calls,'shadow changed what was dispatched');
 assert.deepEqual(runs.shadow.outcomes.map(item=>({...item,reply:item.action==='task'?'<acknowledgment>':item.reply})),runs.off.outcomes.map(item=>({...item,reply:item.action==='task'?'<acknowledgment>':item.reply})),'shadow changed an outcome');
 assert.ok(runs.shadow.receipts.every(item=>item.receipt.decision.source!=='jev'&&!item.seen.aborted),'shadow exercised authority');
 return runs;
}

// T2a — excluded cases: Jev has no authority, even when confidently wrong.
test('T2a two separate tasks keep their model breakdown under an adversarial Jev',async t=>{
 const tasks=[{title:'RubyGems',prompt:'research RubyGems'},{title:'Launch email',prompt:'draft a launch email'}];
 const runs=await both(t,[{say:'Start separate tasks: research RubyGems and draft a launch email',model:{tier:3,reply:'Working on both.',tasks},jev:tier3(0.99)}],{acknowledgment:true});
 assert.equal(runs.off.calls.filter(call=>call.kind==='start').length,2);
 assert.deepEqual(runs.fastpath.calls,runs.off.calls);assert.deepEqual(runs.fastpath.outcomes,runs.off.outcomes);
 assert.equal(runs.fastpath.receipts[0].receipt.decision.source,'model');assert.ok(runs.fastpath.fx.shadow[0].excluded.includes('separateTasks'));
});
test('T2a a URL supplied after a workflow clarification completes that workflow under an adversarial Jev',async t=>{
 const runs=await both(t,[
  {say:'The Content Cascade workflow is what I want you to execute, but I have not supplied a URL yet.',model:{tier:1,skill:'content-cascade',reply:'On it.'},jev:workflow('content-cascade')},
  {say:'Here it is: https://example.com/article-123',model:{tier:1,skill:'content-cascade',args:{url:'https://example.com/article-123'},reply:'Starting content cascade.'},jev:tier3(0.99)}],{acknowledgment:true});
 assert.equal(runs.off.outcomes[0].pendingSkill,'content-cascade');
 assert.deepEqual(runs.off.calls,[{kind:'workflow',skill:'content-cascade',args:{url:'https://example.com/article-123'}}]);
 assert.deepEqual(runs.fastpath.calls,runs.off.calls);assert.deepEqual(runs.fastpath.outcomes,runs.off.outcomes);
 assert.ok(runs.fastpath.fx.shadow.at(-1).excluded.includes('pendingSkill'));
});
test('T2a an accepted information offer can never become work, whatever Jev and the model say',async t=>{
 const runs=await both(t,[
  {say:'What is the exact attendance count for the design meetup?',model:{tier:2,reply:"I don't have that count. Want me to explain the RubyGems incident?"},jev:tier2()},
  {say:'Yes.',model:{tier:3,reply:'Working on that.'},jev:tier3(0.99)}]);
 assert.deepEqual(runs.off.calls,[]);assert.deepEqual(runs.fastpath.calls,[]);
 assert.deepEqual(runs.fastpath.outcomes,runs.off.outcomes);
});

// T2b — eligible routes with a correct Jev: same effects, faster.
test('T2b new general work dispatches identically and is attributed to Jev',async t=>{
 const runs=await both(t,[{say:'What I need next is a one-page guide comparing solar and wind power.',model:{tier:3,reply:'Working on the guide.'},jev:tier3()}],{acknowledgment:true});
 assert.equal(runs.off.calls.length,1);assert.equal(runs.off.calls[0].kind,'start');
 assert.deepEqual(runs.fastpath.calls,runs.off.calls);assert.deepEqual(runs.fastpath.outcomes,runs.off.outcomes);
 const off=runs.off.receipts[0],fast=runs.fastpath.receipts[0];
 assert.equal(off.receipt.decision.source,'model');assert.equal(off.receipt.decision.rule,'model.general');assert.equal(off.seen.aborted,undefined);
 assert.equal(fast.receipt.decision.source,'jev');assert.equal(fast.receipt.decision.rule,'jev.earlyExit');assert.equal(fast.seen.aborted,true);
 assert.deepEqual(fast.receipt.decision.rawIntent,{tier:3});assert.deepEqual(fast.receipt.decision.guarded,{tier:3});assert.deepEqual(fast.receipt.decision.effects,['start']);
 assert.equal(fast.receipt.decision.jev.route,'tier3');assert.equal(fast.receipt.decision.fallbackModel,null);assert.equal(off.receipt.decision.fallbackModel,'gpt-5.6-luna');
 assert.ok(fast.receipt.reply.trim());assert.notEqual(fast.receipt.reply,'Working on that.');
 assert.match(fast.seen.artifactId,/\.cls\.general\.1$/);assert.equal(detachedClassifiers(),0);
});
test('T2b a revision for the selected conversation reaches that same worker',async t=>{
 for(const provider of ['codex','claude']){
  const runs=await both(t,[{say:"I'm not happy with the illustration's robot. Please replace it with a friendlier robot.",model:{tier:3,reply:'Continuing the selected work.'},jev:tier3()}],{provider,selected:true,acknowledgment:true});
  assert.equal(runs.off.calls.length,1);assert.equal(runs.off.calls[0].kind,'send');assert.equal(runs.off.calls[0].to,'Sample visual guide');
  assert.deepEqual(runs.fastpath.calls,runs.off.calls);assert.deepEqual(runs.fastpath.outcomes,runs.off.outcomes);
  assert.equal(runs.fastpath.receipts[0].receipt.decision.source,'jev');
 }
});
test('T2b a quick answer waits for the model and is unchanged',async t=>{
 const runs=await both(t,[{say:'How many revised mockups did I say were ready?',model:{tier:2,reply:'You said three revised mockups were ready.'},jev:tier2()}]);
 assert.deepEqual(runs.fastpath.calls,[]);assert.deepEqual(runs.fastpath.outcomes,runs.off.outcomes);
 assert.equal(runs.fastpath.outcomes[0].reply,'You said three revised mockups were ready.');
 assert.equal(runs.fastpath.receipts[0].receipt.decision.source,'model');assert.equal(runs.fastpath.receipts[0].receipt.decision.jev.route,'tier2');
 assert.equal(runs.fastpath.receipts[0].seen.aborted,undefined);
});
test('T2b a Jev outage costs nothing',async t=>{
 const runs=await both(t,[{say:'What I need next is a one-page guide comparing solar and wind power.',model:{tier:3,reply:'Working on the guide.'},jev:()=>{throw new Error('Jev HTTP 503')}}],{acknowledgment:true});
 assert.deepEqual(runs.fastpath.calls,runs.off.calls);assert.equal(runs.fastpath.receipts[0].receipt.decision.source,'model');assert.match(runs.fastpath.receipts[0].receipt.decision.jev.error,/503/);
});
test('T2b cancelling while Jev is pending dispatches nothing',async t=>{
 const fx=fixture(t),controller=new AbortController();
 const pending=speak(fx,'What I need next is a one-page guide comparing solar and wind power.',{signal:controller.signal,execute:model({tier:3,reply:'Working.'}),jev:jevOptions(fx,async()=>{await tick(20);return tier3()})});
 await tick(5);controller.abort();
 await assert.rejects(pending,/cancelled/i);await tick(40);assert.deepEqual(fx.calls,[]);
});
test('T2b a repeated request ID never dispatches twice',async t=>{
 const fx=fixture(t),id=crypto.randomUUID(),say='What I need next is a one-page guide comparing solar and wind power.';
 const first=await speak(fx,say,{id,execute:model({tier:3,reply:'Working.'}),jev:jevOptions(fx,tier3())});
 const second=await speak(fx,say,{id,execute:()=>assert.fail('a saved receipt must answer'),jev:jevOptions(fx,()=>assert.fail('Jev must not be asked again'))});
 assert.equal(fx.calls.length,1);assert.deepEqual(second.workIds,first.workIds);
});

// T2c — eligible route, wrong Jev. Parity is not expected: accuracy is the
// qualification gate's job. Guards must still hold and the receipt must say who decided.
test('T2c a wrong confident Jev is attributable, and downstream guards still hold',async t=>{
 const runs=await both(t,[{say:'How many revised mockups did I say were ready?',model:{tier:2,reply:'You said three revised mockups were ready.'},jev:tier3(0.99)}]);
 assert.deepEqual(runs.off.calls,[]);assert.equal(runs.fastpath.calls.length,1);
 const receipt=runs.fastpath.receipts[0].receipt;
 assert.equal(receipt.decision.source,'jev');assert.equal(receipt.decision.rule,'jev.earlyExit');assert.deepEqual(receipt.decision.effects,['start']);
 // The worker still receives the words as spoken, so it can simply answer.
 assert.match(runs.fastpath.calls[0].prompt,/How many revised mockups did I say were ready\?/);
 // A conversation that belongs to the other provider: the same rejection, and nothing dispatched, with or without Jev.
 const attempt=async(useJev,answer)=>{const fx=fixture(t,'codex'),other=fx.add({provider:'claude',model:'sonnet',title:'Claude conversation',turns:[{text:'PRIVATE CLAUDE RESULT',ts:Date.now()}]});const sent=[];
  const error=await speak(fx,'How many revised mockups did I say were ready?',{workTarget:other.id,execute:model(answer),jev:useJev?jevOptions(fx,state=>{sent.push(state);return tier3(0.99)}):offConfig}).then(()=>null,failure=>failure);return {fx,error,sent}};
 const baseline=await attempt(false,{tier:3,reply:'Working.'}),fast=await attempt(true,{tier:2,reply:'Three.'});
 assert.match(baseline.error?.message||'',/different provider/);assert.equal(fast.error?.message,baseline.error.message);
 assert.deepEqual(baseline.fx.calls,[]);assert.deepEqual(fast.fx.calls,[]);
 // (3) its content never reaches Jev, only that a conversation is selected.
 assert.equal(fast.sent.length,1);assert.equal(JSON.stringify(fast.sent[0]).includes('PRIVATE CLAUDE RESULT'),false);assert.equal(fast.sent[0].selected_task.title,'Claude conversation');
});

test('the loser\'s cleanup outcome reaches the saved receipt',async t=>{
 const fx=fixture(t),id=crypto.randomUUID();
 const receipt=await speak(fx,'What I need next is a one-page guide comparing solar and wind power.',{id,execute:model({tier:3,reply:'Working.'}),jev:jevOptions(fx,tier3())});
 assert.equal(receipt.decision.source,'jev');await tick(20);
 const saved=JSON.parse(fs.readFileSync(path.join(fx.root,'system/v2/voice-results',`${id}.json`),'utf8'));
 assert.equal(saved.decision.loserCleanup,'confirmed');assert.equal(saved.decision.rule,'jev.earlyExit');assert.deepEqual(saved.workIds,receipt.workIds);
});
test('a model-written lookup answer is attributed to the model, not to rules',async t=>{
 const fx=fixture(t);
 const receipt=await speak(fx,'Here it is: https://example.com/story',{execute:model({tier:2,reply:'The saved brief has no story at that address.'}),jev:offConfig});
 assert.equal(receipt.decision.boundary,'lookup-explain');assert.equal(receipt.decision.source,'model');assert.equal(receipt.decision.rule,'lookup.explain');assert.equal(receipt.decision.fallbackModel,'gpt-5.6-luna');
});
test('more adversarial follow-ups stay identical with Jev confidently wrong',async t=>{
 // "Never mind" after a workflow clarification; a stale affirmation with no offer to accept.
 const runs=await both(t,[
  {say:'The Content Cascade workflow is what I want you to execute, but I have not supplied a URL yet.',model:{tier:1,skill:'content-cascade',reply:'On it.'},jev:workflow('content-cascade')},
  {say:'Never mind.',model:{tier:2,reply:'Okay.'},jev:tier3(0.99)},
  {say:'Yes, do that.',model:{tier:2,reply:'What would you like me to go ahead with?'},jev:tier3(0.99)}]);
 assert.deepEqual(runs.off.calls,[]);assert.deepEqual(runs.fastpath.calls,[]);assert.deepEqual(runs.fastpath.outcomes,runs.off.outcomes);
});
test('everyday declines are answered by the exact-phrase rule and never reach a classifier',async t=>{
 const fx=fixture(t);fx.add();
 for(const say of ["No, that's okay.",'No that’s fine','Nah, I\'m good for now.','I\'m good','no thats ok jarvis']){
  const receipt=await speak(fx,say,{workTarget:fx.tasks[0].id,execute:()=>assert.fail(`a model was called for: ${say}`),jev:jevOptions(fx,()=>assert.fail(`Jev was asked about: ${say}`))});
  assert.equal(receipt.decision.rule,'router.decline',say);assert.equal(receipt.reply,'Standing by.');
 }
 assert.deepEqual(fx.calls,[]);
 // Not declines: an acceptance-shaped phrase and a real request that merely starts with "no".
 for(const say of ["That's fine.",'No problem, write the summary and keep it short.']){
  let asked=0;await speak(fx,say,{execute:model({tier:2,reply:'Okay.'},{}),jev:jevOptions(fx,()=>{asked++;return tier2()})}).catch(()=>{});
  assert.equal(asked,1,say);
 }
});
test('provenance is recorded for rules and front-door decisions, and the request origin is kept',async t=>{
 const fx=fixture(t);
 const status=await speak(fx,'Worker status.',{extra:{origin:'test'}});
 assert.equal(status.decision.boundary,'front-door');assert.equal(status.decision.rule,'frontdoor.direct');assert.equal(status.origin,'test');
 const work=await speak(fx,'Build a one-page guide to solar power.');
 assert.equal(work.decision.rule,'router.directGeneralWork');assert.equal(work.decision.source,'rules');assert.deepEqual(work.decision.effects,['start']);assert.equal(work.origin,'live');
 const decline=await speak(fx,'No thanks.');
 assert.equal(decline.decision.rule,'router.decline');assert.deepEqual(decline.decision.effects,['reply']);
});
test('no unhandled rejections escaped',async()=>{await tick(40);assert.deepEqual(unhandled,[]);assert.equal(detachedClassifiers(),0)});
