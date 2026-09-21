import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {routeVoice} from '../runner/bridge-core.mjs';
import {setCurrent} from '../runner/current-conversations.mjs';
import {JEV_REVISION,classifierProcesses} from '../runner/jev.mjs';
import {invalidateStrictIndex,invalidateTargetIndex} from '../runner/voice-targets.mjs';

// Parity for the strict local rules, through the real routeVoice, with no Jev
// anywhere near them. Off and shadow must be identical in every scenario. With
// the rules on, only an action that code confirmed and validated may differ from
// off; everything else must be the model's answer, untouched.
const unhandled=[];process.on('unhandledRejection',error=>unhandled.push(error));
const tick=(ms=0)=>new Promise(resolve=>setTimeout(resolve,ms));
const FILES=['projects/streak-plan.md','projects/2026-04-30-content-backfill-plan.md','inbox/archive/2026-04-06-webinar-best-practices-research.md',
 'acme/research/launch-draft.md','acme/launch/research/draft.md','acme/partials/launch-research.md','acme/partials/research-launch-notes.md',
 'inbox/reports/weekly/2026-09-07-weekly-review.md','inbox/reports/weekly/2026-09-14-weekly-review.md','projects/2026-09-10-draft-script.md'];
const MODEL={tier:2,reply:'The model answered this one.'};

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-strict-parity-'));
 t.after(()=>{invalidateStrictIndex(root);invalidateTargetIndex(root);fs.rmSync(root,{recursive:true,force:true})});
 for(const relative of FILES){const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'# fixture\n')}
 const selection={provider:'codex',model:'gpt-6-astra'},calls=[],tasks=[],records=[];
 const get=id=>{const task=tasks.find(item=>item.id===id);if(!task)throw new Error('Task not found');return task};
 const terminals={live:new Map(),list:()=>tasks,get,
  send(id,text){calls.push({kind:'send',to:get(id).title,text});return get(id)},
  start(options){const task={id:options.id,...options.selection,title:options.title,state:'working',turns:[]};tasks.push(task);calls.push({kind:'start',title:options.title});return task},
  startWorkflow(options){calls.push({kind:'workflow',skill:options.skill});return {id:options.id}},continueWorkflow(id,options){calls.push({kind:'continue-workflow',skill:options.skill});return get(id)}};
 const add=(fields={})=>{const task={id:crypto.randomUUID(),...selection,title:'Revenue chart',state:'ready',created:Date.now(),turns:[{text:'Saved the chart.',ts:Date.now(),artifacts:[{id:'chart-1',path:'inbox/demo-assets/revenue-chart.png',mime:'image/png',label:'revenue chart',isFinal:true}]}],...fields};tasks.push(task);if(task.provider===selection.provider)setCurrent(root,terminals,{provider:selection.provider,id:task.id});return task};
 return {root,selection,calls,tasks,terminals,add,records};
}
const model=(answer,seen)=>(_root,_job,_prompt,options)=>new Promise((resolve,reject)=>{
 seen.modelCalls=(seen.modelCalls||0)+1;
 const timer=setTimeout(()=>resolve({text:JSON.stringify(typeof answer==='function'?answer(options.user):answer)}),15);
 const stop=()=>{clearTimeout(timer);seen.aborted=true;reject(new Error('Voice request cancelled'))};
 if(options.signal?.aborted)stop();else options.signal?.addEventListener('abort',stop,{once:true});
});
const ARMS={off:null,shadow:{open:'shadow',ui:'shadow'},on:{open:'on',ui:'on'}};
const JEV_OFF={config:{key:'',mode:{codex:'off',claude:'off'},theta:null,deadlineMs:600,tier2kind:false},classify:()=>assert.fail('Jev must not be consulted when it is off'),log:()=>assert.fail('nothing is recorded when Jev is off')};
// Work is acknowledged from a rotating pool, so that one reply is not compared.
const outcome=receipt=>receipt.error?{error:receipt.error}:{tier:receipt.tier,engine:receipt.engine,model:receipt.model,action:receipt.action,skill:receipt.skill,reply:receipt.action==='task'?'<acknowledgment>':receipt.reply,obsidian:receipt.obsidian,deliverable:receipt.deliverable,reveal:receipt.reveal,reveals:receipt.reveals,reopened:receipt.reopened||null,panels:receipt.panels,lookupRoute:receipt.lookupRoute||null,pendingSkill:receipt.pendingSkill||null,work:receipt.workIds?.length||0,rule:receipt.decision?.rule,effects:receipt.decision?.effects};
const settle=async()=>{for(let i=0;i<2000&&classifierProcesses().total;i++)await tick(5);assert.equal(classifierProcesses().total,0,'work was still owned after 10 s');await tick(5)};
const STRICT=new Set(['router.strictOpen','router.strictUi']);
async function arms(t,say,{selected=false,answer=MODEL,newConversation=false,setup=[],jev=JEV_OFF,only=Object.keys(ARMS)}={}){
 const runs={};
 for(const name of only){
  const fx=fixture(t),target=selected?fx.add(typeof selected==='object'?selected:{}):null,seen={};
  const strict=ARMS[name]?{config:ARMS[name],log:(_root,_id,record)=>fx.records.push(record)}:{config:{open:'off',ui:'off'},log:()=>assert.fail('nothing is recorded when the strict rules are off')};
  const speak=(transcript,reply)=>routeVoice(fx.root,{id:crypto.randomUUID(),transcript,selection:fx.selection,terminalMode:true,workTarget:target?.id||null},undefined,model(reply,seen),fx.terminals,{resolveCli:()=>({command:'unused-test-cli',prefix:[]}),updateCurrent:()=>{},jev,strict}).catch(error=>({error:error.message}));
  for(const step of setup){await speak(step.say,step.model||MODEL);await settle();seen.modelCalls=0;seen.aborted=undefined;fx.records.length=0;fx.calls.length=0;await tick(3)}
  const receipt=await speak(newConversation?`Start a new conversation: ${say}`:say,answer);
  await settle();
  runs[name]={fx,seen,receipt,outcome:outcome(receipt),record:fx.records.at(-1)||null};
 }
 if(runs.shadow&&runs.off){
  assert.deepEqual(runs.shadow.outcome,runs.off.outcome,`shadow changed the outcome of: ${say}`);assert.deepEqual(runs.shadow.fx.calls,runs.off.fx.calls,`shadow changed what was dispatched for: ${say}`);
  assert.equal(runs.shadow.seen.modelCalls||0,runs.off.seen.modelCalls||0,`shadow changed whether the model was asked: ${say}`);
  assert.equal(fs.existsSync(path.join(runs.off.fx.root,'system/v2/strict-shadow')),false,'off left a record folder');
 }
 return runs;
}
const unchanged=(runs,say)=>{
 assert.deepEqual(runs.on.outcome,runs.off.outcome,`the strict rules changed the outcome of: ${say}`);assert.deepEqual(runs.on.fx.calls,runs.off.fx.calls,say);
 assert.equal(runs.on.seen.modelCalls||0,runs.off.seen.modelCalls||0,`the strict rules changed whether the model was asked: ${say}`);assert.ok(!STRICT.has(runs.on.receipt.decision?.rule),say);
};

test('every sentence that fooled a confident label is refused by code alone, and the model answers',async t=>{
 const chart={},markdownOnly={turns:[{text:'Saved the notes.',ts:Date.now(),artifacts:[{id:'notes-1',path:'projects/streak-plan.md',mime:'text/markdown',label:'notes',isFinal:true}]}]};
 const wrong=[
  ['Can I see how you made that graphic?',chart],['Pop open the graphic you made only after I approve it',chart],['Can I see the previous graphic?',chart],['Can I see that graphic?',markdownOnly],
  ['Can I see the poster you made?',chart],['Can I see the graphic you made in a split?',chart],['Can I see the previous weekly review?',false],['Can I see a summary of the weekly review?',false],['Can I see the weekly review from this Friday',false],
  ['Can you have a look at the webinar best practices research?',false],['Pop open the webinar best practices research in a new window',false],['Pop open the webinar best practices research in a new tab',false],
  ['Pop open the Acme launch research draft',false],['Pop open the context backfill plan',false],['Can I see the streak plan png',false],['Can I see the files in the weekly review',false],['Can I see the note about the file called content backfill plan',false],['Can I see the document about the file named streak plan',false],['Can I see the files in the content backfill plan',false],['Can I see the notes from the streak plan',false],['Can I see the latest draft script',false],['Can I see the current streak plan',false],['Can I see the weekly review in a list',false],['Can I see the past week weekly review',false],['Pop open the streak plan and then draft a summary of it',false],['Do not pop open the streak plan',false],['Pull my metrics up to date',false],
  ['Make it bigger.',chart],['Display this graph.',chart],['Display the graph view',chart],['Show the terminal please',chart],['Collapse the left sidebar',false],['Show my calendar in a new tab',false],
  ['Close this tab on the right',false],['Move Gmail to the right',false],['Go forward to the previous note',false],['Close the deal tab notes',false],['Show the terminal please',false]];
 let reached=0;
 for(let start=0;start<wrong.length;start+=6)await Promise.all(wrong.slice(start,start+6).map(async([say,selected])=>{
  const runs=await arms(t,say,{selected});unchanged(runs,say);
  // Reached the boundary: a record exists and says why nothing happened.
  if(runs.on.record){
   reached++;assert.equal(runs.on.record.acted,false,say);assert.ok(runs.on.record.blockedBy||runs.on.record.reason,`no reason recorded for: ${say}`);
   // A guard may stop a sentence the grammar would accept (the record then shows what it cost).
   // Where no guard stood in the way, the grammar itself must have refused.
   if(!runs.on.record.blockedBy)assert.equal(runs.on.record.candidate,null,`code confirmed: ${say}`);
  }
 }));
 assert.ok(reached>=20,`only ${reached} scenarios reached the boundary`);
});

test('an earlier turn that changes the meaning keeps a perfectly plain command with the model',async t=>{
 const framed=async(say,options,reason)=>{
  const runs=await arms(t,say,options);unchanged(runs,say);
  assert.equal(runs.on.seen.modelCalls,1,`the model was not asked: ${say}`);assert.equal(runs.on.record?.blockedBy,reason,`${say}: ${JSON.stringify(runs.on.record)}`);
  // The record still shows what the rules would have done: that is what the guard cost, or saved.
  assert.equal(runs.on.record.deferred,true);assert.equal(runs.on.record.acted,false);
  return runs;
 };
 const dictation={say:"I'm dictating lines for a video script. Transcribe my next sentence exactly and do not open anything.",model:{tier:2,reply:'Ready for your line.'}};
 const list={say:"Help me build a list of voice commands that failed yesterday. I'll say them one at a time.",model:{tier:2,reply:'Go ahead with the first one.'}};
 for(const say of ['Pop open the streak plan','Close this tab please']){
  const saved=await framed(say,{setup:[dictation]},'frame:history');assert.ok(saved.on.record.candidate,'the guard, not the grammar, is what stopped this');
  await framed(say,{setup:[list]},'frame:history');
  // Codex, plan round 1: a keyword rule answers the framing sentence, so "a rule answered it" proves nothing.
  const keyword=await framed(say,{setup:[{say:"I'm practicing commands for the runner. My next sentence is dictation; repeat it without executing it."}]},'frame:history');
  assert.ok(keyword.on.record.candidate);
  // Codex, plan round 2: a frame behind an open lead, answered by a keyword rule.
  await framed(say,{setup:[{say:'Pop open runner status and treat my next sentence as dictation'}]},'frame:history');
  // A chain: the frame, then a command today's rules claim, then this sentence.
  await framed(say,{setup:[dictation,{say:'Open the streak plan'}]},'frame:history');
  // An open taken by today's rules leaves no recorded proof, so it is not a plain command.
  await framed(say,{setup:[{say:'Open the streak plan'}]},'frame:history');
  // Any selected conversation: idle, working, waiting for input, or the other provider's.
  for(const selected of [{},{state:'working'},{state:'needs input'},{turns:[{text:'Done long ago.',ts:Date.now()-11*60*1000}],created:Date.now()-40*60*1000}])await framed(say,{selected},'frame:selected');
 }
 // A workflow is waiting for its URL: whatever comes next belongs to that exchange.
 const pending=await framed('Pop open the streak plan',{setup:[{say:'The Content Cascade workflow is what I want you to execute, but I have not supplied a URL yet.',model:{tier:1,skill:'content-cascade',reply:'On it.'}}]},'excluded:pendingSkill');
 assert.equal(pending.on.receipt.reply,MODEL.reply);
 // A yes to an offer: the router rewrites the request from the offer, and only the model may interpret it.
 const accepted=await arms(t,'Yes.',{setup:[{say:'What is the exact attendance count for the design meetup?',model:{tier:2,reply:"I don't have that count. Want me to open the streak plan?"}}],answer:{tier:2,reply:'',obsidian:{op:'open-note',query:'streak plan'}}});
 unchanged(accepted,'Yes.');
 // A sentence that asks about work: the model is also shown summaries of unselected work.
 await framed('Show the terminal please',{},'work-history');
 // The other provider's conversation is rejected the same way with or without the rules.
 const foreign=await arms(t,'Close this tab please',{selected:{provider:'claude',model:'sonnet',title:'Claude conversation'},answer:{tier:3,reply:'Working.'}});
 assert.deepEqual(foreign.on.fx.calls,foreign.off.fx.calls);assert.deepEqual(foreign.on.outcome,foreign.off.outcome);
});

test('excluded requests, new conversations and explicit work never reach the strict checks',async t=>{
 const fresh=await arms(t,'pop open the streak plan',{newConversation:true,answer:{tier:3,reply:'Working on that.'}});
 assert.deepEqual(fresh.on.outcome.obsidian,fresh.off.outcome.obsidian);assert.ok(!STRICT.has(fresh.on.receipt.decision?.rule));assert.equal(fresh.on.record?.blockedBy,'new-conversation');
 for(const say of ['Pop open the weekly review and also the morning intel story','Show YouTube Studio in a split','Pop open the weekly review report']){
  const runs=await arms(t,say);unchanged(runs,say);assert.equal(runs.on.record?.blockedBy,'excluded:compound',say);
 }
 const tasks=[{title:'Open',prompt:'pop open the streak plan'},{title:'Close',prompt:'close this tab'}];
 const separate=await arms(t,'Start separate tasks: pop open the streak plan and close this tab',{answer:{tier:3,reply:'Working on both.',tasks}});
 assert.deepEqual(separate.on.outcome,separate.off.outcome);assert.deepEqual(separate.on.fx.calls,separate.off.fx.calls);
 const long=await arms(t,`Pop open the streak plan ${'and keep in mind the context I gave you earlier '.repeat(40)}but do not open anything yet.`);unchanged(long,'a very long request');
});

test('a confirmed open returns the exact file like a rules result, and no model is ever started',async t=>{
 const runs=await arms(t,'Pop open the streak plan');
 assert.equal(runs.off.outcome.reply,MODEL.reply);assert.equal(runs.off.receipt.decision.rule,'model.general');assert.equal(runs.off.seen.modelCalls,1);
 const receipt=runs.on.receipt;
 assert.deepEqual(receipt.obsidian,{op:'open-note',query:'projects/streak-plan.md'});assert.equal(receipt.reply,'');assert.equal(receipt.action,'reply');assert.deepEqual(receipt.workIds,[]);assert.deepEqual(runs.on.fx.calls,[]);
 assert.equal(receipt.decision.source,'rules');assert.equal(receipt.decision.rule,'router.strictOpen');assert.deepEqual(receipt.decision.rawIntent,{tier:2,kind:'local-open'});assert.deepEqual(receipt.decision.guarded,{tier:2});assert.deepEqual(receipt.decision.effects,['ui']);
 assert.equal(receipt.decision.jev,null);assert.equal(receipt.decision.fallbackModel,null);assert.equal(typeof receipt.decision.timing.strictMs,'number');
 // No model ran, and the receipt says so: rules, no model name, tier 1.
 assert.equal(runs.on.seen.modelCalls||0,0);assert.equal(receipt.engine,'rules');assert.equal(receipt.model,null);assert.equal(receipt.tier,1);assert.equal(receipt.lookupRoute,'open');
 assert.deepEqual(runs.on.record,{...runs.on.record,blockedBy:null,acted:true,deferred:false,kind:'open',stage:'confirmed',candidate:{kind:'open',action:{obsidian:{op:'open-note',query:'projects/streak-plan.md'}}}});
 // Shadow records the same would-be action and changes nothing.
 assert.equal(runs.shadow.record.acted,false);assert.equal(runs.shadow.record.deferred,true);assert.deepEqual(runs.shadow.record.candidate,runs.on.record.candidate);assert.equal(runs.shadow.outcome.reply,MODEL.reply);
 // The same file the rules path opens for a phrasing it knows.
 const known=await arms(t,'Open the streak plan');
 assert.deepEqual(known.off.outcome.obsidian,receipt.obsidian);assert.equal(known.off.receipt.decision.rule,'router.openRequest');assert.equal(known.on.receipt.decision.rule,'router.openRequest');assert.equal(known.on.record,null);
 // A saved report opens through the deliverable channel, like the rules path.
 const report=await arms(t,'I wanna see the weekly review');
 assert.equal(report.on.receipt.deliverable,'inbox/reports/weekly/2026-09-14-weekly-review.md');assert.equal(report.on.receipt.reveal,'open');assert.equal(report.on.receipt.obsidian,null);assert.equal(report.on.receipt.decision.rule,'router.strictOpen');assert.equal(report.off.receipt.decision.rule,'model.general');
 // A work-word inside the file name is what kept the rules path from opening it.
 const draft=await arms(t,'Open the draft script');
 assert.equal(draft.off.receipt.decision.rule,'model.general');assert.deepEqual(draft.on.receipt.obsidian,{op:'open-note',query:'projects/2026-09-10-draft-script.md'});
});

test('a confirmed UI command goes through the unchanged validators and is recorded as a rules result',async t=>{
 const runs=await arms(t,'Close this tab please');
 assert.equal(runs.off.outcome.reply,MODEL.reply);
 const receipt=runs.on.receipt;
 assert.deepEqual(receipt.obsidian,{op:'command',id:'workspace:close',label:'close tab'});assert.equal(receipt.reply,'');assert.deepEqual(runs.on.fx.calls,[]);
 assert.equal(receipt.decision.source,'rules');assert.equal(receipt.decision.rule,'router.strictUi');assert.deepEqual(receipt.decision.rawIntent,{tier:2,kind:'local-ui'});assert.deepEqual(receipt.decision.effects,['ui']);
 assert.equal(runs.on.seen.modelCalls||0,0);assert.equal(receipt.engine,'rules');assert.equal(receipt.model,null);assert.equal(receipt.tier,1);
 assert.deepEqual(runs.shadow.record.candidate,{kind:'ui',action:{obsidian:receipt.obsidian}});
 // Placement survives exactly as spoken.
 const placed=await arms(t,'Can you pull Gmail up on the right side');
 assert.deepEqual(placed.on.receipt.obsidian,{op:'web',url:'https://mail.google.com',label:'gmail',where:'right-sidebar'});assert.equal(placed.on.receipt.decision.rule,'router.strictUi');
 // "Open up my daily note": the open grammar accepts the words too, but they name no file, so there is one reading.
 const daily=await arms(t,'Bring up my daily note');
 if(STRICT.has(daily.on.receipt.decision?.rule))assert.deepEqual(daily.on.receipt.obsidian,{op:'daily-note'});else unchanged(daily,'Bring up my daily note');
});

test('a run of plain commands is not a conversation: recorded strict actions and closed-grammar UI commands do not block the next one',async t=>{
 // After a strict open (its receipt is the proof) and a strict UI command.
 const run=await arms(t,'Close this tab please',{setup:[{say:'Pop open the streak plan'},{say:'Toggle the left sidebar'}],only:['on']});
 assert.equal(run.on.receipt.decision.rule,'router.strictUi');assert.equal(run.on.seen.modelCalls||0,0);assert.equal(run.on.record.blockedBy,null);
 const second=await arms(t,'Pop open the streak plan',{setup:[{say:'Close this tab please'}],only:['on']});
 assert.equal(second.on.receipt.decision.rule,'router.strictOpen');
 // The same run in shadow acts on nothing, so each earlier turn was written by the model and the window is a conversation.
 const watched=await arms(t,'Close this tab please',{setup:[{say:'Pop open the streak plan'}],only:['shadow']});
 assert.equal(watched.shadow.record.blockedBy,'frame:history');assert.equal(watched.shadow.receipt.reply,MODEL.reply);
});

test('the strict rules and Jev do not meet: a strict action never asks Jev, and everything else reaches the hedge unchanged',async t=>{
 const tier3={route:'tier3',tier:3,skill:null,p:0.97,kind:'written',kp:0.9,revision:JEV_REVISION,pinned:true,ms:4,socketReused:true};
 let asked=0;const shadow=[];
 const jev={config:{key:'sk-or-test-key-000000',mode:{codex:'fastpath',claude:'fastpath'},theta:0.9,deadlineMs:600,tier2kind:true},classify:async()=>{asked++;return tier3},log:(_r,_i,_b,entry)=>shadow.push(entry)};
 const opened=await arms(t,'Pop open the streak plan',{jev,only:['on']});
 assert.equal(opened.on.receipt.decision.rule,'router.strictOpen');assert.equal(asked,0,'Jev was asked about a request the rules had already answered');assert.equal(shadow.length,0);
 const work=await arms(t,'What I need next is a one-page guide comparing solar and wind power.',{jev,answer:{tier:3,reply:'Working on the guide.'},only:['off','on']});
 assert.equal(work.on.receipt.decision.rule,'jev.earlyExit');assert.equal(work.off.receipt.decision.rule,'jev.earlyExit');assert.deepEqual(work.on.fx.calls.map(call=>call.kind),work.off.fx.calls.map(call=>call.kind));
});

test('a would-be check that runs after midnight still means the day of the request',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-03-10T23:59:50-05:00').getTime()});
 const fx=fixture(t);fs.writeFileSync(path.join(fx.root,'projects/2026-03-10-launch-notes.md'),'# fixture\n');
 let runQueued;const seen={};
 const receipt=await routeVoice(fx.root,{id:crypto.randomUUID(),transcript:"Pop open today's launch notes",selection:fx.selection,terminalMode:true,workTarget:null},undefined,model(MODEL,seen),fx.terminals,{resolveCli:()=>({command:'unused-test-cli',prefix:[]}),updateCurrent:()=>{},jev:JEV_OFF,strict:{config:{open:'shadow',ui:'off'},log:(_root,_id,record)=>fx.records.push(record),defer:callback=>{runQueued=callback}}});
 assert.equal(receipt.reply,MODEL.reply);
 for(let i=0;i<100&&!runQueued;i++)await tick(5);
 assert.equal(typeof runQueued,'function','the would-be check was never queued');
 t.mock.timers.setTime(new Date('2026-03-11T00:00:20-05:00').getTime());
 runQueued();await settle();
 assert.deepEqual(fx.records.at(-1)?.candidate,{kind:'open',action:{obsidian:{op:'open-note',query:'projects/2026-03-10-launch-notes.md'}}},`resolved against the wrong day: ${JSON.stringify(fx.records.at(-1))}`);
});

test('no unhandled rejections escaped and nothing is left owned',async()=>{await tick(60);assert.deepEqual(unhandled,[]);assert.equal(classifierProcesses().total,0)});
