import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {classifyVoice,invalidateVoiceSnapshot} from '../runner/voice-router.mjs';
import {writeJson} from '../runner/core.mjs';
import {setCurrent,readConversationEpoch} from '../runner/current-conversations.mjs';
import {localDate} from '../runner/brief-voice.mjs';

function fixture(t,provider,appScope){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-expired-reference-'));
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 t.after(()=>{invalidateVoiceSnapshot(root);fs.rmSync(root,{recursive:true,force:true})});
 const chosen={provider,model:provider==='codex'?'gpt-6-astra':'sonnet'};
 const tasks=[],calls=[];
 const terminals={list:()=>tasks,get:id=>{const task=tasks.find(item=>item.id===id);if(!task)throw Error('Missing task');return task}};
 const add=(extra={})=>{const task={id:crypto.randomUUID(),...chosen,execution:appScope==='native'?'native':'terminal',state:'ready',title:'OLD_WORK_TITLE',prompt:'OLD_WORK_REQUEST',created:now-86400000,turns:[{ts:now-1000,text:'OLD_WORK_ANSWER'}],...extra};tasks.push(task);return task};
 const receipt=(fields={})=>{const id=crypto.randomUUID(),relative=`system/v2/voice-results/${id}.json`,value={id,provider,appScope,ts:now-1000,conversationEpoch:readConversationEpoch(root,provider,appScope),tier:2,workTarget:null,transcript:'What was the top news today?',reply:'The saved brief leads with the Aurora cipher result.',...fields};writeJson(root,relative,value);fs.utimesSync(path.join(root,relative),value.ts/1000,value.ts/1000);return value};
 const classify=(transcript,extra={},execute=()=>assert.fail('The reference check should not call a model'))=>classifyVoice(root,{id:crypto.randomUUID(),transcript,chosen,terminals,appScope,execute,...extra});
 const model=async(_root,_job,_prompt,options)=>{calls.push(options);return {text:'{"tier":2,"reply":"Which subject would you like to discuss?"}'}};
 return {root,chosen,tasks,calls,terminals,add,receipt,classify,model,advance:ms=>now+=ms,reset:()=>setCurrent(root,terminals,{provider,id:null,scope:appScope})};
}

for(const provider of ['codex','claude'])for(const scope of ['native','web']){
 test(`${provider}/${scope}: expired references clarify without reviving an old background task`,async t=>{
  const f=fixture(t,provider,scope),old=f.add();
  f.receipt({workTarget:old.id,transcript:'Create an explainer about the cipher result.',reply:'The illustration is ready.'});
  f.advance(31*60*1000);f.reset();
  for(const transcript of [
   'Make it larger.',
   'Can you please revise that?',
   'Show me the result.',
   'Could you explain those findings?',
   'Where did you save it?',
   'Why did you choose that approach?',
   'Create a visual explainer about that story.',
   'Try again.',
  ]){
   const result=await f.classify(transcript);
   assert.equal(result.tier,2,transcript);assert.equal(result.engine,'rules');assert.equal(result.lookupRoute,'clarification');
   assert.match(result.reply,/What would you like/);assert.equal(result.context,'');assert.equal(result.skill,undefined);assert.equal(result.tasks,undefined);
   // A clarification receipt cannot become evidence for another pronoun.
   f.receipt({transcript,reply:result.reply,lookupRoute:result.lookupRoute});
  }
  assert.equal(old.state,'ready');assert.equal(f.tasks.length,1);
 });

 test(`${provider}/${scope}: recent lookup references survive while foreign scopes, providers and epochs do not`,async t=>{
  const f=fixture(t,provider,scope),transcript='Create a diagram about that story.';
  f.receipt({provider:provider==='codex'?'claude':'codex'});
  f.receipt({appScope:scope==='native'?'web':'native'});
  f.receipt({conversationEpoch:99});
  f.receipt({transcript:'Hello!',reply:'Hi there!'});
  assert.equal((await f.classify(transcript)).lookupRoute,'clarification');
  f.advance(1000);
  f.receipt({deliverable:`inbox/research/morning-intel/${localDate()}-intel.md`});
  const result=await f.classify(transcript);
  assert.equal(result.tier,3);assert.equal(result.engine,'rules');assert.match(result.context,/Aurora cipher result/);assert.match(result.context,/Referenced report:/);
  const fresh=await f.classify(transcript,{newConversation:true});
  assert.equal(fresh.tier,3);assert.match(fresh.context,/Aurora cipher result/);
  f.reset();assert.equal((await f.classify(transcript)).lookupRoute,'clarification');
 });

 test(`${provider}/${scope}: explicitly selected saved work remains available even after old voice receipts expire`,async t=>{
  const f=fixture(t,provider,scope),task=f.add({turns:[{ts:Date.now()-86400000,text:'EXPLICIT_HISTORY_RESULT'}]});
  f.receipt({ts:Date.now()-86400000,workTarget:task.id,reply:'EXPIRED_VOICE_REPLY'});
  const result=await f.classify('Where did you save it?',{workTarget:task.id},async(_root,_job,_prompt,options)=>{
   assert.match(options.system,/EXPLICIT_HISTORY_RESULT/);assert.doesNotMatch(options.system,/EXPIRED_VOICE_REPLY/);
   return {text:'{"tier":3,"reply":"Let me check that conversation."}'};
  });
  assert.equal(result.tier,3);
 });

 test(`${provider}/${scope}: complete new work and independent report navigation need no remembered conversation`,async t=>{
  const f=fixture(t,provider,scope);f.add();f.reset();
  for(const transcript of ['Create a diagram about solar energy.','Make a comparison of solar and wind energy.','Create a graphic about solar energy so it is easy to understand.']){
   const result=await f.classify(transcript);assert.equal(result.tier,3,transcript);assert.equal(result.context,'');
  }
  const relative=`inbox/research/morning-intel/${localDate()}-intel.md`,file=path.join(f.root,relative);
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'# Saved morning brief\n');
  const opened=await f.classify('Can you pull up the morning Intel brief?');assert.equal(opened.deliverable,relative);assert.equal(opened.reveal,'open');
 });

 test(`${provider}/${scope}: generic model routing omits unselected task prose but explicit history questions can see it`,async t=>{
  const f=fixture(t,provider,scope);f.add();
  await f.classify('Could you help me think through a new product idea?',{},f.model);
  assert.equal(f.calls.length,1);
  for(const marker of ['OLD_WORK_TITLE','OLD_WORK_REQUEST','OLD_WORK_ANSWER'])assert.ok(!f.calls[0].system.includes(marker),marker);
  await f.classify('What happened to my graphic?',{},f.model);
  assert.equal(f.calls.length,2);assert.match(f.calls[1].system,/OLD_WORK_TITLE/);assert.match(f.calls[1].system,/OLD_WORK_ANSWER/);
  await f.classify('What is AI and how could it impact me?',{},f.model);
  assert.equal(f.calls.length,3,'An independent subject with an internal pronoun is not an unresolved follow-up');
 });
}
