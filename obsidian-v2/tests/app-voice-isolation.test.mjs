import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {routeVoice} from '../runner/bridge-core.mjs';
import {voiceMemory,invalidateVoiceSnapshot} from '../runner/voice-router.mjs';
import {readConversationEpoch,readCurrentState,setCurrent,taskInScope} from '../runner/current-conversations.mjs';
import {writeJson} from '../runner/core.mjs';

function fixture(t,provider){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'app-voice-isolation-'));
 t.after(()=>{invalidateVoiceSnapshot(root);fs.rmSync(root,{recursive:true,force:true})});
 const selection={provider,model:provider==='codex'?'gpt-6-astra':'sonnet'},records=new Map(),calls=[];
 const add=(scope,title=scope.toUpperCase()+'_TASK_CONTEXT')=>{const task={id:crypto.randomUUID(),...selection,title,state:'ready',execution:scope==='native'?'native':'cli',turns:[]};records.set(task.id,task);return task};
 const manager=scope=>({
  live:new Map(),list:()=>[...records.values()].filter(task=>taskInScope(task,scope)),
  get(id){const task=records.get(id);if(!task||!taskInScope(task,scope))throw new Error('Conversation is unavailable in this app.');return task},
  start(options){const task={...options,...options.selection,execution:scope==='native'?'native':'cli',state:'working',turns:[]};records.set(task.id,task);calls.push({scope,kind:'start',...options});return task},
  send(id,text){const task=this.get(id);calls.push({scope,kind:'send',id,text});return task},
  startWorkflow(){assert.fail('A general conversation must not start a named workflow')},
 });
 const managers={web:manager('web'),native:manager('native')};
 const select=(scope,id,resetContext=false)=>setCurrent(root,managers[scope],{scope,provider,id,resetContext});
 const receipt=(scope,label,extra={})=>{const id=crypto.randomUUID();writeJson(root,`system/v2/voice-results/${id}.json`,{id,ts:Date.now()-1000,provider,transcript:label,reply:`Want me to create a diagram about ${label}?`,tier:2,workTarget:null,conversationEpoch:readConversationEpoch(root,provider,scope),...(scope?{appScope:scope}:{}),...extra});return id};
 const speak=(scope,transcript,{id=crypto.randomUUID(),execute=()=>assert.fail('The scoped rule should not call a model'),target=readCurrentState(root,scope)[provider]}={})=>routeVoice(root,{id,transcript,selection,terminalMode:true,workTarget:target,appScope:scope},undefined,execute,managers[scope],{resolveCli:()=>({command:'fixture-cli',prefix:[]}),updateCurrent:change=>select(scope,change.id,change.resetContext)});
 return {root,selection,records,calls,add,select,receipt,speak};
}

for(const provider of ['codex','claude']){
 test(`${provider}: identical provider epochs never mix app voice history or legacy web receipts`,t=>{
  const f=fixture(t,provider);f.receipt('web','WEB_TOPIC');f.receipt('native','NATIVE_TOPIC');
  f.receipt('web','LEGACY_WEB_TOPIC',{appScope:undefined});
  assert.deepEqual(voiceMemory(f.root,provider).map(item=>item.you).sort(),['LEGACY_WEB_TOPIC','WEB_TOPIC']);
  assert.deepEqual(voiceMemory(f.root,provider,'native').map(item=>item.you),['NATIVE_TOPIC']);
  f.select('native',null);
  assert.equal(voiceMemory(f.root,provider,'native').length,0);
  assert.equal(voiceMemory(f.root,provider).length,2);
 });

 test(`${provider}: a bare yes can accept only this app's latest offer`,async t=>{
  const f=fixture(t,provider);f.receipt('web','WEB_ONLY_OFFER');
  const noOffer=await f.speak('native','yes');assert.match(noOffer.reply,/What would you like me to go ahead with/);assert.equal(f.calls.length,0);
  // The offer must be strictly later than the clarification above: on a fast machine both can land in one millisecond.
  await new Promise(resolve=>setTimeout(resolve,5));
  f.receipt('native','NATIVE_ONLY_OFFER',{ts:Date.now()});
  await f.speak('native','yes');assert.equal(f.calls.length,1);assert.equal(f.calls[0].scope,'native');
  assert.match(f.calls[0].prompt,/NATIVE_ONLY_OFFER/);assert.ok(!f.calls[0].prompt.includes('WEB_ONLY_OFFER'));
  assert.equal(readCurrentState(f.root).codex,null);assert.equal(readCurrentState(f.root).claude,null);
 });

 test(`${provider}: spoken fresh starts reset only their app and cannot replay another app's receipt`,async t=>{
  const f=fixture(t,provider),web=f.add('web'),native=f.add('native');f.select('web',web.id);f.select('native',native.id);
  const webBefore=readCurrentState(f.root);f.receipt('web','WEB_CONTEXT');f.receipt('native','NATIVE_CONTEXT');
  const id=crypto.randomUUID(),result=await f.speak('native','Start a new conversation',{id});
  assert.equal(result.currentReset,true);assert.equal(result.appScope,'native');assert.equal(result.conversationEpoch,1);
  assert.equal(readCurrentState(f.root,'native')[provider],null);assert.deepEqual(readCurrentState(f.root),webBefore);
  assert.equal(readConversationEpoch(f.root,provider),0);assert.equal(readConversationEpoch(f.root,provider,'native'),1);
  assert.ok(!voiceMemory(f.root,provider,'native').some(item=>item.you==='NATIVE_CONTEXT'));
  assert.equal(voiceMemory(f.root,provider)[0].you,'WEB_CONTEXT');
  const beforeReplay=readCurrentState(f.root,'native');assert.deepEqual(await f.speak('native','Start a new conversation',{id}),result);assert.deepEqual(readCurrentState(f.root,'native'),beforeReplay);
  await assert.rejects(f.speak('web','Start a new conversation',{id}),/request|app/i);assert.deepEqual(readCurrentState(f.root),webBefore);
 });

 test(`${provider}: an inline fresh task retains only its native request and selects no web terminal`,async t=>{
  const f=fixture(t,provider),web=f.add('web');f.select('web',web.id);f.receipt('web','WEB_HISTORY');f.receipt('native','OLD_NATIVE_HISTORY');
  const webBefore=readCurrentState(f.root);
  const result=await f.speak('native','Start a new conversation: create a diagram of a solar panel');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].scope,'native');assert.equal(f.calls[0].kind,'start');
  assert.match(f.calls[0].prompt,/solar panel/);assert.ok(!f.calls[0].prompt.includes('WEB_HISTORY'));assert.ok(!f.calls[0].prompt.includes('OLD_NATIVE_HISTORY'));
  assert.equal(readCurrentState(f.root,'native')[provider],result.workIds[0]);assert.deepEqual(readCurrentState(f.root),webBefore);
  assert.equal(f.records.get(result.workIds[0]).execution,'native');assert.equal(result.appScope,'native');
 });

 test(`${provider}: resetting web during an in-flight native request does not supersede its result`,async t=>{
  const f=fixture(t,provider),web=f.add('web'),native=f.add('native');f.select('web',web.id);f.select('native',native.id);
  let entered,release;const started=new Promise(resolve=>entered=resolve),waiting=new Promise(resolve=>release=resolve);
  const pending=f.speak('native','Why did you choose that approach?',{execute:async(_root,_job,_prompt,options)=>{
   assert.ok(options.system.includes('NATIVE_TASK_CONTEXT'));assert.ok(!options.system.includes('WEB_TASK_CONTEXT'));
   entered();await waiting;return {text:'{"tier":2,"reply":"This diagram shows the connections."}'};
  }});
  assert.equal(await Promise.race([started.then(()=>true),pending.then(()=>false)]),true,'The classifier must enter before changing the other app');
  f.select('web',null);release();const result=await pending;
  assert.equal(result.appScope,'native');assert.equal(result.conversationEpoch,0);assert.ok(!result.conversationSuperseded);
  assert.equal(readCurrentState(f.root,'native')[provider],native.id);assert.equal(readCurrentState(f.root)[provider],null);
  assert.equal(voiceMemory(f.root,provider,'native').length,1);assert.equal(voiceMemory(f.root,provider).length,0);
 });
}
