import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {classifyVoice,invalidateVoiceSnapshot} from '../runner/voice-router.mjs';
import {routeVoice} from '../runner/bridge-core.mjs';
import {localDate} from '../runner/brief-voice.mjs';

// Held-out integration fixtures: editorial, score, and discussion leaders differ.
// Only local disposable files and fake model/terminal adapters are used.
const report=`## Top Story
An open weather model reached a new milestone.

## Headlines
- An open weather model reached a new milestone.
- A tiny speech model runs locally.
- An evaluation lab published reproducible benchmarks.

## Hacker News Pulse
| Comments | Story | Points |
|---|---|---|
| 90 | [Cedar compiler](https://example.test/cedar) | 900 |
| 2,400 | [Harbor database](https://example.test/harbor) | 400 |
| 30 | [Quasar notebook](https://example.test/quasar) | 1,200 |
| 200 | [Otter runtime](https://example.test/otter) | 600 |
| 8 | [Maple debugger](https://example.test/maple) | 200 |

## Inbox
PRIVATE_INBOX_SENTINEL must never enter a public-news lookup.
`;
const compactReply='HELD_OUT_COMPACT_REPLY';
const forbidden=/^(?:daily-notes|system\/(?:metrics|runs|queue|v2\/(?:runs|queue|processing)))(?:\/|$)/;
const normalized=value=>String(value).replace(/,/g,'').replace(/\s+/g,' ');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-lookup-acceptance-'));
 const today=localDate();
 const write=(relative,text)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text)};
 const writeBrief=(date=today,text=report)=>write(`inbox/research/morning-intel/${date}-intel.md`,text);
 writeBrief();
 write(`daily-notes/${today}.md`,'## Top 3 Priorities\n1. [ ] Record the local demo\n2. [x] Review the map\n3. [ ] Publish the tutorial\n\n## Schedule\n- 16:20 — Demo rehearsal\n\n## Current Focus\nShip the offline reader.\n');
 write('system/metrics/metrics.csv',`timestamp,source,metric,value,status,error\n${new Date().toISOString()},youtube,subscribers,43127,ok,\n${new Date().toISOString()},instagram,followers,0,ok,\n`);
 write('system/metrics/latest-video.json',JSON.stringify({title:'PRIVATE_VIDEO_SENTINEL',views:700,url:'https://example.test/video',status:'ok',published_at:new Date().toISOString()}));
 const tasks=[],calls=[],terminalReads=[];
 const terminals={live:new Map(),list:()=>{terminalReads.push('list');return tasks},get:id=>{terminalReads.push('get');return tasks.find(task=>task.id===id)||null},
  start(options){calls.push({kind:'start',...options});return {id:options.id}},
  send(id,prompt){calls.push({kind:'send',id,prompt})},
  startWorkflow(options){calls.push({kind:'workflow',...options});return {id:options.id}}};
 const selection=provider=>({provider,model:provider==='codex'?'gpt-6-astra':'sonnet'});
 const speak=(provider,transcript,execute=()=>assert.fail('This lookup must not call a model'),extra={})=>routeVoice(root,{id:crypto.randomUUID(),selection:selection(provider),transcript,terminalMode:true,...extra},undefined,execute,terminals,{resolveCli:()=>({command:'unused-fixture-cli',prefix:[]})});
 const classify=(provider,transcript,execute=()=>assert.fail('This lookup must not call a model'),extra={})=>classifyVoice(root,{id:crypto.randomUUID(),chosen:selection(provider),transcript,terminals,execute,...extra});
 t.after(()=>{invalidateVoiceSnapshot(root);fs.rmSync(root,{recursive:true,force:true})});
 return {root,today,write,writeBrief,tasks,calls,terminalReads,terminals,speak,classify};
}
async function traceReads(root,fn){
 const originals={},reads=[];
 for(const name of ['readFileSync','readdirSync','statSync','existsSync']){
  originals[name]=fs[name];fs[name]=function(file,...args){
   if(typeof file==='string'){const relative=path.relative(root,file).replaceAll('\\','/');if(relative&&!relative.startsWith('../')&&!path.isAbsolute(relative))reads.push({op:name,path:relative})}
   return originals[name].call(this,file,...args);
  };
 }
 try{return {value:await fn(),reads}}finally{Object.assign(fs,originals)}
}
function compactModel(provider,utterance,seen,output={tier:2,reply:compactReply}){
 return async(_root,job,prompt,options)=>{
  seen.push({job,prompt,options});assert.equal(job.provider,provider);assert.equal(job.model,provider==='codex'?'gpt-5.6-luna':'haiku');
  assert.equal(options.user,utterance,'the classifier must receive the whole request');
  assert.ok(options.system.length<=12000,`compact system was ${options.system.length} characters`);
  assert.ok(!/PRIVATE_VIDEO_SENTINEL|Record the local demo/.test(options.system),'A compact source lookup included unrelated dashboard data.');
  if(utterance==="Can you walk me through this morning's briefing?"){
   assert.ok(options.system.includes('PRIVATE_INBOX_SENTINEL'),'An explicit whole-brief request must retain the same report\'s inbox section.');
  }else{
   assert.ok(!options.system.includes('PRIVATE_INBOX_SENTINEL'),'A news/detail lookup included the unrequested inbox section.');
  }
  return {text:JSON.stringify(output)};
 };
}

for(const provider of ['codex','claude']){
 test(`${provider}: held-out plural rankings preserve count, order and the requested source without broad reads`,async t=>{
  const f=fixture(t);
  for(const utterance of ["Give me the top three stories in today's Hacker News list.","Could you read the three highest scoring Hacker News stories from this morning?"]){
   const {value,reads}=await traceReads(f.root,()=>f.classify(provider,utterance));
   assert.equal(value.engine,'rules',utterance);assert.match(value.reply,/Quasar notebook.*Cedar compiler.*Otter runtime/);
   assert.doesNotMatch(value.reply,/Harbor database|Maple debugger|weather model/);
   assert.ok(reads.every(read=>!forbidden.test(read.path)),JSON.stringify(reads));
  }
  const answer=await f.speak(provider,'Which Hacker News story attracted the most discussion this morning?');
  assert.equal(answer.model,null);assert.match(answer.reply,/Harbor database/);assert.match(normalized(answer.reply),/2400/);assert.deepEqual(answer.workIds,[]);
  assert.deepEqual(f.terminalReads,[],'saved rankings do not need the terminal snapshot');
 });

 test(`${provider}: a broader briefing or explanation gets one bounded lookup model call rather than a truncated top story`,async t=>{
  const f=fixture(t);
  for(const utterance of ['Can you walk me through this morning\'s briefing?',"Why does the leading story in today's morning brief matter?"]){
   const seen=[];
   const {value,reads}=await traceReads(f.root,()=>f.speak(provider,utterance,compactModel(provider,utterance,seen)));
   assert.equal(seen.length,1,utterance);assert.equal(value.reply,compactReply);assert.deepEqual(value.workIds,[]);
   assert.match(seen[0].options.system,/weather model/);
   assert.ok(reads.every(read=>!forbidden.test(read.path)),JSON.stringify(reads));
  }
  assert.equal(f.calls.length,0);
 });

 test(`${provider}: five long ranked titles remain five audible items within the shared speech budget`,async t=>{
  const f=fixture(t),names=['AlphaExample','BravoExample','CharlieExample','DeltaExample','EchoExample'];
  f.writeBrief(f.today,'## Hacker News Pulse\n| Points | Comments | Story |\n|---|---|---|\n'+names.map((name,index)=>`| ${900-index*100} | ${80-index*10} | ${name} ${'detailed subject '.repeat(10)} |`).join('\n'));
  const answer=await f.speak(provider,'Read the top five Hacker News stories today.');
  assert.equal(answer.model,null);assert.ok(answer.reply.length<=880,`spoken payload has ${answer.reply.length} characters`);
  for(const name of names)assert.ok(answer.reply.includes(name),`${name} was lost from the requested five items`);
 });

 test(`${provider}: source filters, negation, other dates and live claims cannot be silently reduced to the saved leader`,async t=>{
  const f=fixture(t);
  for(const utterance of [
   'Which Hacker News story about databases got the most attention today?',
   "Tell me today's top Hacker News story, excluding Quasar notebook.",
   "Don't give me the leading story; give me a different Hacker News item from today.",
   'What led Hacker News on 2024-02-29?',
   'What is leading Hacker News at this exact moment?',
   'Read the eight most popular Hacker News stories from today.',
  ]){
   let modelCalls=0;
   const result=await f.speak(provider,utterance,async(_root,_job,_prompt,options)=>{modelCalls++;assert.equal(options.user,utterance);return {text:JSON.stringify({tier:2,reply:'The requested constraint needs clarification or another source.'})}});
   assert.ok(modelCalls<=1);assert.doesNotMatch(result.reply,/Quasar notebook.*(?:most points|1200|1,200)/,utterance);
   assert.equal(result.action,'reply');assert.deepEqual(result.workIds,[]);
  }
  assert.equal(f.calls.length,0);
 });

 test(`${provider}: a lookup joined to explicit creation retains the complete request and its provider`,async t=>{
  const f=fixture(t),utterance='Read the three leading Hacker News stories from today, then draft a comparison for my newsletter.';
  const result=await f.speak(provider,utterance,async(_root,job,_prompt,options)=>{assert.equal(job.provider,provider);assert.equal(options.user,utterance);return {text:JSON.stringify({tier:3,reply:'Working on the comparison.'})}});
  assert.equal(result.action,'task');assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'start');
  assert.ok(f.calls[0].prompt.includes(utterance));assert.equal(f.calls[0].selection.provider,provider);
 });

 test(`${provider}: quick local values preserve zero and daily semantics without a model or terminal dispatch`,async t=>{
  const f=fixture(t);
  const subscribers=await f.speak(provider,'How many people are subscribed to my YouTube channel?');assert.match(normalized(subscribers.reply),/43127/);
  const followers=await f.speak(provider,'What is my Instagram follower count?');assert.match(followers.reply,/\b0\b/);assert.doesNotMatch(followers.reply,/unavailable|missing|don't have/i);
  const schedule=await f.speak(provider,'Remind me what is on the calendar for today.');assert.match(schedule.reply,/Demo rehearsal/);
  const focus=await f.speak(provider,'What am I focusing on today?');assert.match(focus.reply,/offline reader/);
  assert.equal(f.calls.length,0);
 });

 test(`${provider}: missing, stale and future source files stay explicit even with a remembered unavailable task`,async t=>{
  const f=fixture(t);fs.unlinkSync(path.join(f.root,`inbox/research/morning-intel/${f.today}-intel.md`));
  f.writeBrief('2000-01-01',report.replaceAll('Quasar notebook','OLD_RANKING_SENTINEL'));f.writeBrief('2999-01-01',report.replaceAll('Quasar notebook','FUTURE_RANKING_SENTINEL'));
  const answer=await f.speak(provider,'Read the top three Hacker News stories from this morning.',undefined,{workTarget:'unavailable-current'});
  assert.match(answer.reply,/today|morning/i);assert.match(answer.reply,/2000-01-01|missing|don't have|not available/i);assert.doesNotMatch(answer.reply,/OLD_RANKING_SENTINEL|FUTURE_RANKING_SENTINEL/);assert.deepEqual(answer.workIds,[]);
  fs.rmSync(path.join(f.root,'inbox'),{recursive:true,force:true});
  const missing=await f.speak(provider,'What is the main AI headline today?');assert.match(missing.reply,/don't have|not available|missing/i);assert.deepEqual(missing.workIds,[]);
 });

 test(`${provider}: local saved values label staleness and do not invent missing metrics or today's plan`,async t=>{
  const f=fixture(t);
  f.write('system/metrics/metrics.csv','timestamp,source,metric,value,status,error\n2000-01-01T12:00:00Z,youtube,subscribers,123,stale,\n');
  const stale=await f.speak(provider,'How many subscribers does my YouTube channel have?');assert.match(stale.reply,/\b123\b/);assert.match(stale.reply,/last saved|stale|not a live/i);
  const absent=await f.speak(provider,'What is my TikTok follower count?');assert.match(absent.reply,/don't have|missing|not available|unavailable/i);assert.doesNotMatch(absent.reply,/\b0 followers/);
  fs.renameSync(path.join(f.root,`daily-notes/${f.today}.md`),path.join(f.root,'daily-notes/2000-01-01.md'));
  const plan=await f.speak(provider,'What is on my schedule today?');assert.match(plan.reply,/don't have|no (?:daily note|schedule)|missing/i);assert.doesNotMatch(plan.reply,/Demo rehearsal/);
  assert.equal(f.calls.length,0);
 });

 test(`${provider}: recent-report discovery returns recorded safe outputs without reading report bodies or unrelated vault data`,async t=>{
  const f=fixture(t),relative='inbox/research/fixture-review.md';
  f.write(relative,'REPORT_BODY_SENTINEL');
  f.write('system/v2/runs/report-1.json',JSON.stringify({status:'ok',skill:'deep-research-chase',label:'Saved compiler review',summary:'Measured local compiler behavior.',ts_completed:new Date().toISOString(),deliverable_path:relative}));
  f.write('system/v2/runs/bad-path.json',JSON.stringify({status:'ok',label:'OUTSIDE_PATH_SENTINEL',deliverable_path:'../outside.md'}));
  const {value,reads}=await traceReads(f.root,()=>f.speak(provider,'Which reports have finished recently?'));
  assert.match(value.reply,/Saved compiler review/);assert.doesNotMatch(value.reply,/OUTSIDE_PATH_SENTINEL|REPORT_BODY_SENTINEL/);assert.equal(value.model,null);assert.deepEqual(value.workIds,[]);
  assert.ok(!reads.some(read=>read.op==='readFileSync'&&read.path===relative),'report discovery reads receipts, not whole report content');
  assert.ok(!reads.some(read=>/^(?:daily-notes|system\/metrics)\//.test(read.path)),JSON.stringify(reads));
 });

 test(`${provider}: compact source fallback cannot execute a fabricated action or write`,async t=>{
  const f=fixture(t),utterance="Why does the leading story in today's morning brief matter?",before=fs.readFileSync(path.join(f.root,`daily-notes/${f.today}.md`),'utf8');
  for(const output of [
   {tier:1,skill:'morning-intel',reply:'Running an unrequested refresh.'},
   {tier:3,reply:'Opening a terminal.'},
   {tier:2,reply:'Done.',write:{kind:'top3',index:1,undo:false}},
   {tier:2,reply:'Opening it.',obsidian:{op:'command',id:'terminal:open-terminal.default.root'}},
  ]){
   const seen=[];
   await assert.rejects(f.speak(provider,utterance,compactModel(provider,utterance,seen,output)),error=>{
    assert.notEqual(error.code,'ERR_ASSERTION','The model fixture failed before reply validation was exercised.');
    return /invalid|lookup|read.only|reply/i.test(error.message);
   });
   assert.equal(seen.length,1);assert.equal(f.calls.length,0);assert.equal(fs.readFileSync(path.join(f.root,`daily-notes/${f.today}.md`),'utf8'),before);
  }
 });

 test(`${provider}: ordinal follow-ups use only the immediately preceding same-provider, same-task, fresh lookup`,async t=>{
  const valid=fixture(t),first=await valid.speak(provider,'Read the top three Hacker News stories from this morning.',undefined,{workTarget:'conversation-a'});
  const second=await valid.speak(provider,'What was number two on that list?',undefined,{workTarget:'conversation-a'});
  assert.equal(second.model,null);assert.match(second.reply,/Cedar compiler/);assert.doesNotMatch(second.reply,/Quasar notebook/);
  assert.deepEqual(second.workIds,[]);assert.ok(first.deliverable);
  const failures=[];
  for(const boundary of ['provider','task','age','date','intervening']){
   try{
   const f=fixture(t),initial=await f.speak(provider,'Read the top three Hacker News stories from this morning.',undefined,{workTarget:'conversation-a'});
   const receiptFile=path.join(f.root,`system/v2/voice-results/${initial.id}.json`),receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
   assert.ok(receipt.lookup,'ranked answer must retain typed lookup provenance');
   receipt.reply+=' PRIVATE_PRIOR_LOOKUP_SENTINEL';
   if(boundary==='age')receipt.ts=Date.now()-181000;
   if(boundary==='date')receipt.lookup.date='2000-01-01';
   fs.writeFileSync(receiptFile,JSON.stringify(receipt));
   if(boundary==='intervening')await f.speak(provider,'Open the dashboard');
   const nextProvider=boundary==='provider'?(provider==='codex'?'claude':'codex'):provider;
   let modelCalls=0;
   const answer=await f.speak(nextProvider,'What was number two on that list?',async(_root,_job,_prompt,options)=>{
    modelCalls++;assert.ok(!options.system.includes('PRIVATE_PRIOR_LOOKUP_SENTINEL'),`${boundary} boundary leaked the prior lookup into the model prompt`);return {text:JSON.stringify({tier:2,reply:'Which saved list do you mean?'})};
   },{workTarget:boundary==='task'?'conversation-b':'conversation-a'});
   assert.ok(modelCalls<=1);assert.doesNotMatch(answer.reply,/Cedar compiler/,boundary);assert.deepEqual(answer.workIds,[]);
   }catch(error){failures.push(`${boundary}: ${error.message}`)}
  }
  assert.deepEqual(failures,[]);
 });
}
