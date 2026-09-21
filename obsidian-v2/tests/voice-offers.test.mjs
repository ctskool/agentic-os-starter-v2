import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {routeVoice} from '../runner/bridge-core.mjs';
import {writeJson} from '../runner/core.mjs';
import {setCurrent,readConversationEpoch} from '../runner/current-conversations.mjs';

// Same offer as Fable's voice-harness-yes.mjs, but all providers and terminals
// are fakes. No CLI discovery, model call, service, microphone or live vault.
const OFFER='The brief mentions a local model release from Fixture Labs. Want me to dig deeper into local model options for you?';
const QUESTION='Is there anything about local models in the brief?';
function fixture(t,provider='codex'){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'aos-voice-offers-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'.agentic-os-v2-test-vault'),'agentic-os-v2-only');
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 const calls=[],sessions=[];
 const selection={provider,model:provider==='codex'?'gpt-6-astra':'sonnet'};
 const terminals={live:new Map(),list:()=>sessions,get:id=>{const s=sessions.find(s=>s.id===id);if(!s)throw Error('Task not found');return s},start(task){calls.push({kind:'start',...task});return{id:task.id}},startWorkflow(task){calls.push({kind:'workflow',...task});return{id:task.id}},send(id,text){calls.push({kind:'send',id,text})}};
 const seed=(extra={})=>{const id=crypto.randomUUID();writeJson(root,`system/v2/voice-results/${id}.json`,{id,ts:now-20,provider,conversationEpoch:readConversationEpoch(root,provider),model:provider==='codex'?'gpt-5.6-luna':'haiku',engine:provider==='codex'?'luna':'haiku',tier:2,transcript:QUESTION,reply:OFFER,workIds:[],...extra});return id};
 const choose=id=>setCurrent(root,terminals,{provider,id,now});
 const speak=(transcript,extra={},execute=()=>assert.fail('Offer follow-through must not call a model'))=>routeVoice(root,{id:crypto.randomUUID(),selection,transcript,terminalMode:true,workTarget:null,...extra},undefined,execute,terminals,{resolveCli:()=>({command:'unused-test-cli',prefix:[]})});
 return {root,calls,sessions,selection,seed,speak,choose,advance(ms){now+=ms},now:()=>now};
}

for(const provider of ['codex','claude']){
 test(`${provider}: Fable's fresh bare-yes fixture dispatches the exact accepted offer, never a yes task`,async t=>{
  const f=fixture(t,provider);
  f.seed({ts:f.now()-5000,transcript:'Unrelated old publishing request',reply:'UNRELATED_OLD_TASK'});
  f.seed();
  const id=crypto.randomUUID(),reply=await f.speak('yes',{id});
  assert.equal(reply.tier,3);assert.equal(reply.engine,'rules');assert.equal(reply.model,null);assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].title,'Dig deeper into local model options for you');
  assert.match(f.calls[0].prompt,/^dig deeper into local model options for you\n/);
  assert.ok(f.calls[0].prompt.includes(QUESTION));assert.ok(f.calls[0].prompt.includes(OFFER));
  assert.doesNotMatch(f.calls[0].prompt,/Original voice request: yes|UNRELATED_OLD_TASK|Unrelated old publishing request/);
  assert.equal(reply.workerModel,provider==='codex'?'gpt-6-astra':'sonnet');
  const receipt=JSON.parse(fs.readFileSync(path.join(f.root,'system/v2/voice-results',id+'.json'),'utf8'));assert.equal(receipt.transcript,'yes');
  assert.deepEqual(await f.speak('yes',{id}),reply);assert.equal(f.calls.length,1);
  f.advance(1);const repeated=await f.speak('yes');assert.equal(repeated.workIds.length,0);assert.equal(f.calls.length,1);
 });
 test(`${provider}: variants resolve the same fresh offer without invented model tasks`,async t=>{
  const f=fixture(t,provider);
  for(const text of ['yes please do that','Yes, please.','go ahead','sounds good','please do that','sure please']){
   f.advance(50);f.seed();const reply=await f.speak(text);
   assert.equal(reply.tier,3);assert.equal(f.calls.at(-1).title,'Dig deeper into local model options for you');assert.match(f.calls.at(-1).prompt,/^dig deeper into local model options/);
  }
 });
 test(`${provider}: expired, missing, declined and other-provider offers do not escalate`,async t=>{
  const f=fixture(t,provider);
  assert.equal((await f.speak('yes')).workIds.length,0);
  f.advance(200);f.seed({ts:f.now()-180000});assert.equal((await f.speak('yes')).workIds.length,0);
  f.advance(200);f.seed({provider:provider==='codex'?'claude':'codex'});assert.equal((await f.speak('yes')).workIds.length,0);
  f.advance(200);f.seed();assert.match((await f.speak('No, not that')).reply,/Standing by/);f.advance(1);
  assert.equal((await f.speak('yes')).workIds.length,0);assert.equal(f.calls.length,0);
 });
 test(`${provider}: questions, multiple choices and unresolved pronouns cannot become work`,async t=>{
  const f=fixture(t,provider);
  const ambiguous=['Is that useful?','Want me to research local models or build a plugin?','Want me to research local models? Or should I build a plugin?','The report quotes "Want me to research local models?"','Want me to dig into it?'];
  for(const reply of ambiguous){f.advance(200);f.seed({reply,transcript:'What do you mean?'});const response=await f.speak('yes');assert.equal(response.workIds.length,0,reply)}
  assert.equal(f.calls.length,0);
 });
 test(`${provider}: a referential offer is scoped to its immediately preceding concrete request`,async t=>{
  const f=fixture(t,provider);f.seed({ts:f.now()-5000,transcript:'Secret old task',reply:'DO_NOT_INCLUDE_OLDER_CONTEXT'});
  f.seed({transcript:'How do the local model benchmarks compare on Windows?',reply:'I have the headline but not those measurements. Want me to dig into it?'});
  const response=await f.speak('yes');assert.equal(response.tier,3);
  assert.match(f.calls[0].title,/local model benchmarks compare on Windows/);assert.match(f.calls[0].prompt,/How do the local model benchmarks compare on Windows/);assert.doesNotMatch(f.calls[0].prompt,/Secret old task|DO_NOT_INCLUDE/);
 });
 test(`${provider}: original morning offers still dispatch their named skills`,async t=>{
  const f=fixture(t,provider);
  for(const [reply,skill]of [
   ['Want me to run the morning report, or do you have anything else in mind?','morning-report'],
   ['Want me to run the daily inbox audit, or do you have anything else in mind?','inbox-brief'],
   ['Want me to pull fresh metrics, or do you have anything else in mind?','metrics-pull'],
   ['Want me to run a trend scan for content leads, or do you have anything else in mind?','ai-trend-scan']
  ]){f.advance(100);f.seed({reply});await f.speak('yes please do that');assert.equal(f.calls.at(-1).kind,'workflow');assert.equal(f.calls.at(-1).skill,skill)}
  f.advance(100);f.seed({reply:'What source URL should I use for content cascade?',pendingSkill:'content-cascade'});
  const pending=await f.speak('yes');assert.equal(pending.pendingSkill,'content-cascade');assert.equal(pending.workIds.length,0);assert.match(pending.reply,/source URL/);assert.equal(f.calls.length,4);
 });
 test(`${provider}: selected-task offers retain their conversation and send actual accepted wording`,async t=>{
  const f=fixture(t,provider),id=crypto.randomUUID();f.sessions.push({id,provider,model:provider==='codex'?'gpt-5.6-luna':'opus',title:'Current research',state:'ready',created:f.now(),conversationActivityAt:f.now(),turns:[]});f.choose(id);
  const offered=await f.speak(QUESTION,{workTarget:id},async(_root,job)=>{assert.equal(job.model,provider==='codex'?'gpt-5.6-luna':'haiku');return {text:JSON.stringify({tier:2,reply:OFFER})}});
  assert.equal(offered.workTarget,id);assert.equal(f.calls.length,0);f.advance(20);
  const accepted=await f.speak('yes',{workTarget:id});assert.equal(accepted.tier,3);assert.equal(accepted.workerModel,f.sessions[0].model);assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'send');assert.equal(f.calls[0].id,id);
  assert.match(f.calls[0].text,/^dig deeper into local model options for you\n/);assert.ok(f.calls[0].text.includes(QUESTION));assert.ok(f.calls[0].text.includes(OFFER));assert.notEqual(f.calls[0].text,'yes');
 });
 test(`${provider}: changing the selected task cannot redirect another conversation's offer`,async t=>{
  const f=fixture(t,provider),first=crypto.randomUUID(),second=crypto.randomUUID();
  f.sessions.push(...[first,second].map(id=>({id,provider,model:f.selection.model,title:id,state:'ready',created:f.now(),conversationActivityAt:f.now(),turns:[]})));
  for(const [savedTarget,target]of [[first,second],[first,null],[null,second]]){f.advance(100);f.choose(target);f.seed({workTarget:savedTarget});const reply=await f.speak('yes',{workTarget:target});assert.equal(reply.workIds.length,0);assert.match(reply.reply,/different conversation/)}
  f.advance(100);f.seed({workTarget:first});f.sessions[0].provider=provider==='codex'?'claude':'codex';await assert.rejects(f.speak('yes',{workTarget:first}),/different provider/);assert.equal(f.calls.length,0);
 });
 test(`${provider}: an accepted information-only offer stays out of terminals even if a model tries to escalate`,async t=>{
  const f=fixture(t,provider);f.seed({reply:'Want me to explain the local model findings?'});
  const reply=await f.speak('yes',{},async(_root,job,_prompt,options)=>{assert.equal(job.model,provider==='codex'?'gpt-5.6-luna':'haiku');assert.equal(options.user,'explain the local model findings');return {text:'{"tier":3,"reply":"Starting a large research project."}'}});
  assert.equal(reply.workIds.length,0);assert.equal(f.calls.length,0);assert.match(reply.reply,/offer was only to explain or show/);
 });
 test(`${provider}: explaining a named skill does not invoke its short-alias workflow`,async t=>{
  const f=fixture(t,provider);f.seed({reply:'Want me to explain lead research?'});
  const reply=await f.speak('yes');assert.equal(reply.workIds.length,0);assert.equal(f.calls.length,0);assert.match(reply.reply,/offer was only to explain or show/);
 });
}

test('legacy queue dispatch receives the accepted request and bounded context',async t=>{
 const f=fixture(t);writeJson(f.root,'system/v2/runner-status.json',{ts:new Date().toISOString(),busy:false});f.seed();
 const result=await f.speak('yes',{terminalMode:false});assert.equal(result.tier,3);assert.equal(f.calls.length,0);
 const job=JSON.parse(fs.readFileSync(path.join(f.root,'system/v2/queue',result.queued+'.json'),'utf8'));
 assert.equal(job.args.prompt,'dig deeper into local model options for you');assert.ok(job.args.context.includes(QUESTION));assert.ok(job.args.context.includes(OFFER));
});
