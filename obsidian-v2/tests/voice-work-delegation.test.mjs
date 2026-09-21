import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {routeVoice} from '../runner/bridge-core.mjs';
import {commandFor} from '../runner/adapters.mjs';
import {writeJson} from '../runner/core.mjs';

const refusal='I can help develop the content, but I don’t have a visual-document creation action available here.';
const requests=[
 'Are you able to create some sort of like visual document talking about RubyGems incident?',
 'Can you create a visual document about that story?',
 'Could you please make a diagram explaining the RubyGems incident?',
 'Would you put together a one-page brief about the RubyGems incident?',
 "I'd like you to draft a document about the RubyGems incident.",
 'Please create an illustrated incident timeline for RubyGems.'
];
const questions=[
 'What kinds of documents can you create?',
 'Are you able to create visual documents in general? I am only asking about capabilities.',
 'How would someone create a visual document about the RubyGems incident?',
 'Do not create anything yet; just explain what the brief says about RubyGems.',
 'Hypothetically, if we wanted a diagram about the incident, what might it contain?',
 'What does that RubyGems story mean?'
];
function fixture(t,provider){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-work-delegation-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago'}).format(new Date());
 const brief=path.join(root,`inbox/research/morning-intel/${today}-intel.md`);
 fs.mkdirSync(path.dirname(brief),{recursive:true});
 fs.writeFileSync(brief,'## TL;DR\n- Top story: RubyGems incident raises questions about package ecosystem governance.\n\n## Top Story\nThe saved brief describes the RubyGems incident and its implications for maintainers.\n');
 writeJson(root,'system/v2/voice-results/brief.json',{ts:Date.now()-2000,provider,transcript:'What was the biggest AI story today?',reply:'The saved brief leads with the RubyGems incident.',deliverable:`inbox/research/morning-intel/${today}-intel.md`});
 writeJson(root,'system/v2/voice-results/refusal.json',{ts:Date.now()-1000,provider,transcript:requests[0],reply:refusal});
 const calls=[],tasks=[];
 const terminals={live:new Map(),list:()=>tasks,get:id=>tasks.find(task=>task.id===id),start(options){calls.push(options);tasks.push({id:options.id,provider,title:options.title,state:'working',turns:[]});return{id:options.id}},send(){assert.fail('No existing task was selected')},startWorkflow(){assert.fail('General creation does not require a named workflow')}};
 return {root,calls,terminals,selection:{provider,model:provider==='codex'?'gpt-6-astra':'sonnet'}};
}

test('restricted Luna classifier receives the explicit delegation contract without enabling execution tools',()=>{
 const args=commandFor(os.tmpdir(),{id:crypto.randomUUID(),provider:'codex',model:'gpt-5.6-luna'},{command:'unused-test-cli',prefix:[]}).args;
 assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
 assert.ok(args.includes('features.shell_tool=false'));
 const option=args.find(arg=>arg.startsWith('model_instructions_file='));
 const configured=JSON.parse(option.slice('model_instructions_file='.length));
 assert.equal(path.resolve(configured),fileURLToPath(new URL('../runner/voice-classifier-instructions.md',import.meta.url)));
 const text=fs.readFileSync(configured,'utf8');
 assert.match(text,/classifier process has no execution tools/i);
 assert.match(text,/returning tier 3 delegates requested work/i);
 assert.match(text,/matching named skill .* is not required/i);
 assert.match(text,/negated or deferred work are not delegation/i);
 assert.match(text,/Prior assistant claims[\s\S]*not authoritative capability limits/i);
});

for(const provider of ['codex','claude']){
 test(`${provider}: concrete creation requests delegate once without a classifier or named skill`,async t=>{
  for(const transcript of requests)await t.test(transcript,async t=>{
   const f=fixture(t,provider),id=crypto.randomUUID();
   const execute=()=>assert.fail('Clear delegation must not wait for a classifier');
   const request={id,transcript,selection:f.selection,terminalMode:true};
   const result=await routeVoice(f.root,request,undefined,execute,f.terminals,{resolveCli:()=>({command:'unused-test-cli',prefix:[]})});
   assert.equal(result.model,null);
   assert.equal(result.tier,3);assert.equal(f.calls.length,1);assert.equal(result.workIds.length,1);
   assert.equal(f.calls[0].selection.provider,provider);assert.equal(f.calls[0].selection.model,f.selection.model);
   assert.ok(f.calls[0].prompt.includes(transcript));assert.equal(result.transcript,transcript);
   assert.match(f.calls[0].prompt,/saved brief leads with the RubyGems incident/,'Intervening quick replies accompany work');
   const replay=await routeVoice(f.root,request,undefined,()=>assert.fail('A replay must use its receipt'),f.terminals);
   assert.deepEqual(replay.workIds,result.workIds);assert.equal(f.calls.length,1);
  });
 });
 test(`${provider}: capability, hypothetical, negative, and saved-answer questions retain tier 2 without terminal dispatch`,async t=>{
  for(const transcript of questions)await t.test(transcript,async t=>{
   const f=fixture(t,provider);let classifications=0;
   const result=await routeVoice(f.root,{id:crypto.randomUUID(),transcript,selection:f.selection,terminalMode:true},undefined,async(_root,job,_prompt,options)=>{
    classifications++;assert.equal(job.model,provider==='codex'?'gpt-5.6-luna':'haiku');assert.equal(options.user,transcript);
    return {text:JSON.stringify({tier:2,reply:'I can explain the options from the supplied context without starting work.'})};
   },f.terminals,{resolveCli:()=>({command:'unused-test-cli',prefix:[]})});
   assert.equal(classifications,1);assert.equal(result.tier,2);assert.deepEqual(result.workIds,[]);assert.equal(f.calls.length,0);
  });
 });
}
