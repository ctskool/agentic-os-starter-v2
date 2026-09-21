import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {routeVoice} from '../runner/bridge-core.mjs';
import {classifyVoice,invalidateVoiceSnapshot,rules} from '../runner/voice-router.mjs';
import {withVoiceContext} from '../runner/voice-context.mjs';
import {readVoiceReport} from '../runner/voice-documents.mjs';
import {localDate} from '../runner/brief-voice.mjs';

const targets=[
 ['morning-intel','morning Intel brief','inbox/research/morning-intel'],
 ['github-trending','GitHub trending report','inbox/research/github-trending'],
 ['outlier-radar','outlier radar report','inbox/research/outlier-radar'],
 ['inbox-brief','inbox brief','inbox/reports/inbox-briefs'],
 ['weekly-review','weekly review report','inbox/reports/weekly'],
 ['yt-week-review','YouTube weekly review','inbox/reports/yt-reviews'],
];
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-report-open-'));
 t.after(()=>{invalidateVoiceSnapshot(root);fs.rmSync(root,{recursive:true,force:true})});
 const write=(relative,text='# Saved report\n')=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return relative};
 let scans=0;
 const terminals={list:()=>{scans++;return []},get:()=>assert.fail('Named report navigation needs no worker conversation'),start:()=>assert.fail('No task'),send:()=>assert.fail('No continuation'),startWorkflow:()=>assert.fail('No workflow')};
 const speak=(provider,appScope,transcript,execute=()=>assert.fail('Named report navigation must not call a model'),extra={})=>routeVoice(root,{id:crypto.randomUUID(),selection:{provider,model:provider==='codex'?'gpt-6-astra':'sonnet'},appScope,transcript,terminalMode:true,...extra},undefined,execute,terminals,{resolveCli:()=>assert.fail('No CLI required'),updateCurrent:()=>assert.fail('Quick navigation must preserve the selected conversation')});
 return {root,write,speak,terminals,scans:()=>scans};
}

for(const provider of ['codex','claude'])for(const scope of ['native','web']){
 test(`${provider}/${scope}: natural named report commands open their saved file without a model or dashboard scan`,async t=>{
  const f=fixture(t),workTarget=crypto.randomUUID();
  for(const [key,name,folder] of targets){
   f.write(`${folder}/2020-01-01-${key}.md`);
   const expected=f.write(`${folder}/${localDate()}-${key}.md`);
   for(const utterance of [
    `Can you pull up the ${name} for me?`,
    `Hey Jarvis, could you please, like, bring up my latest ${name}, please?`,
    `Open the ${name}.`,
    `Show me the ${name}, thanks.`,
    `All right, can you pull up that ${name}?`,
    `Can you just pull the ${name} up?`,
    `Please bring the ${name} up.`,
    `I want to see the ${name}.`,
    `I would like you to open the ${name}.`,
    `I'd like to view the ${name}.`,
    `Show me today's ${name} again.`,
    `Can you please open up my ${name} in Obsidian?`,
    `Pull up the ${name} from today for me.`,
    `Display the ${name} for today.`,
    `Can I see the ${name}?`,
    `Would you mind pulling up the ${name}?`,
    `Are you able to display the ${name}?`,
   ]){
    const result=await f.speak(provider,scope,utterance,undefined,{workTarget});
    assert.equal(result.deliverable,expected,utterance);assert.equal(result.reveal,'open');
    assert.equal(result.reply,'');assert.equal(result.spokenReply,'');assert.equal(result.model,null);assert.equal(result.engine,'rules');
    assert.equal(result.workerModel,null);assert.deepEqual(result.workIds,[]);assert.equal(result.queued,null);assert.equal(result.skill,null);assert.equal(result.action,'reply');
    assert.equal(result.workTarget,workTarget);assert.equal(result.provider,provider);assert.equal(result.appScope,scope);
    const receipt=JSON.parse(fs.readFileSync(path.join(f.root,'system/v2/voice-results',result.id+'.json'),'utf8'));
    assert.equal(receipt.reveal,'open');assert.equal(receipt.deliverable,expected);
    assert.match(readVoiceReport(f.root,expected,[],[receipt]).content,/Saved report/);
   }
  }
  assert.equal(f.scans(),0);
 });
}

test('named report aliases share latest-file resolution across both morning report folders',async t=>{
 const f=fixture(t);
 f.write('inbox/research/morning-intel/2020-01-01-intel.md');
 const newest=f.write('inbox/reports/morning/2020-01-02-intel.md');
 for(const utterance of ['Pull up the morning brief for me','Open my morning briefing please','Show the last morning report']){
  assert.equal((await f.speak('claude','native',utterance)).deliverable,newest,utterance);
 }
 const preferred=f.write('inbox/research/morning-intel/2020-01-02-intel.md');
 assert.equal((await f.speak('codex','web','Open morning intel')).deliverable,preferred);
 assert.equal((await f.speak('codex','web','Pull up the morning intel briefing')).deliverable,preferred);
 const current=f.write(`inbox/research/morning-intel/${localDate()}-intel.md`);
 for(const utterance of ["Could you bring up this morning's intel brief?","Show me this morning's report."]){
  assert.equal((await f.speak('claude','native',utterance)).deliverable,current,utterance);
 }
 const github=f.write('inbox/research/github-trending/2020-01-01-trending.md');
 assert.equal((await f.speak('codex','native','Could you pull up the git hub trending report for me?')).deliverable,github);
 const youtube=f.write('inbox/reports/yt-reviews/2020-01-01-yt-week-review.md');
 for(const name of ['YouTube review','YouTube week review','you tube weekly review','YT week review'])assert.equal((await f.speak('claude','native',`Pull up the ${name} for me`)).deliverable,youtube);
});

test('same-day report reruns use saved time instead of random request-ID order',async t=>{
 const f=fixture(t),folder='inbox/reports/yt-reviews';
 const old=f.write(`${folder}/2020-01-02-yt-week-review-ffff0000.md`),latest=f.write(`${folder}/2020-01-02-yt-week-review-0000ffff.md`);
 fs.utimesSync(path.join(f.root,old),new Date('2020-01-02T10:00:00Z'),new Date('2020-01-02T10:00:00Z'));
 fs.utimesSync(path.join(f.root,latest),new Date('2020-01-02T12:00:00Z'),new Date('2020-01-02T12:00:00Z'));
 f.write(`${folder}/2020-01-01-yt-week-review-edited-later.md`);
 assert.equal((await f.speak('claude','native','Pull up the latest YouTube review for me')).deliverable,latest);
});

test('missing named reports answer locally and become openable on the next request',async t=>{
 const f=fixture(t);
 for(const [key,name,folder] of targets){
  const missing=await f.speak('claude','native',`Would you mind displaying the ${name} in Obsidian?`);
  assert.match(missing.reply,/don't have .* on file yet/);assert.equal(missing.reveal,null);assert.equal(missing.deliverable,null);assert.equal(missing.model,null);assert.deepEqual(missing.workIds,[]);
  const expected=f.write(`${folder}/${localDate()}-${key}.md`);
  assert.equal((await f.speak('claude','native',`Pull up the ${name} for me`)).deliverable,expected);
 }
 assert.equal(f.scans(),0);
});

test("today's named reports never silently open an older saved file",async t=>{
 const f=fixture(t);
 for(const [key,name,folder] of targets){
  f.write(`${folder}/2020-01-01-${key}.md`);
  const missing=await f.speak('claude','native',`Can you pull up today's ${name} for me?`);
  assert.match(missing.reply,/don't have today's/);assert.equal(missing.deliverable,null);assert.equal(missing.reveal,null);assert.equal(missing.model,null);
  for(const suffix of ['from today','for today']){
   const currentMissing=await f.speak('codex','web',`Display the ${name} ${suffix}`);
   assert.match(currentMissing.reply,/don't have today's/);assert.equal(currentMissing.deliverable,null);assert.equal(currentMissing.reveal,null);
  }
  const expected=f.write(`${folder}/${localDate()}-${key}.md`);
  f.write(`${folder}/2099-01-01-${key}.md`);
  for(const qualifier of ["today's",'today’s','todays'])assert.equal((await f.speak('codex','web',`Open ${qualifier} ${name}`)).deliverable,expected);
 }
});

test('report navigation preserves complete requests, date constraints and worker references',()=>{
 for(const utterance of [
  'Summarize the morning intel brief for me',
  'What does the morning intel brief say?',
  'Tell me about the GitHub trending report',
  'Read me the inbox brief',
  'What outlier radar videos should I cover?',
  'Summarize the weekly review',
  'What did my YouTube weekly review say?',
  "Don't pull up the morning Intel brief for me",
  'Can you pull up the morning intel brief without opening it?',
  'If I ask, open the morning intel brief',
  'How do I open morning intel?',
  'Can you open the morning intel brief and summarize it?',
  'Pull up the morning intel brief; then draft a script',
  'Open the morning intel brief or inbox brief',
  'Open the morning intel brief from yesterday',
  'Pull up the morning intel brief from 2020-01-01',
  'Open the morning intel brief when it finishes',
  'Refresh the morning intel brief',
  'Research the morning intel brief',
  'Can you bring that up for me?',
  'Open that report',
  'Can you show me the result?',
  'Show me the graphic you made from the morning intel brief',
  'Could you show the graphic you made from morning brief',
  'Can I see the visual explainer about the morning intel brief?',
  'Opening the morning brief takes forever',
  'I do not want to see the morning intel brief',
  'Show me this morning\'s report without opening it',
  'I would like you to summarize the morning intel brief',
  'Can I see how to open the morning intel brief?',
  'Would you mind not opening the morning intel brief?',
  'Please bring the morning intel brief from yesterday up',
  'Display the morning intel brief for tomorrow',
  'Display the morning intel brief from last week',
  'I want to see the morning intel brief and the inbox brief',
  'GitHub trending',
 ])assert.equal(rules.routeNamedReportOpen(utterance),null,utterance);
});

for(const provider of ['codex','claude'])test(`${provider}: briefing questions remain answers without automatic navigation`,async t=>{
 const f=fixture(t),source=f.write(`inbox/research/morning-intel/${localDate()}-intel.md`,'## Top Story\nA saved public headline.\n');
 const base={id:crypto.randomUUID(),chosen:{provider},terminals:f.terminals,appScope:'native'};
 const headline=await classifyVoice(f.root,{...base,transcript:'What was the top AI news today?',execute:()=>assert.fail('Saved headline needs no model')});
 assert.match(headline.reply,/saved public headline/);assert.equal(headline.deliverable,source);assert.equal(headline.reveal,undefined);assert.equal(headline.obsidian,undefined);
 let calls=0;
 const summary=await classifyVoice(f.root,{...base,transcript:'Summarize the morning intel brief for me',execute:async()=>{calls++;return {text:JSON.stringify({tier:2,reply:'A summary of the saved brief.'})}}});
 assert.equal(calls,1);assert.equal(summary.lookupRoute,'scoped-model');assert.equal(summary.deliverable,source);assert.equal(summary.reveal,undefined);assert.equal(summary.obsidian,undefined);
});

test('report discovery excludes markdown directories, index notes and linked report folders',async t=>{
 const f=fixture(t),folder='inbox/research/morning-intel';
 const expected=f.write(`${folder}/2020-01-01-intel.md`);
 f.write(`${folder}/2099-01-01-intel_index.md`);
 fs.mkdirSync(path.join(f.root,folder,'2099-01-02-intel.md'));
 assert.equal((await f.speak('codex','native','Open morning intel')).deliverable,expected);
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'voice-report-linked-'));
 t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
 fs.writeFileSync(path.join(outside,'2099-01-01-trending.md'),'Outside report');
 const link=path.join(f.root,'inbox/research/github-trending');
 fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
 try{
  const result=await f.speak('codex','native','Open github trending');
  assert.equal(result.deliverable,null);assert.equal(result.reveal,null);assert.match(result.reply,/don't have/);
 }finally{fs.unlinkSync(link)}
});

test('legacy rules use the same named-report command parser',t=>{
 const f=fixture(t),expected=f.write(`inbox/research/morning-intel/${localDate()}-intel.md`);
 withVoiceContext({root:f.root,exchanges:[]},()=>{
  const result=rules.rulesRoute('Can you pull up the morning Intel brief for me?',{});
  assert.equal(result.deliverable,expected);assert.equal(result.reveal,'open');assert.equal(result.reply,'');
 });
});
