import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {routeVoice} from '../runner/bridge-core.mjs';
import {readConversationEpoch,readCurrentState,setCurrent} from '../runner/current-conversations.mjs';
import {voiceMemory,invalidateVoiceSnapshot} from '../runner/voice-router.mjs';
import {writeJson} from '../runner/core.mjs';

function fixture(t,provider){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-conversation-reset-'));
 t.after(()=>{invalidateVoiceSnapshot(root);fs.rmSync(root,{recursive:true,force:true})});
 const selection={provider,model:provider==='codex'?'gpt-6-astra':'sonnet'},other=provider==='codex'?'claude':'codex';
 const records=new Map(),calls=[];
 const add=(chosen=selection)=>{const task={id:crypto.randomUUID(),...chosen,state:'ready',title:'Existing saved conversation',turns:[]};records.set(task.id,task);return task};
 const terminals={live:new Map(),list:()=>[...records.values()],get:id=>{const task=records.get(id);if(!task)throw Error('Missing task');return task},
  start(options){const task={...options,...options.selection,state:'working',turns:[]};records.set(task.id,task);calls.push({kind:'start',...options});return task},
  send(id,text){const task=this.get(id);calls.push({kind:'send',id,text});task.state='working';return task},
  startWorkflow(){assert.fail('A new conversation must not start a workflow')}
 };
 const reset=()=>setCurrent(root,terminals,{provider,id:null});
 const receipt=(name,fields={})=>{writeJson(root,`system/v2/voice-results/${name}.json`,{ts:Date.now()-1000,provider,transcript:'OLD_VOICE_TOPIC',reply:'Want me to research OLD_VOICE_TOPIC?',tier:2,workTarget:null,...fields});return path.join(root,'system/v2/voice-results',name+'.json')};
 const speak=(transcript,{execute=()=>assert.fail('A fresh-start command must not call a model'),target=readCurrentState(root)[provider],id=crypto.randomUUID()}={})=>routeVoice(root,{id,transcript,selection,terminalMode:true,workTarget:target},undefined,execute,terminals,{resolveCli:()=>({command:'fixture-cli',prefix:[]}),updateCurrent:change=>setCurrent(root,terminals,change)});
 return {root,selection,other,records,calls,add,terminals,reset,receipt,speak};
}

for(const provider of ['codex','claude']){
 test(`${provider}: new conversation clears quick-only context while retaining other provider and saved work`,t=>{
  const f=fixture(t,provider),saved=f.add(),other=f.add({provider:f.other,model:f.other==='codex'?'gpt-6-astra':'sonnet'});
  setCurrent(f.root,f.terminals,{provider:f.other,id:other.id});
  const file=f.receipt('old'),bytes=fs.readFileSync(file);f.receipt('other',{provider:f.other,transcript:'OTHER_PROVIDER_CONTEXT'});
  assert.equal(readCurrentState(f.root)[provider],null);assert.equal(voiceMemory(f.root,provider).length,1);
  f.reset();assert.equal(voiceMemory(f.root,provider).length,0);assert.equal(voiceMemory(f.root,f.other)[0].you,'OTHER_PROVIDER_CONTEXT');
  assert.equal(readCurrentState(f.root)[f.other],other.id);assert.equal(f.records.get(saved.id).state,'ready');assert.equal(f.calls.length,0);assert.deepEqual(fs.readFileSync(file),bytes);
  f.receipt('new',{conversationEpoch:readConversationEpoch(f.root,provider),transcript:'NEW_QUICK_CONTEXT'});assert.equal(voiceMemory(f.root,provider)[0].you,'NEW_QUICK_CONTEXT');
  f.reset();assert.equal(voiceMemory(f.root,provider).length,0,'Reset still works while no terminal is selected');
 });

 test(`${provider}: spoken fresh start is model-free, cannot accept an old offer, and receipt replay never resets again`,async t=>{
  const f=fixture(t,provider),saved=f.add(),id=crypto.randomUUID();setCurrent(f.root,f.terminals,{provider,id:saved.id});f.receipt('old');
  const result=await f.speak('Start a new conversation',{id});assert.equal(result.currentReset,true);assert.equal(result.workIds.length,0);assert.match(result.reply,/new conversation/i);assert.equal(f.calls.length,0);
  assert.equal(readCurrentState(f.root)[provider],null);assert.equal(voiceMemory(f.root,provider).some(item=>item.you==='OLD_VOICE_TOPIC'),false);
  const answer=await f.speak('yes');assert.match(answer.reply,/What would you like me to go ahead with/);assert.equal(f.calls.length,0);
  const next=f.add();setCurrent(f.root,f.terminals,{provider,id:next.id});const before=readCurrentState(f.root),epoch=readConversationEpoch(f.root,provider);
  assert.deepEqual(await f.speak('Start a new conversation',{id}),result);assert.deepEqual(readCurrentState(f.root),before);assert.equal(readConversationEpoch(f.root,provider),epoch);assert.equal(saved.state,'ready');
 });

 test(`${provider}: inline new conversation omits old voice context and retains its own request for follow-ups`,async t=>{
  const f=fixture(t,provider);f.receipt('old');
  const result=await f.speak('Start a new conversation: create a diagram of a solar panel');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'start');assert.equal(f.calls[0].prompt.includes('OLD_VOICE_TOPIC'),false);
  assert.equal(readCurrentState(f.root)[provider],result.workIds[0]);assert.equal(readConversationEpoch(f.root,provider),1);
  const memory=voiceMemory(f.root,provider);assert.equal(memory.length,1);assert.match(memory[0].you,/solar panel/);
  await f.speak('Why did you choose that approach?',{execute:async(_root,_job,_prompt,options)=>{assert.match(options.system,/solar panel/);assert.ok(!options.system.includes('OLD_VOICE_TOPIC'));return {text:'{"tier":2,"reply":"The layout shows the main connections."}'}}});
  assert.equal(f.calls.length,1);
 });

 test(`${provider}: inline quick question remains the first exchange of the fresh conversation`,async t=>{
  const f=fixture(t,provider);f.receipt('old');
  const result=await f.speak('Start a new conversation: is the worker online?');
  assert.equal(result.currentReset,true);assert.equal(f.calls.length,0);assert.equal(voiceMemory(f.root,provider).length,1);assert.match(voiceMemory(f.root,provider)[0].you,/worker online/);
 });

 test(`${provider}: a late in-flight result cannot repopulate fresh context or reselect its old terminal`,async t=>{
  const f=fixture(t,provider),saved=f.add();setCurrent(f.root,f.terminals,{provider,id:saved.id});f.receipt('old',{workTarget:saved.id});
  let release,entered;const started=new Promise(resolve=>entered=resolve),waiting=new Promise(resolve=>release=resolve);
  const pending=f.speak('Why did you choose that approach?',{execute:async()=>{entered();await waiting;return {text:'{"tier":3,"reply":"I will continue that work."}'}}});
  await started;f.reset();const fresh=readCurrentState(f.root);release();await pending;
  assert.equal(f.calls.length,1,'The already authorized request still proceeds');assert.equal(f.calls[0].id,saved.id);assert.deepEqual(readCurrentState(f.root),fresh);assert.equal(voiceMemory(f.root,provider).length,0);
 });

 test(`${provider}: reset persistence failure remains an error on retry and never submits twice`,async t=>{
  for(const transcript of ['Start a new conversation','Start a new conversation: create a diagram of a solar panel']){
   const f=fixture(t,provider),id=crypto.randomUUID(),request={id,transcript,selection:f.selection,terminalMode:true};f.receipt('old');
   const run=()=>routeVoice(f.root,request,undefined,()=>assert.fail('No model expected'),f.terminals,{resolveCli:()=>({command:'fixture-cli',prefix:[]}),updateCurrent:()=>{throw Error('Disk write failed')}});
   await assert.rejects(run(),/couldn't (?:start|select)/);const calls=f.calls.length;
   await assert.rejects(run(),/couldn't (?:start|select)/);assert.equal(f.calls.length,calls);assert.equal(readConversationEpoch(f.root,provider),0);assert.equal(voiceMemory(f.root,provider)[0].you,'OLD_VOICE_TOPIC');
  }
 });
}
