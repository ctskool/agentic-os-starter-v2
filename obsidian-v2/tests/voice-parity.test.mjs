import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {rules,classifyVoice,voiceMemory} from '../runner/voice-router.mjs';
import {withVoiceContext} from '../runner/voice-context.mjs';
import {readVoiceReport} from '../runner/voice-documents.mjs';
import {routeVoice} from '../runner/bridge-core.mjs';
import {writeJson} from '../runner/core.mjs';
import {setCurrent} from '../runner/current-conversations.mjs';
import {build} from 'esbuild';
const date=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago'}).format(new Date());
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-parity-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=(p,text)=>{const file=path.join(root,p);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text)};
 write(`daily-notes/${date()}.md`,'## Top 3 Priorities\n1. [ ] Record the launch demo\n2. [ ] Review the script\n3. [x] Publish the newsletter\n\n## Daily Drivers\n- [ ] Reply to Alex\n\n## Schedule\n- 14:00 — Record demo\n\n## Current Focus\nShip the launch.\n');
 write(`inbox/research/morning-intel/${date()}-intel.md`,'## TL;DR\n- Top story: Aurora released an open model.\n\n## Top Story\nAurora released an open model.\n\n## Inbox\n- **Sponsor**: Alex wants the demo.\n');
 write('system/metrics/metrics.csv',`timestamp,source,metric,value,status,error\n${new Date().toISOString()},youtube,subscribers,42000,ok,\n`);
 const sessions=[],calls=[];
 const terminals={live:new Map(),list:()=>sessions,get:id=>{const task=sessions.find(t=>t.id===id);if(!task)throw new Error('Task not found');return task},send(id,text){calls.push({kind:'send',id,text})},start(o){calls.push({kind:'start',...o});sessions.push({id:o.id,provider:o.selection.provider,model:o.selection.model,title:o.title,state:'working',turns:[]});return {id:o.id}},startWorkflow(o){calls.push({kind:'workflow',...o});sessions.push({id:o.id,provider:o.selection.provider,model:o.selection.model,title:o.skill,state:'working',workflow:{skill:o.skill},turns:[]});return {id:o.id}}};
 const speak=(provider,transcript,execute=()=>assert.fail('Must use the fast path'),extra={})=>routeVoice(root,{id:crypto.randomUUID(),selection:{provider,model:provider==='codex'?'gpt-6-astra':'sonnet'},transcript,terminalMode:true,...extra},undefined,execute,terminals,{resolveCli:()=>({command:'unused-test-cli',prefix:[]})});
 return {root,write,speak,calls,sessions,terminals};
}
const empty=()=>({metrics:[],runner:{alive:true,busy:false,active:0,pending:0},daily:null,morning:null,latestVideo:null,outliers:null,trendingRepos:[],queue:[],runs:[],etas:{}});
test('all 16 original Claude routing regressions retain their intent semantics',t=>{
 const {root}=fixture(t);
 const cases=[
  ['trend scan',1,'ai-trend-scan'],['run the github trending',1,'github-trending'],['run the inbox audit',1,'inbox-brief'],['the inbox brief please',1,'inbox-brief'],
  ['Based on these new GitHub trending repos for today, do you have any you think we should create a video about? Maybe like three of them?',3,'fallthrough'],
  ['do you think the github trending stuff matters this week?',3,'fallthrough'],['can you run the inbox audit for me when you get a chance',3,'fallthrough'],
  ["once you're done with that inbox brief tell me about fable 5",3,'fallthrough'],["what's going on with the github trending report today",3,'fallthrough'],
  ['give me the rundown',2],['hey jarvis brief me',2],['can you hear me',2],['how many subscribers do I have',2],["what's in the queue",2],
  ['run the github trending',2,'running'],['run github trending again',1,'github-trending','running']
 ];
 withVoiceContext({root,exchanges:[]},()=>{for(const [utterance,tier,expected,running]of cases){const state=empty();if(expected==='running'||running)state.runs=[{skill:'github-trending',status:'running'}];const result=rules.inFlightGuard(rules.rulesRoute(utterance,state),utterance,state);assert.equal(result.tier,tier,utterance);if(expected==='fallthrough')assert.equal(result.fallthrough,true,utterance);else if(expected==='running')assert.match(result.reply,/already running/);else if(expected)assert.equal(result.skill,expected,utterance)}});
});
for(const provider of ['codex','claude']){
 test(`${provider}: legacy tasks require a supported skill, while valid legacy work remains compatible`,async t=>{
  const f=fixture(t),output=value=>async(_root,job)=>{assert.equal(job.model,provider==='codex'?'gpt-5.6-luna':'haiku');return {text:JSON.stringify(value)}};
  for(const value of [{action:'task',reply:'Working.'},{action:'task',skill:'not-installed',reply:'Working.'},{action:'task',skill:'toString',reply:'Working.'}]){
   await assert.rejects(f.speak(provider,'What is the second one about?',output(value)),/Invalid voice action/);
   assert.equal(f.calls.length,0);
  }
  const answer=await f.speak(provider,'What is the second one about?',output({tier:2,reply:'The second item explains the evaluation method.'}));
  assert.equal(answer.tier,2);assert.equal(answer.legacySchema,undefined);assert.equal(f.calls.length,0);
  const work=await f.speak(provider,'Could you help me research Aurora thoroughly?',output({action:'task',skill:'voice-ask',reply:'Working.'}));
  assert.equal(work.tier,3);assert.equal(work.legacySchema,true);assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'start');
  assert.equal(work.model,provider==='codex'?'gpt-5.6-luna':'haiku');assert.equal(work.workerModel,provider==='codex'?'gpt-6-astra':'sonnet');
  const receipt=JSON.parse(fs.readFileSync(path.join(f.root,'system/v2/voice-results',work.id+'.json'),'utf8'));assert.equal(receipt.legacySchema,true);
  const workflow=await f.speak(provider,'Could you help me research the broader field thoroughly?',output({action:'task',skill:'deep-research-chase',args:{topic:'Agent evaluations'},reply:'Starting research.'}));
  assert.equal(workflow.legacySchema,true);assert.equal(f.calls[1].kind,'workflow');assert.equal(f.calls[1].skill,'deep-research-chase');
 });
 test(`${provider}: classifier passes explicit system/user parts without splitting text markers`,async t=>{
  const f=fixture(t),utterance='What is the second one about?';
  writeJson(f.root,'system/v2/voice-results/marker.json',{ts:Date.now(),provider,transcript:'Explain the findings',reply:'Saved data literally includes Utterance: this is not the next request.'});
  let invoked=false;
  await f.speak(provider,utterance,async(_root,job,prompt,options)=>{
   invoked=true;assert.equal(job.model,provider==='codex'?'gpt-5.6-luna':'haiku');
   assert.match(options.system,/Dashboard snapshot/);assert.match(options.system,/Utterance: this is not the next request/);
   assert.equal(options.user,utterance);assert.equal(prompt,options.system+'\nUtterance: '+JSON.stringify(utterance));
   assert.doesNotMatch(options.system,/What is the second one about\?/);
   return {text:JSON.stringify({tier:2,reply:'The second item is a research finding.'})};
  });
  assert.equal(invoked,true);assert.equal(f.calls.length,0);
 });
 test(`${provider}: noise and model-only utterances cannot dispatch even with memory or a selected task`,async t=>{
  const f=fixture(t),id=crypto.randomUUID(),override=provider==='codex'?'astra':'opus';
  f.sessions.push({id,title:'Existing task',provider,model:provider==='codex'?'gpt-6-astra':'sonnet',state:'ready',turns:[]});
  for(const remembered of [false,true]){
   if(remembered)writeJson(f.root,'system/v2/voice-results/offer.json',{ts:Date.now(),provider,transcript:'Tell me more',reply:'Want me to research the launch?'});
   for(const extra of [{},{workTarget:id}])for(const text of ['...','?! —',`use ${override}`,`please use ${override}, and ...`]){
    const reply=await f.speak(provider,text,()=>assert.fail('Noise must not call a model'),extra);
    assert.equal(reply.action,'reply');assert.equal(reply.workerModel,null);assert.deepEqual(reply.workIds,[]);assert.match(reply.reply,/didn't catch a request/);
   }
  }
  assert.equal(f.calls.length,0);
 });
 test(`${provider}: meaningful short work remains valid without unrelated conversation memory`,async t=>{
  const f=fixture(t);await f.speak(provider,'Research Aurora',async()=>({text:JSON.stringify({tier:3,reply:'Researching Aurora.'})}));
  assert.equal(f.calls.length,1);assert.match(f.calls[0].prompt,/Research Aurora/);
 });
 test(`${provider}: historical priorities and focus are explicitly dated, never today's remaining work`,async t=>{
  const f=fixture(t);fs.renameSync(path.join(f.root,`daily-notes/${date()}.md`),path.join(f.root,'daily-notes/2020-01-01.md'));
  const priorities=await f.speak(provider,'What are my priorities?');
  assert.match(priorities.reply,/no daily note for today/i);assert.match(priorities.reply,/2020-01-01/);assert.match(priorities.reply,/saved priorities were/);assert.doesNotMatch(priorities.reply,/still open|One left|cleared all/);
  const focus=await f.speak(provider,'What is my focus?');assert.match(focus.reply,/No focus set for today/);assert.match(focus.reply,/2020-01-01/);assert.doesNotMatch(focus.reply,/Today's focus is/);
  const schedule=await f.speak(provider,'What is on my schedule today?');assert.match(schedule.reply,/No schedule for today/);
  assert.equal(f.calls.length,0);
 });
 test(`${provider}: metrics, priorities, full briefing, read/open reports and UI stay model-free`,async t=>{
  const f=fixture(t);
  const metric=await f.speak(provider,'How many subscribers do I have?');assert.match(metric.reply,/42/);assert.deepEqual(metric.panels,['vitals']);
  assert.match((await f.speak(provider,'What are my priorities?')).reply,/Record the launch demo/);
  const brief=await f.speak(provider,'Give me the rundown');assert.ok(brief.deliverable);assert.ok(brief.reveals.length);assert.match(brief.reply,/demo/i);
  const read=await f.speak(provider,'Read my morning intel');assert.match(read.reply,/Aurora/);
  const open=await f.speak(provider,'Open morning intel');assert.equal(open.reveal,'open');assert.equal(open.reply,'');assert.match(readVoiceReport(f.root,open.deliverable,[],[open]).content,/Aurora/);
  assert.equal((await f.speak(provider,'Open my daily note')).obsidian.op,'daily-note');
  assert.equal((await f.speak(provider,'Open my calendar on the right')).obsidian.where,'right-sidebar');
  assert.equal((await f.speak(provider,'Pull up the terminal')).obsidian.id,'terminal:open-terminal.default.root');
  assert.equal((await f.speak(provider,'Go back')).obsidian.id,'app:go-back');
  assert.equal(f.calls.length,0);
 });
 test(`${provider}: daily task writes execute once and questions cannot mutate`,async t=>{
  const f=fixture(t),file=path.join(f.root,`daily-notes/${date()}.md`);
  await f.speak(provider,'Check off priority two');assert.match(fs.readFileSync(file,'utf8'),/2\. \[x\] Review/);
  await f.speak(provider,'Uncheck priority two');assert.match(fs.readFileSync(file,'utf8'),/2\. \[ \] Review/);
  const before=fs.readFileSync(file,'utf8');await f.speak(provider,'Did I finish priority two?');assert.equal(fs.readFileSync(file,'utf8'),before);
  const id=crypto.randomUUID();await f.speak(provider,'Add record the tutorial to my tasks',undefined,{id});await f.speak(provider,'Add record the tutorial to my tasks',undefined,{id});
  assert.equal(fs.readFileSync(file,'utf8').match(/record the tutorial/g).length,1);
  assert.equal(f.calls.length,0);
 });
 test(`${provider}: named workflows guard duplicate work and allow explicit reruns`,async t=>{
  const f=fixture(t);
  await f.speak(provider,'Run github trending');const duplicate=await f.speak(provider,'Run github trending');assert.match(duplicate.reply,/already running/);assert.equal(f.calls.length,1);
  await f.speak(provider,'Run github trending again');assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>c.selection.provider===provider));
 });
 test(`${provider}: snapshot questions, generic offers and required arguments use the correct fast model`,async t=>{
  const f=fixture(t);let calls=0;
  const model=async(_root,job,prompt)=>{calls++;assert.equal(job.model,provider==='codex'?'gpt-5.6-luna':'haiku');assert.match(prompt,/Aurora/);assert.match(prompt,/Alex wants the demo/);return {text:JSON.stringify({tier:2,reply:'The brief covers Aurora. Want me to dig into the benchmarks?'})}};
  await f.speak(provider,'What were the benchmark details?',model);assert.equal(f.calls.length,0);
  await f.speak(provider,'Sounds good',async(_root,job,prompt)=>{assert.match(prompt,/benchmarks/);return {text:JSON.stringify({tier:3,reply:'Working on the benchmark details.'})}});
  assert.equal(f.calls.length,1);assert.match(f.calls[0].prompt,/benchmarks/);assert.equal(f.calls[0].selection.model,provider==='codex'?'gpt-6-astra':'sonnet');
  await f.speak(provider,'Run the content cascade workflow',async()=>({text:JSON.stringify({tier:1,skill:'content-cascade',reply:'Starting.'})}));assert.equal(f.calls.length,1);
  await f.speak(provider,'https://example.com/video',async(_root,job,prompt)=>{assert.match(prompt,/source URL/);return {text:JSON.stringify({tier:1,skill:'content-cascade',args:{url:'https://example.com/video'},reply:'Starting.'})}});
  assert.equal(f.calls[1].skill,'content-cascade');assert.deepEqual(f.calls[1].args,{url:'https://example.com/video'});assert.equal(calls,1);
 });
 test(`${provider}: selected terminals keep follow-ups, but quick questions never go to the terminal`,async t=>{
  const f=fixture(t),id=crypto.randomUUID();f.sessions.push({id,title:'Demo',provider,model:provider==='codex'?'gpt-6-astra':'sonnet',state:'ready',turns:[{text:'A saved answer'}]});
  setCurrent(f.root,f.terminals,{provider,id});
  await f.speak(provider,'How many subscribers do I have?',undefined,{workTarget:id});assert.equal(f.calls.length,0);
  await f.speak(provider,'Make it shorter',undefined,{workTarget:id});assert.equal(f.calls[0].kind,'send');assert.equal(f.calls[0].id,id);
 });
}
test('conversation memory expires, respects clear and provider, and stale offers do not launch',async t=>{
 const f=fixture(t),remember=(name,provider,ts)=>writeJson(f.root,`system/v2/voice-results/${name}.json`,{ts,provider,transcript:name,reply:'Want me to run the inbox audit?'});
 remember('old','codex',Date.now()-700000);remember('stale-offer','codex',Date.now()-240000);remember('other-provider','claude',Date.now());
 assert.deepEqual(voiceMemory(f.root,'codex').map(e=>e.you),['stale-offer']);
 const reply=await f.speak('codex','Yes');assert.match(reply.reply,/What would you like/);assert.equal(f.calls.length,0);
 writeJson(f.root,'system/v2/voice-clear.json',{ts:Date.now()+1});assert.equal(voiceMemory(f.root,'codex').length,0);
});
test('Fable override keeps quick replies model-free and selects the full worker model only for work',async t=>{
 const f=fixture(t);assert.match((await f.speak('claude','Use fable and what are my priorities?')).reply,/Record the launch demo/);assert.equal(f.calls.length,0);
 const result=await f.speak('claude','Use fable and research Aurora',async(_root,job)=>{assert.equal(job.model,'haiku');return {text:JSON.stringify({tier:3,reply:'Researching Aurora.'})}});
 assert.equal(result.workerModel,'claude-fable-5-1');assert.equal(f.calls[0].selection.model,'claude-fable-5-1');assert.match(f.calls[0].prompt,/^research Aurora\n\nOriginal voice request: research Aurora/);
 await assert.rejects(f.speak('codex','Use haiku and research Aurora'),/not an enabled codex worker/);assert.equal(f.calls.length,1);
});
test('fresh original named offers execute without a model',async t=>{
 const f=fixture(t);writeJson(f.root,'system/v2/voice-results/offer.json',{ts:Date.now(),provider:'codex',transcript:'Brief me',reply:'Want me to run the inbox audit?'});
 await f.speak('codex','Yes');assert.equal(f.calls[0].skill,'inbox-brief');
});
test('referential repo and document opening use conversation without arbitrary file access',async t=>{
 const f=fixture(t);writeJson(f.root,'system/v2/voice-results/ref.json',{ts:Date.now(),provider:'codex',transcript:'Which repo?',reply:'acme/aurora is promising.'});
 assert.equal((await f.speak('codex','Bring up that repo')).obsidian.slug,'acme/aurora');
 f.write('projects/Aurora launch.md','# Launch');const result=await f.speak('codex','Open the Aurora launch note',async()=>({text:JSON.stringify({tier:2,reply:'',obsidian:{op:'open-note',query:'Aurora launch'}})}));assert.equal(result.obsidian.query,'projects/Aurora launch.md');assert.match(readVoiceReport(f.root,result.obsidian.query,[],[result]).content,/Launch/);
 assert.throws(()=>readVoiceReport(f.root,'projects/Aurora launch.md',[],[]),/referenced/);assert.throws(()=>readVoiceReport(f.root,'../outside.md',[],[{deliverable:'../outside.md'}]),/escaped/);
});
test('invalid model actions and nonimperative writes fail without work or edits',async t=>{
 const f=fixture(t),before=fs.readFileSync(path.join(f.root,`daily-notes/${date()}.md`),'utf8');
 for(const output of [{tier:99,reply:'Do it'},{tier:3,reply:''},{tier:2,reply:'Done',obsidian:{op:'command',id:'arbitrary:delete'}},{tier:2,reply:'Done',write:{kind:'top3',index:1,undo:false}}])await assert.rejects(f.speak('codex','Do you know something else about that?',async()=>({text:JSON.stringify(output)})),/invalid response/);
 assert.equal(f.calls.length,0);assert.equal(fs.readFileSync(path.join(f.root,`daily-notes/${date()}.md`),'utf8'),before);
});
test('explicit research is not swallowed by metric keywords; all requested work stays in one conversation by default',async t=>{
 const f=fixture(t);await f.speak('codex','Research subscriber growth and independently draft a launch email',async()=>({text:JSON.stringify({tier:3,reply:'Working on both.',tasks:[{prompt:'Research subscriber growth'},{prompt:'Draft a launch email'}]})}));
 assert.equal(f.calls.length,1);assert.ok(f.calls[0].prompt.includes('Original voice request: Research subscriber growth and independently draft a launch email'));
});
test('usage reads use the selected provider and weekly window; unavailable is not zero',async t=>{
 const f=fixture(t);for(const provider of ['codex','claude']){
  let asked;const result=await classifyVoice(f.root,{transcript:'What is my usage?',chosen:{provider},usage:{[provider]:async options=>{asked=options;return {status:'ok',windows:[{windowDurationMins:10080,usedPercent:37}]}}}});assert.match(result.reply,new RegExp(`${provider==='codex'?'Codex':'Claude'} weekly usage is 37`));
  // A voice request never waits for a sign-in renewal.
  assert.equal(asked.wait,false);
 }
 const missing=await classifyVoice(f.root,{transcript:'What is my usage?',chosen:{provider:'codex'},usage:{codex:async()=>({windows:[]})}});assert.match(missing.reply,/don't have/);
});
test('concurrent vault requests retain separate roots during model awaits',async t=>{
 const a=fixture(t),b=fixture(t);b.write('projects/Unique note.md','# Other vault');
 const run=(f,wait)=>f.speak('codex','Could you please put up my unique note?',async()=>{await new Promise(r=>setTimeout(r,wait));return {text:JSON.stringify({tier:2,reply:'',obsidian:{op:'open-note',query:'Unique note'}})}});
 const [first,second]=await Promise.all([run(a,20),run(b,1)]);assert.equal(first.obsidian,null);assert.equal(second.obsidian.query,'projects/Unique note.md');
});
test('other provider task conversations are not prompt context, but active duplicate workflows are guarded',async t=>{
 const f=fixture(t);f.sessions.push({id:crypto.randomUUID(),provider:'claude',title:'PRIVATE_OTHER_TASK',state:'working',workflow:{skill:'github-trending'},turns:[{text:'OTHER_PROVIDER_ANSWER'}]});
 await f.speak('codex','What else can you say about that?',async(_root,job,prompt)=>{assert.doesNotMatch(prompt,/PRIVATE_OTHER_TASK|OTHER_PROVIDER_ANSWER/);return {text:JSON.stringify({tier:2,reply:'Which topic do you mean?'})}});
 const reply=await f.speak('codex','Run github trending');assert.match(reply.reply,/already running/);assert.equal(f.calls.length,0);
});
const bundle=await build({entryPoints:['shared/voice-session.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {VoiceSession}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
test('silent UI actions complete without empty TTS; async action errors surface truthfully',async()=>{
 let speaks=0,opened=0,message='';const voice=new VoiceSession(async p=>{if(p==='/voice/speak')speaks++;return {status:200,json:{reply:'',obsidian:{op:'daily-note'}}}},async()=>({provider:'codex',model:'gpt-6-astra'}));
 voice.onReply=async()=>{opened++};await voice.sendText('Open my daily note');assert.equal(opened,1);assert.equal(speaks,0);assert.equal(voice.mode,'idle');
 voice.onReply=async()=>{throw new Error('Note missing')};voice.onMessage=text=>message=text;await voice.sendText('Open my daily note');assert.equal(message,'Note missing');assert.equal(voice.mode,'error');await voice.destroy();
});
const nativeBundle=await build({entryPoints:['src/lib/voice-actions.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {applyVoiceAction}=await import('data:text/javascript;base64,'+Buffer.from(nativeBundle.outputFiles[0].text).toString('base64'));
test('native action adapter opens actual notes in requested panes and reports unavailable commands',async()=>{
 const calls=[],file={path:'projects/Launch.md',name:'Launch.md',basename:'Launch',extension:'md'};
 const leaf={openFile:async f=>calls.push(f.path),setViewState:async s=>calls.push(s)};
 const app={vault:{getAbstractFileByPath:p=>p===file.path?file:null,getMarkdownFiles:()=>[file]},workspace:{getRightLeaf:()=>{calls.push('right');return leaf},getLeaf:()=>leaf,revealLeaf:async()=>{}},commands:{executeCommandById:()=>false}};
 await applyVoiceAction(app,{obsidian:{op:'open-note',query:file.path,where:'right-sidebar'}},async()=>{},()=>{});assert.deepEqual(calls,['right',file.path]);
 await assert.rejects(applyVoiceAction(app,{obsidian:{op:'command',id:'graph:open'}},async()=>{},()=>{}),/unavailable/);
 let opened=0;await applyVoiceAction(app,{obsidian:{op:'command',id:'terminal:open-terminal.default.root'}},async()=>{},()=>opened++);assert.equal(opened,1);
});
test('fast model snapshot does not pass off historical daily tasks as current',async t=>{
 const f=fixture(t);fs.renameSync(path.join(f.root,`daily-notes/${date()}.md`),path.join(f.root,'daily-notes/2020-01-01.md'));
 writeJson(f.root,'system/v2/voice-results/stale-plan.json',{ts:Date.now(),provider:'codex',transcript:'What is on my schedule?',reply:'Today your priority is ImpossibleCurrentPriority.'});
 let checked=false;
 await classifyVoice(f.root,{id:crypto.randomUUID(),chosen:{provider:'codex',model:'gpt-6-astra'},transcript:'Is there enough saved information to recommend my next project?',terminals:f.terminals,execute:async(_root,_job,prompt)=>{
 checked=true;assert.match(prompt,/missing for today; last saved note is 2020-01-01/);assert.doesNotMatch(prompt,/Record the launch demo|ImpossibleCurrentPriority/);return{text:'{"tier":2,"reply":"There is no current daily plan."}'};
 }});assert.equal(checked,true);
});

for(const provider of ['codex','claude'])test(`${provider}: a missing daily note preserves today's news for a document handoff`,async t=>{
 const f=fixture(t);fs.renameSync(path.join(f.root,`daily-notes/${date()}.md`),path.join(f.root,'daily-notes/2020-01-01.md'));
 const answer="From today's morning brief: the RubyGems incident affected package registrations.";
 const report=`inbox/research/morning-intel/${date()}-intel.md`;
 writeJson(f.root,'system/v2/voice-results/news.json',{ts:Date.now(),provider,transcript:'What was the biggest news in AI today?',reply:answer,deliverable:report});
 const request='Are you able to create some sort of like visual document talking about that RubyGems story?';
 let calls=0;
 const result=await f.speak(provider,request,async(_root,_job,prompt)=>{
  calls++;assert.ok(prompt.includes(answer));assert.ok(prompt.includes(report));
  return {text:'{"tier":3,"reply":"Working on that visual document."}'};
 });
 assert.equal(calls,0);assert.equal(result.model,null);assert.equal(result.tier,3);assert.equal(result.workerModel,provider==='codex'?'gpt-6-astra':'sonnet');
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'start');assert.ok(f.calls[0].prompt.includes(answer));
 assert.ok(f.calls[0].prompt.includes(report));assert.ok(f.calls[0].prompt.includes(request));
});
