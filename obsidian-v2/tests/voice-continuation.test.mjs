import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {newTaskIntent} from '../shared/new-task-intent.mjs';
import {routeVoice} from '../runner/bridge-core.mjs';
import {writeJson} from '../runner/core.mjs';
import {setCurrent} from '../runner/current-conversations.mjs';

function fixture(t,provider){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-continuation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const selection={provider,model:provider==='codex'?'astra':'sonnet'},calls=[],updates=[],tasks=[];
 const get=id=>{const task=tasks.find(task=>task.id===id);if(!task)throw new Error('Task not found');return task};
 const available=id=>{const task=get(id);if(task.state==='stopped')throw new Error('Resume this terminal before sending a follow-up.');if(task.state!=='ready')throw new Error('This task is working or needs terminal input. Wait for its answer, or type directly in its terminal.');return task};
 const terminals={live:new Map(),list:()=>tasks,get,
  send(id,text){const task=available(id);task.state='working';calls.push({kind:'send',id,text});return task},
  sendWhenFree(id,text){const task=get(id);if(['starting','working'].includes(task.state)){calls.push({kind:'queue',id,text});return task}return this.send(id,text)},
  start(options){const task={id:options.id,...options.selection,title:options.title,state:'working',turns:[]};tasks.push(task);calls.push({kind:'start',...options});return task},
  startWorkflow(options){const direct=['metrics-pull','github-trending'].includes(options.skill);const task={id:options.id,...options.selection,title:options.skill,state:'working',turns:[],execution:direct?'script':'cli',workflow:{job:{skill:options.skill},destination:'fixture.md'}};tasks.push(task);calls.push({kind:'workflow',...options});return task},
  continueWorkflow(id,options){const task=available(id);assert.equal(options.selection.provider,task.provider);assert.equal(options.selection.model,task.model);task.state='working';calls.push({kind:'continue-workflow',id,options});return task}
 };
 const add=(fields={})=>{const task={id:crypto.randomUUID(),...selection,title:'Existing conversation',state:'ready',created:Date.now(),turns:[],...fields};tasks.push(task);if(task.provider===provider)setCurrent(root,terminals,{provider,id:task.id});return task};
 const speak=(transcript,workTarget=null,execute=()=>assert.fail('Expected model-free request'),extra={},options={})=>routeVoice(root,{id:crypto.randomUUID(),transcript,selection,terminalMode:true,workTarget,...extra},undefined,execute,terminals,{resolveCli:()=>({command:'unused-test-cli',prefix:[]}),updateCurrent:value=>updates.push(value),...options});
 const output=(tier=3,tasks)=>async(_root,job,_prompt,options)=>{assert.equal(job.model,provider==='codex'?'luna':'haiku');return{text:JSON.stringify({tier,reply:tier===3?'Working on the request.':'Here is a quick answer.',...(tasks?{tasks}:{})})}};
 return {root,selection,calls,updates,tasks,terminals,add,speak,output};
}

test('explicit destination parser distinguishes instructions from discussion, negation, and quotes',()=>{
 for(const [text,payload,multiple=false] of [
  ['Start a new task',''],['Could you please start a new task?',''],['New conversation.',''],
  ['Start a new task: research RubyGems','research RubyGems'],
  ['Start a new task research RubyGems','research RubyGems'],
  ['New task what does the saved report say?','what does the saved report say?'],
  ['Please start a new task to draft a visual document','draft a visual document'],
  ['Start another task and compare the alternatives','compare the alternatives'],
  ['Create a separate terminal — what is in the saved report?','what is in the saved report?'],
  ['Please research RubyGems in a new task','Please research RubyGems'],
  ['Start separate tasks: research RubyGems and draft a launch email','research RubyGems and draft a launch email',true],
  ['Create two new tasks: research RubyGems and draft a launch email','research RubyGems and draft a launch email',true],
  ['Research RubyGems and draft a launch email in separate tasks','Research RubyGems and draft a launch email',true]
 ])assert.deepEqual(newTaskIntent(text),{payload,multiple},text);
 for(const text of [
  'Do not start a new task','Please don’t start a new task','Can you explain how to start a new task?',
  'Should I start a new task?','What does "start a new task" mean?', 'Say "start a new task"',
  '"Start a new task"','Start a new task is the phrase I use','Start a new task? No, keep this conversation.',
  'Start a new task, actually never mind','If I start a new task, will this one stop?',
  'Write a document titled "Start a new task"','How would I research RubyGems in a new task?'
 ])assert.equal(newTaskIntent(text),null,text);
});

for(const provider of ['codex','claude']){
 test(`${provider}: ambiguous work continues the captured target despite a classifier task breakdown`,async t=>{
  const f=fixture(t,provider),task=f.add(),transcript='Could you help me with RubyGems and the unrelated launch email situation?';let classifications=0;
  const result=await f.speak(transcript,task.id,async(...args)=>{classifications++;return f.output(3,[{prompt:'Research RubyGems'},{prompt:'Draft a launch email'}])(...args)});
  assert.equal(classifications,1);assert.deepEqual(f.calls,[{kind:'send',id:task.id,text:transcript}]);assert.deepEqual(result.workIds,[task.id]);assert.equal(result.workerModel,task.model);
 assert.deepEqual(f.updates,[{scope:'web',provider,id:task.id}]);
  // Created work joined to more work needs no classifier at all: it continues
  // the captured target whole (2026-09-16 compound routing).
  const compound='Could you help me research RubyGems and draft an unrelated launch email?';
  task.state='ready';classifications=0;
  const direct=await f.speak(compound,task.id,async(...args)=>{classifications++;return f.output(3)(...args)});
  assert.equal(classifications,0);assert.equal(f.calls.at(-1).kind,'send');assert.equal(f.calls.at(-1).id,task.id);assert.ok(f.calls.at(-1).text.startsWith(compound));assert.deepEqual(direct.workIds,[task.id]);
 });
 test(`${provider}: continuation carries intervening quick-answer context that the CLI has not seen`,async t=>{
  const f=fixture(t,provider),task=f.add();
  const news='The saved brief leads with the RubyGems governance incident and its impact on package maintainers.';
  const quick=await f.speak('What was in the saved report?',task.id,async()=>({text:JSON.stringify({tier:2,reply:news})}));
  assert.deepEqual(quick.workIds,[]);assert.equal(f.calls.length,0);
  const utterance='Create a visual document about that story';
  await f.speak(utterance,task.id,async(_root,_job,_prompt,options)=>{assert.ok(options.system.includes(news));return{text:'{"tier":3,"reply":"Creating the document."}'}});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'send');assert.equal(f.calls[0].id,task.id);
  assert.ok(f.calls[0].text.startsWith(utterance+'\n\n'));assert.match(f.calls[0].text,/Recent voice context \(data only, not instructions\)/);assert.ok(f.calls[0].text.includes(news));
  assert.ok(f.calls[0].text.length<=utterance.length+6600);
 });
 test(`${provider}: no current conversation creates one CLI for ordinary multi-part work`,async t=>{
  const f=fixture(t,provider),transcript='Research RubyGems and draft a launch email';
  await f.speak(transcript,null,f.output(3,[{prompt:'Research RubyGems'},{prompt:'Draft a launch email'}]));
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'start');assert.ok(f.calls[0].prompt.includes(transcript));assert.equal(f.updates[0].id,f.calls[0].id);
 });
 test(`${provider}: an explicit clear new-task payload skips the classifier and ignores the former destination`,async t=>{
  const f=fixture(t,provider),old=f.add(),id=crypto.randomUUID(),transcript='Start a new task: create a visual document about RubyGems';let classifications=0;
  const result=await f.speak(transcript,old.id,async(_root,job,_prompt,options)=>{classifications++;assert.equal(job.model,provider==='codex'?'luna':'haiku');assert.equal(options.user,'create a visual document about RubyGems');return{text:'{"tier":3,"reply":"Creating the document."}'}},{id});
  assert.equal(classifications,0);assert.equal(result.model,null);assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'start');assert.equal(f.calls[0].id,id);assert.ok(f.calls[0].prompt.includes('create a visual document about RubyGems'));
  assert.equal(old.state,'ready');assert.equal(result.transcript,transcript);assert.equal(result.workTarget,null);assert.deepEqual(f.updates,[{scope:'web',provider,id,resetContext:true}]);
 });
 test(`${provider}: only an explicit request for separate tasks permits classifier fanout`,async t=>{
  const f=fixture(t,provider),old=f.add();
  await f.speak('Start separate tasks: research RubyGems and draft a launch email',old.id,f.output(3,[{prompt:'Research RubyGems'},{prompt:'Draft a launch email'}]));
  assert.equal(f.calls.length,2);assert.ok(f.calls.every(call=>call.kind==='start'));assert.equal(old.state,'ready');assert.equal(f.updates.length,1);assert.equal(f.updates[0].id,f.calls[0].id);
 });
 test(`${provider}: standalone new task clears selection without an empty PTY or accepting an old offer`,async t=>{
  const f=fixture(t,provider),missing=crypto.randomUUID(),id=crypto.randomUUID();
  writeJson(f.root,'system/v2/voice-results/offer.json',{ts:Date.now()-1000,provider,transcript:'Tell me more about RubyGems',reply:'Want me to research RubyGems?',workTarget:missing});
  const result=await f.speak('Start a new task',missing,undefined,{id});
  assert.equal(result.currentReset,true);assert.match(result.reply,/What would you like me to work on/);assert.deepEqual(result.workIds,[]);assert.equal(f.calls.length,0);assert.deepEqual(f.updates,[{scope:'web',provider,id:null}]);
  await f.speak('Start a new task',missing,undefined,{id});assert.equal(f.updates.length,1,'Receipt replay cannot overwrite a later current selection');
 });
 test(`${provider}: quick answers work with stale targets and explicit new quick requests reset without dispatch`,async t=>{
  const f=fixture(t,provider),missing=crypto.randomUUID();
  const ready=await f.speak('Is the worker online?',missing);assert.equal(ready.currentReset,undefined);assert.equal(f.calls.length,0);assert.equal(f.updates.length,0);
  const answer=await f.speak('What else can you say about the saved RubyGems report?',missing,f.output(2));assert.equal(answer.tier,2);assert.deepEqual(answer.workIds,[]);
  const reset=await f.speak('Start a new task: is the worker online?',missing);assert.equal(reset.currentReset,true);assert.equal(f.calls.length,0);assert.deepEqual(f.updates,[{scope:'web',provider,id:null}]);
 });
 test(`${provider}: discussion and negation do not clear the selected conversation`,async t=>{
  const f=fixture(t,provider),task=f.add();
  for(const transcript of ['Do not start a new task; just explain the report.','What does "start a new task" do?']){
   const result=await f.speak(transcript,task.id,f.output(2));assert.equal(result.currentReset,undefined);assert.equal(result.workTarget,task.id);
  }
  assert.equal(f.calls.length,0);assert.equal(f.updates.length,0);
 });
 test(`${provider}: busy, stopped, missing, and foreign conversations never create a replacement`,async t=>{
  const f=fixture(t,provider);
  for(const state of ['working','needs input','stopped']){
   const task=f.add({state});await assert.rejects(f.speak('Research RubyGems',task.id,f.output()),/working or needs terminal input|Resume this terminal/);
  }
  await assert.rejects(f.speak('Research RubyGems',crypto.randomUUID(),f.output()),/conversation is unavailable/);
  const foreign=f.add({provider:provider==='codex'?'claude':'codex'});await assert.rejects(f.speak('Research RubyGems',foreign.id,f.output()),/different provider/);
  assert.equal(f.calls.length,0);assert.equal(f.updates.length,0);
 });
 test(`${provider}: workflow continuation uses the guarded workflow method and current model`,async t=>{
  const f=fixture(t,provider),task=f.add({model:provider==='codex'?'luna':'opus'}),id=crypto.randomUUID();
  const result=await f.speak('Run the weekly review',task.id,undefined,{id});
  assert.deepEqual(f.calls,[{kind:'continue-workflow',id:task.id,options:{id,selection:{provider,model:task.model},skill:'weekly-review',args:{}}}]);
  assert.equal(result.workerModel,task.model);assert.deepEqual(result.workIds,[task.id]);assert.deepEqual(f.updates,[{scope:'web',provider,id:task.id}]);
 });
 test(`${provider}: direct source scripts do not consume or replace the current CLI`,async t=>{
  const f=fixture(t,provider),task=f.add();const result=await f.speak('Pull metrics',task.id);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'workflow');assert.equal(f.calls[0].skill,'metrics-pull');assert.equal(task.state,'ready');assert.equal(result.currentReset,undefined);assert.equal(f.updates.length,0);
 });
 test(`${provider}: canceled or failed new-task classification preserves the existing current selection`,async t=>{
  const f=fixture(t,provider),task=f.add(),controller=new AbortController();
  await assert.rejects(f.speak('Start a new task: could you help me research RubyGems?',task.id,async()=>{throw Error('Classifier unavailable')}),/Classifier unavailable/);
  await assert.rejects(routeVoice(f.root,{id:crypto.randomUUID(),transcript:'Start a new task: could you help me research RubyGems?',selection:f.selection,terminalMode:true,workTarget:task.id},controller.signal,async()=>{controller.abort();return{text:'{"tier":3,"reply":"Working."}'}},f.terminals,{resolveCli:()=>({command:'unused-test-cli',prefix:[]}),updateCurrent:value=>f.updates.push(value)}),/cancelled/);
  assert.equal(f.calls.length,0);assert.equal(f.updates.length,0);
 });
 test(`${provider}: successful continuation receipt prevents duplicate sends even if current persistence fails`,async t=>{
  const f=fixture(t,provider),task=f.add(),id=crypto.randomUUID(),transcript='Research RubyGems';
  await assert.rejects(f.speak(transcript,task.id,f.output(),{id},{updateCurrent:()=>{throw Error('Selection write failed')}}),/Selection write failed/);
  assert.equal(f.calls.length,1);const replay=await f.speak(transcript,task.id,undefined,{id});assert.deepEqual(replay.workIds,[task.id]);assert.equal(f.calls.length,1);assert.equal(f.updates.length,0);
 });
}

// Chase's call, 2026-11-23: a one-pager was being written when he asked twice for an inbox brief. Both were
// classified correctly and then refused, because the task the call had just started was the selected
// conversation and it was busy. He heard "Say that again in a moment." each time.
for(const provider of ['codex','claude']){
 test(`${provider}: on a call, a named workflow asked for while the selected task works starts on its own`,async t=>{
  const f=fixture(t,provider),live={transport:'live',liveCallId:crypto.randomUUID()};
  for(const state of ['working','needs input','starting']){
   const task=f.add({state}),before=f.calls.length;
   const result=await f.speak('Run the weekly review',task.id,f.output(),live);
   assert.equal(f.calls.length,before+1,state);
   assert.equal(f.calls.at(-1).kind,'workflow',state);assert.equal(f.calls.at(-1).skill,'weekly-review');
   assert.equal(result.action,'task');assert.notDeepEqual(result.workIds,[task.id],'the busy conversation is not the one doing it');
   assert.equal(result.reply,'Running Weekly Review on its own while that task finishes.');
   assert.equal(task.state,state,'the busy conversation is left exactly as it was');
   assert.equal(f.updates.some(update=>update.id===result.workIds[0]),false,'the selection stays on the task the caller was on');
  }
  // A conversation that is free still takes the workflow, on a call as off one.
  const free=f.add({state:'ready'});
  await f.speak('Run the weekly review',free.id,f.output(),live);
  assert.equal(f.calls.at(-1).kind,'continue-workflow');assert.equal(f.calls.at(-1).id,free.id);
 });
 test(`${provider}: off a call, and for a free-form request on one, a busy conversation still gets no replacement`,async t=>{
  const f=fixture(t,provider),live={transport:'live',liveCallId:crypto.randomUUID()};
  const busy=f.add({state:'working'});
  await assert.rejects(f.speak('Run the weekly review',busy.id,f.output()),/working or needs terminal input/);
  assert.equal(f.calls.length,0);
  // On a call a follow-up that points back at the busy task waits for it. Still no replacement.
  const held=await f.speak('Make it shorter and punchier',busy.id,f.output(),live);
  assert.deepEqual(f.calls.map(call=>call.kind),['queue']);assert.equal(f.calls[0].id,busy.id);assert.match(f.calls[0].text,/^Make it shorter and punchier/);
  assert.deepEqual(held.workIds,[busy.id]);assert.equal(held.reply,"Got it. I'll add that as soon as that task is free.");
  assert.equal(f.tasks.length,1,'no new conversation was made');
  // A follow-up to one that is waiting for an approval takes nothing, on a call or off it.
  const approval=f.add({state:'needs input'});
  await assert.rejects(f.speak('Make it shorter',approval.id,f.output(),live),/working or needs terminal input/);
 });
 // Chase, 2026-11-26: Live is the orchestrator. New work asked for while the selected task is busy starts beside it.
 test(`${provider}: on a call, new work asked for while the selected task is busy starts as its own task`,async t=>{
  const f=fixture(t,provider),live={transport:'live',liveCallId:crypto.randomUUID()};
  for(const state of ['working','starting','needs input']){
   const busy=f.add({state}),before=f.calls.length;
   const result=await f.speak("And hey, while you're doing that, can you give me a quick one-pager on this Opus 5.6 stuff",busy.id,f.output(),live);
   assert.equal(f.calls.length,before+1,state);assert.equal(f.calls.at(-1).kind,'start',state);
   assert.notDeepEqual(result.workIds,[busy.id]);assert.equal(busy.state,state,'the busy task is left as it was');
   assert.equal(result.reply,'Starting that on its own while that task finishes.');
   assert.equal(f.updates.at(-1)?.id,result.workIds[0],'the new task is what the caller is now talking about');
  }
  // Off a call nothing changes: the busy conversation still refuses.
  const busy=f.add({state:'working'});
  await assert.rejects(f.speak('Research RubyGems',busy.id,f.output()),/working or needs terminal input/);
 });
}

// A call starts fresh: the first thing said on it does not reopen a conversation that was stopped before the call.
for(const provider of ['codex','claude']){
 test(`${provider}: a call does not reopen a conversation stopped before it, but keeps using one of its own`,async t=>{
  const f=fixture(t,provider),live={transport:'live',liveCallId:crypto.randomUUID()};
  for(const state of ['stopped','error']){
   const old=f.add({state}),before=f.calls.length;
   const result=await f.speak('Make me a one page explainer of how black holes form',old.id,f.output(),live);
   assert.equal(f.calls.length,before+1,state);assert.equal(f.calls.at(-1).kind,'start',state);
   assert.notDeepEqual(result.workIds,[old.id]);assert.equal(old.state,state,'the earlier conversation is left as it was');
  }
  // The same stopped conversation, when this call is the one that used it, is still continued.
  const own=f.add({state:'ready'});own.state='ready';
  await f.speak('Make it shorter',own.id,f.output(),{...live,liveTaskIds:[own.id]});
  assert.equal(f.calls.at(-1).kind,'send');assert.equal(f.calls.at(-1).id,own.id);
  // An open conversation the caller has selected is used, as before.
  const open=f.add({state:'ready'});
  await f.speak('Tighten the introduction',open.id,f.output(),live);
  assert.equal(f.calls.at(-1).kind,'send');assert.equal(f.calls.at(-1).id,open.id);
 });
}

// Chase's call, 2026-11-24: "What's going on? Why is this taking so long" was handed to the working task it asked
// about and answered "I'll add that as soon as that task is free". A status question on a call is answered from the tasks.
for(const provider of ['codex','claude']){
 test(`${provider}: on a call, a question about work under way is answered from the tasks and starts nothing`,async t=>{
  const f=fixture(t,provider),live={transport:'live',liveCallId:crypto.randomUUID()},now=Date.now();
  const page=f.add({state:'working',title:'Build me a one-pager on the Riemann hypothesis',created:now-3*60000-5000});
  const brief=f.add({state:'ready',title:'inbox brief',workflow:{job:{skill:'inbox-brief'},destination:'brief.md'},workflowStatus:'ok',created:now-200000,turns:[{id:'t1',ts:now-1000,text:'Done.'}]});
  const unrelated=f.add({state:'ready',title:'Something from yesterday',created:now-86400000,turns:[{id:'t0',ts:now-80000000,text:'Done.'}]});
  const mine={...live,liveTaskIds:[page.id,brief.id]};
  // No model is asked (the default executor fails the test), nothing is sent, queued or started.
  const result=await f.speak("What's going on? Why is this taking so long",page.id,undefined,mine);
  assert.equal(f.calls.length,0);assert.equal(result.action,'reply');assert.deepEqual(result.workIds,[]);
  assert.equal(result.reply,'Your request “Build me a one-pager on the Riemann hypothesis” is still running, 3 min in. Inbox Brief is done.');
  assert.equal(result.decision.rule,'router.taskStatus');assert.doesNotMatch(result.reply,/yesterday/,'only what is running or what this call started');
  // Waiting for an approval comes first; a conversation on a follow-up gives no misleading age, and says what is waiting.
  page.state='needs input';
  const follow=f.add({state:'working',title:'Draft the launch post',created:now-3600000,turns:[{id:'t2',ts:now-120000,text:'Draft ready.'}],queuedFollowups:1});
  const second=await f.speak('Hey, where are we at with all that',follow.id,undefined,{...mine,liveTaskIds:[page.id,brief.id,follow.id]});
  assert.equal(second.reply,'Your request “Build me a one-pager on the Riemann hypothesis” needs your OK. It’s in the terminal tray. Your request “Draft the launch post” is still working on your follow-up. One more request is waiting behind it. Inbox Brief is done.');
  assert.equal(f.calls.length,0);
 });
 test(`${provider}: a status question with nothing to report, one that also asks for something, and one off a call all go on as before`,async t=>{
  const f=fixture(t,provider),live={transport:'live',liveCallId:crypto.randomUUID()};
  // Nothing is running and this call started nothing: the question is the model's to answer.
  const idle=f.add({state:'ready',turns:[{id:'t0',ts:1,text:'Done.'}]});
  const asked=await f.speak('How are things going',null,f.output(2),live);
  assert.equal(asked.reply,'Here is a quick answer.');assert.notEqual(asked.decision.rule,'router.taskStatus');
  // The short forms keep their own answer.
  assert.equal((await f.speak('Is it done yet',null,undefined,live)).reply,'Nothing is running right now.');
  // "Is it done? Open it" asks for something, so it is a request.
  const busy=f.add({state:'working'});
  const both=await f.speak('Is it done? Then add a summary at the top',busy.id,f.output(),live);
  assert.notEqual(both.decision.rule,'router.taskStatus');assert.deepEqual(f.calls.map(call=>call.kind),['queue']);
  // Off a call nothing changed: the same words are still routed by the model.
  await assert.rejects(f.speak('Why is this taking so long',busy.id,f.output()),/working or needs terminal input/);
  assert.equal(idle.state,'ready');
 });
}
