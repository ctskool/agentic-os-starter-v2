import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createJiti} from 'jiti';
import {routeVoice} from '../runner/bridge-core.mjs';
import {invalidateVoiceSnapshot} from '../runner/voice-router.mjs';
import {invalidateTargetIndex} from '../runner/voice-targets.mjs';
import {stopIntent,supersedeIntent,stripPleasantry} from '../runner/voice-stop.mjs';
import {compoundWork,compoundHint} from '../runner/lookup-fallback.mjs';
import {ARTIFACT_HANDOFF_INSTRUCTIONS} from '../runner/artifact-instructions.mjs';
const {rulesRoute}=createJiti(import.meta.url)('../runner/voice-rules.ts');

// The 2026-09-16 audit: small talk claimed sentences that carried a request,
// the add-task rule wrote a compound into the daily note, nothing spoken could
// stop a running task, and "answer this and draft that" got one route.
const state={generated_at:new Date().toISOString(),vault_root:'.',metrics:[],runner:null,latestVideo:null,daily:{isToday:true,date:'2026-09-16',top3:[{text:'Record the demo',done:false}],schedule:[],focus:'',drivers:[]},runs:[],queue:[],morning:null,outliers:null,trendingRepos:[],etas:{}};
const rulesReply=t=>{const r=rulesRoute(t,state);return r.fallthrough?null:r.reply};

test('small talk answers only when the whole utterance is small talk',()=>{
 assert.equal(rulesReply('thanks jarvis'),'Anytime.');assert.equal(rulesReply('Thank you so much!'),'Anytime.');
 assert.equal(rulesReply('can you hear me?'),'Loud and clear.');assert.equal(rulesReply("Hey, how's it going?"),'Running smooth — all systems green. What do you need?');
 assert.equal(rulesReply('good night'),"Goodnight. I'll keep watch.");assert.equal(rulesReply('okay cool'),'Standing by.');assert.match(rulesReply("what's up jarvis"),/^Not much/);
 for(const t of ['thanks jarvis, now research jev',"how's it going with the jev explainer",'can you hear me? okay research jev','good night, but first run the morning report',"what's up with the jev task",'how are you getting on with the explainer'])assert.doesNotMatch(String(rulesReply(t)||''),/Anytime|Loud and clear|Running smooth|Goodnight|Not much/,t);
});

test('a leading pleasantry is dropped from a request and kept when it is the whole utterance',()=>{
 assert.equal(stripPleasantry("Thanks. Now can you research Jev's pricing model?"),"Now can you research Jev's pricing model?");
 assert.equal(stripPleasantry('Can you hear me? Okay, research Jev.'),'research Jev.');
 assert.equal(stripPleasantry('Hey Jarvis, open my daily note'),'open my daily note');
 assert.equal(stripPleasantry('Great, do it'),'Great, do it');assert.equal(stripPleasantry('Great! Do it'),'Do it');
 for(const t of ['Nice, France, and Cannes: compare their populations.','Thanks. So far, this looks good.'])assert.equal(stripPleasantry(t),t.replace(/^Thanks\. /,''),t);
 for(const t of ['Thanks.','okay cool','Yes','No, cancel that','hi res image please','Thanks for the report, what did it say about sponsors?'])assert.equal(stripPleasantry(t),t,t);
});

test('the daily-note write rules never swallow a second request',()=>{
 for(const t of ['add record the demo to my tasks and draft an outline for it','check off priority two and then tell me what is left','mark the demo done and open my daily note'])assert.doesNotMatch(String(rulesReply(t)||''),/Added to today|Checked off|checked off|Unchecked|couldn't find/,t);
});

test('stop, supersede and compound intents are recognised narrowly',()=>{
 for(const t of ['stop','Stop that.','cancel that','Scratch that','okay stop, please','stop working on that','no, cancel it now','abort','Um, stop that.','Could you stop that please?','Please, stop what you’re doing.'])assert.ok(stopIntent(t),t);
 assert.deepEqual(stopIntent('stop Claude'),{provider:'claude'});assert.deepEqual(stopIntent('cancel the codex task'),{provider:'codex'});assert.deepEqual(stopIntent('stop that'),{provider:null});
 for(const t of ['stop the bleeding in the intro paragraph','cancel my 2pm meeting','stop after the first section and summarize','never mind','no'])assert.equal(stopIntent(t),null,t);
 for(const t of ['Actually, instead of that, create a one-page summary of how Jev works.','Actually, can you instead of explaining that, can you actually create a visual explainer of how Jev works?','scratch that, draft a tweet thread instead','change of plans: research Jev pricing','Instead, create a red square.'])assert.equal(supersedeIntent(t),true,t);
 for(const t of ['use blue instead of red','make the title larger','stop that','Create a poster with the text "stop that" in red.','Write a subtitle and drop that adjective.','Write a section explaining a change of plans.','Before you stop that, save a backup and write down the result.'])assert.equal(supersedeIntent(t),false,t);
 for(const t of ["What's our MRR looking like, and can you draft a LinkedIn post about it?",'Can you tell me how many subs we gained and draft a thank-you post?','Read me the top story, then create a graphic for it','Draft a post and tell me how many subs we have','Actually, instead of that, create a one-page summary of how Jev works.'])assert.equal(compoundWork(t),true,t);
 for(const t of ['Run the morning report and read it to me',"Check off priority two and then tell me what's left",'Is the runner down? Also open my daily note.','Open the morning intel brief and summarize it',"don't create anything, just tell me the MRR",'What is the biggest news in AI today?','create a visual explainer of how jev works','Did you read the brief and draft a post about it?','If we get approval, read the brief and draft a post.','Draft a post later and tell me the current subscriber count.','Have you already made the chart and drafted the post?'])assert.equal(compoundWork(t),false,t);
 assert.equal(compoundWork('Tell me the top story and please just draft a post about it.'),true);
});

test('workers are told that HTML cannot be shown',()=>{
 assert.match(ARTIFACT_HANDOFF_INSTRUCTIONS,/HTML, SVG and other web files cannot be displayed in Obsidian or on the dashboard/);
});

function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'voice-smalltalk-stop-')));
 t.after(()=>{invalidateVoiceSnapshot(root);invalidateTargetIndex(root);fs.rmSync(root,{recursive:true,force:true})});
 const calls=[],sessions=[];
 const terminals={live:new Map(),list:()=>sessions,get:id=>{const s=sessions.find(s=>s.id===id);if(!s)throw new Error('Task not found');return s},start:task=>{calls.push({kind:'start',...task});return {id:task.id}},send:(id,text)=>{calls.push({kind:'send',id,text})},stop:id=>{calls.push({kind:'stop',id});const s=sessions.find(s=>s.id===id);if(s)s.state='stopping';return s},startWorkflow:task=>{calls.push({kind:'workflow',...task});return {id:task.id}}};
 const model=async()=>({text:JSON.stringify({tier:3,reply:'Working on it.'})});
 const noModel=async(_r,_e,prompt)=>assert.fail(`No model call expected: ${prompt.slice(-200)}`);
 const speak=(transcript,{provider='codex',appScope='native',workTarget=null,execute=model}={})=>routeVoice(root,{id:crypto.randomUUID(),selection:{provider,model:provider==='codex'?'gpt-6-astra':'sonnet'},appScope,transcript,terminalMode:true,workTarget},undefined,execute,terminals,{resolveCli:()=>({command:'unused',prefix:[]}),reopenArtifact:()=>{}});
 const task=(state='working',title='Jev explainer',extra={})=>{const s={id:crypto.randomUUID(),provider:'codex',model:'gpt-6-astra',title,state,execution:'native',created:Date.now(),turns:[{id:'t1',ts:Date.now(),text:'Working.'}],...extra};sessions.push(s);return s};
 return {root,speak,calls,sessions,task,model,noModel};
}

test('a pleasantry in front of a request no longer eats the request',async t=>{
 const f=fixture(t);
 const research=await f.speak("Thanks. Now can you research Jev's pricing model?");
 assert.equal(research.workIds.length,1);assert.notEqual(research.reply,'Anytime.');
 // Routing drops the pleasantry; the worker still sees the words as spoken.
 const started=f.calls.find(c=>c.kind==='start');assert.match(started.prompt,/research Jev's pricing model/);assert.match(started.prompt,/Original voice request: Thanks\. Now can you research/);
 const mic=await f.speak('Can you hear me? Okay, research Jev.');
 assert.equal(mic.workIds.length,1);assert.notEqual(mic.reply,'Loud and clear.');
 const thanks=await f.speak('thanks jarvis',{execute:f.noModel});assert.equal(thanks.reply,'Anytime.');assert.deepEqual(thanks.workIds,[]);
});

test('asking how a selected task is going is a question about the task, not a greeting',async t=>{
 const f=fixture(t);const task=f.task('ready');
 const r=await f.speak("How's it going with the Jev explainer?",{workTarget:task.id});
 assert.notEqual(r.reply,'Running smooth — all systems green. What do you need?');
 assert.equal(f.calls.at(-1).kind,'send');assert.equal(f.calls.at(-1).id,task.id);
});

test('stop that stops the selected running task, the only running task otherwise, and says so when nothing runs',async t=>{
 const f=fixture(t);const selected=f.task('working','Jev explainer');
 const stopped=await f.speak('Stop that.',{workTarget:selected.id,execute:f.noModel});
 assert.equal(stopped.reply,'Stopped Jev explainer.');assert.deepEqual(f.calls,[{kind:'stop',id:selected.id}]);assert.equal(stopped.stopped.taskId,selected.id);assert.deepEqual(stopped.workIds,[]);
 const other=f.task('working','Sponsor research');
 const unselected=await f.speak('cancel that',{execute:f.noModel});
 assert.equal(unselected.reply,'Stopped Sponsor research.');assert.equal(f.calls.at(-1).id,other.id);
 const idle=await f.speak('stop',{execute:f.noModel});
 assert.equal(idle.reply,'Nothing is running right now.');assert.equal(f.calls.length,2);
 f.task('working','One');f.task('working','Two');
 const two=await f.speak('stop that',{execute:f.noModel});
 assert.match(two.reply,/^2 tasks are running: One, Two\. Select the one to stop/);assert.equal(f.calls.length,2);
});

test('instead of that while work is running stops it and starts the new request as its own conversation; a tweak to idle work is a follow-up',async t=>{
 const f=fixture(t);const busy=f.task('working','Jev explainer');
 const replaced=await f.speak('Actually, instead of that, create a one-page summary of how Jev works.',{workTarget:busy.id,execute:f.noModel});
 assert.deepEqual(f.calls.map(c=>c.kind),['stop','start']);assert.equal(f.calls[0].id,busy.id);
 assert.equal(replaced.workIds.length,1);assert.notEqual(replaced.workIds[0],busy.id);assert.equal(replaced.workTarget,null);
 assert.match(replaced.reply,/^Stopped Jev explainer\. /);assert.match(f.calls[1].prompt,/create a one-page summary of how Jev works/);
 const idle=f.task('ready','Diagram');
 const tweak=await f.speak('Use blue instead of red',{workTarget:idle.id});
 assert.deepEqual(tweak.workIds,[idle.id]);assert.equal(f.calls.at(-1).kind,'send');assert.equal(tweak.stopped,undefined);
});

test('created work joined to a question goes to the worker whole, without a model, and named workflows do not',async t=>{
 const f=fixture(t);
 const r=await f.speak("What's our MRR looking like, and can you draft a LinkedIn post about it?",{execute:f.noModel});
 assert.equal(r.workIds.length,1);assert.equal(r.engine,'rules');
 const started=f.calls.find(c=>c.kind==='start');assert.match(started.prompt,/MRR looking like, and can you draft a LinkedIn post/);
 const workflow=await f.speak('Run the morning report and read it to me');
 assert.notEqual(workflow.engine,'rules');
});

test('a stop never touches a foreign selection, and a named provider is honoured',async t=>{
 const f=fixture(t);
 const claude=f.task('working','Claude research',{provider:'claude',model:'sonnet'});
 const web=f.task('working','Web task',{execution:undefined});
 for(const [transcript,foreign] of [['Stop that.',claude],['Stop that.',web],['Instead of that, create a red square.',claude]]){
  await assert.rejects(f.speak(transcript,{workTarget:foreign.id,execute:f.noModel}),/No task was stopped|belongs to the other app|different provider|unavailable/);
  assert.equal(f.calls.filter(c=>c.kind==='stop').length,0,transcript);
 }
 const codex=f.task('working','Codex explainer');
 const named=await f.speak('Stop Claude.',{workTarget:codex.id,execute:f.noModel});
 assert.equal(named.reply,'Stopped Claude research.');assert.deepEqual(f.calls.filter(c=>c.kind==='stop').map(c=>c.id),[claude.id]);
 assert.equal(codex.state,'working');
});

test('quoted text and questions never stop or start work, and a referent-less compound still asks',async t=>{
 const f=fixture(t);const busy=f.task('working','Jev explainer');
 const quoted=await f.speak('Create a poster with the text "stop that" in red.',{workTarget:busy.id});
 assert.equal(f.calls.filter(c=>c.kind==='stop').length,0);assert.equal(quoted.stopped,undefined);assert.equal(f.calls.at(-1).kind,'send');assert.equal(f.calls.at(-1).id,busy.id);
 const question=await f.speak('Did you read the brief and draft a post about it?',{workTarget:null});
 assert.notEqual(question.engine,'rules','a question is never rules-routed as compound work');
});

test('a referent-less compound with no history and no selection still asks what to work with',async t=>{
 const f=fixture(t);
 const referent=await f.speak('Make it a little larger and create a PDF for me please',{execute:f.noModel});
 assert.equal(referent.reply,'What would you like me to work with?');assert.deepEqual(referent.workIds,[]);
 const shorter=await f.speak('Make it larger and create a PDF',{execute:f.noModel});
 assert.equal(shorter.reply,'What would you like me to work with?');
});

test('a courtesy comma does not bypass a missing compound reference',async t=>{
 const f=fixture(t);
 for(const transcript of ['Um, make it larger and create a PDF.','Well, make it larger and create a PDF.','Please, make it larger and create a PDF.']){
  const result=await f.speak(transcript,{execute:f.noModel});
  assert.equal(result.reply,'What would you like me to work with?',transcript);
  assert.deepEqual(result.workIds,[]);
 }
 assert.equal(f.calls.length,0);
});

test('queued voice work retains literal content removed for routing',async t=>{
 const f=fixture(t),id=crypto.randomUUID();
 const file=path.join(f.root,'system/v2/runner-status.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({ts:new Date().toISOString(),busy:false}));
 const transcript='Nice! Create a poster using that word as its only text.';
 await routeVoice(f.root,{id,transcript,selection:{provider:'codex',model:'gpt-6-astra'},terminalMode:false,appScope:'native'},undefined,f.noModel,f.terminals,{resolveCli:()=>({command:'unused',prefix:[]})});
 const job=JSON.parse(fs.readFileSync(path.join(f.root,'system/v2/queue',id+'.json'),'utf8'));
 assert.equal(job.args.prompt,transcript);assert.equal(f.calls.length,0);
});

// --- second audit (2026-09-16, later) ---
test('a replacement phrase replaces the task only from a closed list and only before punctuation, "and" or "then"',()=>{
 for(const t of ['Instead of stopping that, create a progress report.','Instead of cancelling it, write a status note.','Instead of terminating it, create a progress report.','Instead of red, use blue and create a larger heading.','Drop that adjective and write a shorter title.','Drop that design element and make the title bigger.','Forget that detail and write the intro.','Scratch that line and draft a new one.','Stop that animation from looping and create a static preview.','Stop that after you finish the current section and create a summary.',
  // No comma, no conjunction: unrecognised, so it stays a follow-up rather than a stop.
  'Instead create a red square'])assert.equal(supersedeIntent(t),false,t);
 for(const t of ['Instead, create a poster saying "Hello".','Instead of finishing that, write up what you have so far.','Scratch that and write a haiku instead.','Scratch that entirely and create a chart instead.','Forget that completely, draft a memo.','Forget that idea, draft a memo.','Drop that, make a chart.','Never mind that, research Jev pricing.','Actually, instead of that one, create a diagram.','Instead of doing that, can you write a summary?','Instead of explaining that, create a visual explainer.'])assert.equal(supersedeIntent(t),true,t);
});

test('an alternative to stopping never stops the selected task',async t=>{
 const f=fixture(t);const busy=f.task('working','Jev explainer');
 for(const transcript of ['Instead of stopping that, create a progress report.','Stop that after you finish the current section and create a summary.']){
  const r=await f.speak(transcript,{workTarget:busy.id}).catch(error=>({reply:error.message,workIds:[]}));
  assert.ok(!f.calls.some(c=>c.kind==='stop'),transcript);assert.equal(r.stopped,undefined,transcript);assert.equal(busy.state,'working',transcript);
 }
 assert.deepEqual(f.calls.map(c=>c.kind),['send','send'],'both alternatives reached the worker as follow-ups');
 const replaced=await f.speak('Instead, create a poster saying "Hello".',{workTarget:busy.id,execute:f.noModel});
 assert.deepEqual(f.calls.slice(2).map(c=>c.kind),['stop','start']);assert.match(replaced.reply,/^Stopped Jev explainer\. /);
});

test('compound questions, habits and deferrals stay out of the worker',()=>{
 for(const t of ['Well, did you read the brief and draft a post about it?','What did you read in the saved brief and research yesterday?','Which brief did you read and research last week?','Which sections of the brief did you read and research yesterday?','Does she read the brief and draft a post every day?','Did the team read the brief and draft a post?','Can you tell me whether you normally read the brief and draft a post?','How do you usually read the brief and draft a post?','Read the brief and draft a post, but not yet.','Read the brief and draft a post once the client approves.','Read the brief and draft a post after the meeting.','Alright, have you made the chart and drafted the post?'])assert.equal(compoundWork(t),false,t);
 for(const t of ['What is the top story and can you draft a post about it?',"What's the biggest news in AI today, and create a visual explainer of it",'What was the biggest news on HN today, and draft a video outline?','Read the brief and draft a post once you have read it.',"Create a chart and when it's done open it.",'Tell me the top story and please just draft a post about it.'])assert.equal(compoundWork(t),true,t);
 // A question that carries work still keeps the readers away from it.
 for(const t of ['Did you read the brief and draft a post about it?','Which sections of the brief did you read and research yesterday?'])assert.equal(compoundHint(t),true,t);
 for(const t of ['Run the morning report and read it to me','What is the biggest news in AI today?'])assert.equal(compoundHint(t),false,t);
});

test('a time phrase after this is not a missing reference',async t=>{
 for(const transcript of ["Make this month's revenue chart and draft a summary.","Explain this week's AI news and create a diagram.","Summarize this week's brief and draft a post about it."]){
  const f=fixture(t);const r=await f.speak(transcript,{execute:f.noModel});
  assert.notEqual(r.reply,'What would you like me to work with?',transcript);assert.equal(r.workIds.length,1,transcript);
 }
 for(const transcript of ['Make this one larger and create a PDF.','Make this time-efficient and create a PDF.']){
  const f=fixture(t);const r=await f.speak(transcript,{execute:f.noModel});
  assert.equal(r.reply,'What would you like me to work with?',transcript);
 }
});

test('the add-task rule joins a personal title, never a second sentence or a trailing question',()=>{
 for(const t of ['Add record the demo to my tasks and please can you tell me what is left?','Add record the demo to my tasks and what is left on my list?','Add record the demo to my tasks and how many are left?','Add contact Acme Inc. What should I ask them?','Add review Plan B. Who owns it?'])assert.equal(rulesReply(t),null,t);
 assert.doesNotMatch(String(rulesReply('Add record the demo to my tasks and is the runner up?')||''),/Added to today/);
 for(const t of ['Add call Dr. Smith to my tasks.','Add email Mr. Jones to my tasks','Add record the demo to my tasks'])assert.throws(()=>rulesRoute(t,state),/Voice request context is missing/,t);
});
