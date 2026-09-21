import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {briefLookupPlan,isBriefQuestion,localDate,readBriefReply} from '../runner/brief-voice.mjs';
import {routeVoice} from '../runner/bridge-core.mjs';

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-brief-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,write(date,text,folder='inbox/research/morning-intel'){
  fs.mkdirSync(path.join(root,folder),{recursive:true});fs.writeFileSync(path.join(root,folder,`${date}-intel.md`),text);
 }};
}
test('news questions read the ranked story without a model or terminal, for both providers',async t=>{
 const {root,write}=fixture(t);
 write(localDate(),'## TL;DR\n- Private invoice details.\n\n## Top Story\n**A new open model shipped.**\n\nExtra detail [source](https://example.com).\n\n## AI News\nOther news.');
 for(const provider of ['codex','claude']){
  const result=await routeVoice(root,{id:crypto.randomUUID(),selection:{provider,model:provider==='codex'?'gpt-6-astra':'sonnet'},transcript:'So what was the biggest news in AI today?',terminalMode:true,workTarget:crypto.randomUUID()},undefined,()=>assert.fail('No model should run'),{get(){assert.fail('No terminal should be touched')}});
  assert.equal(result.tier,1);assert.equal(result.model,null);assert.equal(result.workerModel,null);assert.deepEqual(result.workIds,[]);
  // The story under the headline is read too (its first sentences), never the private TL;DR or the other sections.
  assert.equal(result.reply,"From today's morning brief: A new open model shipped. Extra detail source.");assert.doesNotMatch(result.reply,/Private invoice|Other news/);assert.ok(result.briefSource.endsWith('-intel.md'));
 }
});
test('natural daily top-news phrasing uses the attributed saved brief for both providers',async t=>{
 const {root,write}=fixture(t);
 write(localDate(),'## Top Story\nThe saved editorial lead.\n\n## Hacker News Pulse\n| Pts | Comments | Story |\n|---|---|---|\n| 99 | 12 | Different Hacker News leader |');
 const phrases=[
  "So what's the biggest AI news for today?",
  'So what’s the biggest AI news for today?',
  'What was the biggest AI story of the day?',
  'Today’s top AI story',
  "What's today's top AI story?",
  'What was the biggest news story of today?',
  'What was the biggest news of the day?',
  'What is the biggest news today?',
  'What was the biggest news and biggest news today?',
  "Today's top headline",
 ];
 for(const provider of ['codex','claude'])for(const transcript of phrases){
  const result=await routeVoice(root,{id:crypto.randomUUID(),selection:{provider,model:provider==='codex'?'gpt-6-astra':'sonnet'},transcript,terminalMode:true,workTarget:crypto.randomUUID()},undefined,()=>assert.fail('A saved-news lookup must not call a model'),{get(){assert.fail('A saved-news lookup must not access a terminal')}});
  assert.equal(result.tier,1,transcript);assert.equal(result.model,null);assert.deepEqual(result.workIds,[]);
  assert.equal(result.transcript,transcript);assert.equal(result.reply,"From today's morning brief: The saved editorial lead.");
  assert.equal(result.briefSource,`inbox/research/morning-intel/${localDate()}-intel.md`);
 }
});
test('daily-news shorthand does not swallow other topics, dates, filters or extra work',()=>{
 for(const text of [
  'What was the biggest world news for today?',
  'What was the biggest geopolitical news of the day?',
  'What was the biggest sports news for today?',
  "Today's top financial story",
  'What was the biggest stock market news today?',
  'What was the biggest AI news for today and why?',
  'What was the biggest AI news for today and create a visual document?',
  'What was the biggest news today and open my inbox?',
  'What was the biggest news today and the weather?',
  'What was the biggest news today and its comments?',
  'What is the latest news for today?',
  'What is the biggest news right now?',
  'What was the biggest AI story of the day yesterday?',
  'What was the biggest AI story of the day last month?',
  'What was the biggest AI story of the day, not the top headline?',
  "Today's top AI story on HN",
  'What was the biggest Show HN story for today?',
  'What was the most discussed news today?',
  'What was the top item today?',
 ])assert.equal(briefLookupPlan(text),null,text);
 assert.deepEqual(briefLookupPlan('What was the biggest news and biggest news on Hacker News for today?'),[{source:'hn',rank:'points'}]);
 assert.deepEqual(briefLookupPlan('What was the biggest AI news of the day and top HN story?'),[{source:'brief',rank:'points'},{source:'hn',rank:'points'}]);
});
test('fresh research, compound work and terminal follow-ups keep their normal routing',()=>{
 for(const text of ['Research the biggest AI news today','What was the biggest news in AI today, and draft a video outline?','Verify the top story in my morning brief','Run morning intel','What changed since the brief?','Tell me more about your last answer','What was the biggest AI news yesterday?'])assert.equal(isBriefQuestion(text),false,text);
 for(const text of ["What's the biggest AI story today?",'Hey, tell me the top AI news this morning','What did my morning intel brief say?'])assert.equal(isBriefQuestion(text),true,text);
});
test('missing, stale and future briefs cannot be presented as today',t=>{
 const {root,write}=fixture(t),now=new Date(2026,8,11,23,45);
 assert.equal(localDate(now),'2026-09-11');assert.match(readBriefReply(root,now).reply,/don't have today's/);
 write('2026-09-10','## Top Story\nOld news.');write('2026-09-12','## Top Story\nFuture news.');
 const result=readBriefReply(root,now);assert.match(result.reply,/latest one is from 2026-09-10/);assert.doesNotMatch(result.reply,/Old news|Future news/);
});
test('canonical intel wins over legacy brief and top-story fallback skips inbox bullets',t=>{
 const {root,write}=fixture(t),date='2026-09-11',now=new Date(2026,8,11);
 write(date,'## Top Story\nLegacy story.','inbox/reports/morning');
 write(date,'## TL;DR\n- Private email.\n- **Top story: a public model launch.**\n\n## Inbox\nPrivate material.');
 const result=readBriefReply(root,now);assert.match(result.reply,/public model launch/);assert.doesNotMatch(result.reply,/Private|Legacy/);
 write(date,'## Inbox\nOnly private email.');assert.match(readBriefReply(root,now).reply,/doesn't identify a top story/);
 write(date,'');assert.match(readBriefReply(root,now).reply,/doesn't identify a top story/);
});
test('cancelled news request neither reads nor saves a response',async t=>{
 const {root}=fixture(t),controller=new AbortController();controller.abort();
 await assert.rejects(routeVoice(root,{id:crypto.randomUUID(),selection:{provider:'codex',model:'gpt-6-astra'},transcript:'What is the biggest AI news today?'},controller.signal),/cancelled/);
 assert.equal(fs.existsSync(path.join(root,'system')),false);
});
