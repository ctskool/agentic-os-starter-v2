import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {briefLookupPlan,hackerNewsRanking,parseHackerNews,readHackerNewsReply,localDate} from '../runner/brief-voice.mjs';
import {routeVoice} from '../runner/bridge-core.mjs';
import {invalidateVoiceSnapshot} from '../runner/voice-router.mjs';

// Deliberately unsorted: the report's editorial lead, HN points leader, and
// most-discussed item are different. No real report, CLI, or service is used.
const report=`## TL;DR
- Editorial lead: RubyGems training-agent disclosure.

## Top Story
RubyGems training-agent disclosure.

## Hacker News Pulse
| Pts | Comments | Story |
|---|---|---|
| 811 | 467 | [RubyGems training-agent disclosure](https://example.test/rubygems) |
| 99 | 2,003 | [Most-discussed story](https://example.test/discussion) |
| 1,050 | 1,003 | [A misalignment of AI in mathematics](https://example.test/mathematics) |
| 624 | 340 | [Fourth story](https://example.test/fourth) |
| 504 | 403 | [Fifth story](https://example.test/fifth) |
| 223 | 152 | [Sixth story](https://example.test/sixth) |

## Inbox
Private unrelated inbox material.
`;
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-hn-'));
 const write=(text,date=localDate())=>{const directory=path.join(root,'inbox/research/morning-intel');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,`${date}-intel.md`),text);invalidateVoiceSnapshot(root)};
 t.after(()=>{invalidateVoiceSnapshot(root);fs.rmSync(root,{recursive:true,force:true})});
 const starts=[];
 const terminals={list:()=>[],get:()=>assert.fail('Quick lookup cannot open or retarget a terminal'),start:task=>{starts.push(task);return {id:task.id}},send:()=>assert.fail('No follow-up task'),startWorkflow:()=>assert.fail('No workflow')};
 const speak=(provider,transcript,execute=()=>assert.fail('No model needed'),extra={})=>routeVoice(root,{id:crypto.randomUUID(),selection:{provider,model:provider==='codex'?'gpt-6-astra':'sonnet'},transcript,terminalMode:true,...extra},undefined,execute,terminals,{resolveCli:()=>({command:'unused-test-cli',prefix:[]})});
 return {root,write,speak,starts};
}

for(const provider of ['codex','claude']){
 test(`${provider}: natural repetition and self-correction remain one saved HN lookup`,async t=>{
  const f=fixture(t);f.write(report);
  for(const text of [
   'So what was the biggest news and biggest news on Hacker News today?',
   'Well, um, what was the top, the top story on HN today?',
   'Um, what was, like, the biggest news on Hacker News today?',
   'What was the biggest story — I mean the biggest news on Hacker News today?',
   'What was the top AI news, sorry, the top Hacker News story today?',
   'Give me the main story on HN today and the main HN story today',
   'What was the top HN story today? I meant the story with the most comments.',
  ]){
   const result=await f.speak(provider,text);
   assert.equal(result.model,null,text);assert.deepEqual(result.workIds,[]);assert.equal(result.action,'reply');assert.equal(result.transcript,text);
   assert.ok(result.deliverable.endsWith('-intel.md'));assert.equal((result.reply.match(/saved morning brief/g)||[]).length,1);
   assert.match(result.reply,text.includes('most comments')?/Most-discussed story/:/A misalignment of AI in mathematics/);
   assert.doesNotMatch(result.reply,/RubyGems/);
  }
 });
 test(`${provider}: combined supported lookups preserve both requested answers`,async t=>{
  const f=fixture(t);f.write(report);
  for(const text of ['What was the biggest AI news today and the top Hacker News story?', 'Tell me the top AI news and HN news today', 'What was the main story in the morning brief; also the leading story on HN today?']){
   const result=await f.speak(provider,text);assert.equal(result.model,null,text);assert.deepEqual(result.workIds,[]);
   assert.match(result.reply,/RubyGems.*A misalignment of AI in mathematics/);assert.ok(result.deliverable.endsWith('-intel.md'));
  }
  const ranks=await f.speak(provider,'What HN story had the most points and the most comments today?');
  assert.match(ranks.reply,/mathematics.*most points.*Most-discussed story.*most comments/);assert.equal(ranks.model,null);
 });
 test(`${provider}: repetition does not hide compound work or unknown read requests`,async t=>{
  const f=fixture(t);f.write(report);
  // Created work joined to the question goes to the worker whole, with no model
  // and no saved-brief answer standing in for the outline (2026-09-16).
  const compound=await f.speak(provider,'What was the biggest news and biggest news on HN today, and draft a video outline?');
  assert.equal(compound.model,null);assert.equal(compound.workIds.length,1);assert.equal(f.starts.length,1);assert.match(f.starts[0].prompt,/draft a video outline/);assert.equal(compound.deliverable,null);
  for(const text of [
   'What was the top HN story today, I mean research it thoroughly?',
   'What was the top HN story today and open my inbox?',
   'What was the top HN story today and what is my subscriber count?',
   'What was the top HN story today and what is my weekly quota?',
   'What was the top HN story today and the comments on the story?',
   'What was the top HN story today and the morning brief?',
   'What was the top HN story today and the latest live ranking?',
   'What was the top AI news today and why was it important?',
  ]){
   let called=0;await f.speak(provider,text,async()=>{called++;return {text:JSON.stringify({tier:2,reply:'That request needs the normal routing.'})}});
   assert.equal(called,1,text);
  }
  assert.equal(f.starts.length,1);
 });
 test(`${provider}: exact HN utterance answers the numeric source ranking without model or terminal`,async t=>{
  const f=fixture(t);f.write(report);
  const result=await f.speak(provider,'So what was the biggest story in Hacker News today?',undefined,{workTarget:crypto.randomUUID()});
  assert.equal(result.tier,1);assert.equal(result.model,null);assert.equal(result.workerModel,null);assert.equal(result.action,'reply');assert.deepEqual(result.workIds,[]);
  assert.match(result.reply,/saved morning brief.*A misalignment of AI in mathematics.*1,050 points and 1,003 comments/);
  assert.doesNotMatch(result.reply,/RubyGems|inbox|dig into|working/i);assert.equal(result.deliverable,`inbox/research/morning-intel/${localDate()}-intel.md`);
  const receipt=JSON.parse(fs.readFileSync(path.join(f.root,'system/v2/voice-results',result.id+'.json'),'utf8'));
  assert.equal(receipt.transcript,'So what was the biggest story in Hacker News today?');
  const comments=await f.speak(provider,'Which HN story was most discussed today?');
  assert.match(comments.reply,/Most-discussed story.*most comments.*99 points and 2,003 comments/);
  const ai=await f.speak(provider,'What was the biggest story in AI today?');
  assert.match(ai.reply,/RubyGems/);assert.doesNotMatch(ai.reply,/mathematics/);
 });
 test(`${provider}: detail follow-up receives bounded HN context with fixed fast model`,async t=>{
  const f=fixture(t);f.write(report);
  await f.speak(provider,'What was the top HN story today?');
  let called=0;
  const answer=await f.speak(provider,'Tell me more about that mathematics item',async(_root,job,_prompt,options)=>{
   called++;assert.equal(job.model,provider==='codex'?'gpt-5.6-luna':'haiku');
   assert.match(options.system,/not a live ranking/);assert.match(options.system,/"points":1050,"comments":1003/);
   assert.match(options.system,/https:\/\/example.test\/mathematics/);
   // Bounded source facts include both supported rankings, without loading
   // private inbox text, dashboard metrics, or the entire workflow catalog.
   assert.ok(options.system.length<8000);
   assert.doesNotMatch(options.system,/Dashboard snapshot|Full workflow catalog|Private unrelated inbox material/);
   return {text:JSON.stringify({tier:2,reply:'The saved brief lists 1,050 points and 1,003 comments for that mathematics story.'})};
  });
  assert.equal(called,1);assert.equal(answer.tier,2);assert.deepEqual(answer.workIds,[]);
 });
 test(`${provider}: live, deep and compound HN questions retain the model routing`,async t=>{
  const f=fixture(t);f.write(report);
  for(const text of ['What is the top HN story right now?','Could you help me research the top Hacker News story today?','What is the top HN story in my morning brief, then draft an outline?','What was the top Hacker News story today and why?','What was the biggest AI story on HN today?','What was the top Show HN today?']){
   let called=0;
   const result=await f.speak(provider,text,async()=>{called++;return {text:JSON.stringify({tier:2,reply:'That request needs more than the saved ranking.'})}});
   assert.equal(called,1,text);assert.equal(result.model,provider==='codex'?'gpt-5.6-luna':'haiku');assert.deepEqual(result.workIds,[]);
  }
 });
}

test('source ranking parser supports column order and escaped pipes, reports ties honestly',t=>{
 const f=fixture(t);f.write('## Hacker News\n| Story | Comments | Points |\n|:---|---:|---:|\n| [A \\| B](https://example.test/a) | 20 | 1,100 |\n| Other | 99 | 1,100 |');
 const result=readHackerNewsReply(f.root);
 assert.match(result.reply,/A \| B was tied for the most points/);
 assert.deepEqual(parseHackerNews('## HN Pulse\n| Title | Score | Replies |\n|---|---|---|\n| Zero comments | 1 | 0 |'),[{title:'Zero comments',points:1,comments:0,url:null}]);
});
test('missing, old, future, oversized and malformed source rankings stay truthful',t=>{
 const f=fixture(t),now=new Date(2026,8,12,12);
 assert.match(readHackerNewsReply(f.root,'points',now).reply,/don't have today's/);
 f.write(report,'2026-09-11');f.write(report,'2026-09-13');
 assert.match(readHackerNewsReply(f.root,'points',now).reply,/latest one is from 2026-09-11/);
 for(const raw of ['', '## Top Story\nUnrelated editorial lead.',report.replace('| 1,050 |','| unknown |'),report.replace('| 1,050 |','| 1,05 |'),report.replace('| 1,050 |','| -1 |'),report.replace('| 1,050 |','| 9007199254740992 |')]){
  f.write(raw,'2026-09-12');const reply=readHackerNewsReply(f.root,'points',now).reply;
  assert.match(reply,/doesn't include a readable Hacker News ranking/);assert.doesNotMatch(reply,/RubyGems|most points|dig into/i);
 }
 f.write('x'.repeat(512001),'2026-09-12');assert.match(readHackerNewsReply(f.root,'points',now).reply,/too large/);
});
test('HN quick scope excludes other dates, partial rankings, filtered topics and extra actions',()=>{
 for(const text of [
  'What was the top HN story yesterday?', 'What was the top HN story in the morning brief yesterday?',
  'What is the top HN story live today?', 'What is the top HN story today? Also send it to Sam.',
  'What was the top HN story about robotics today?', 'What were the top five HN stories today?',
  'What was the biggest HN story today; open a terminal', 'What was the top HN story since the morning brief?',
  'What is the latest top HN story today?', 'Give me a deep analysis of the top HN story today',
  'What was the biggest AI story on HN today?', 'What was the top Show HN today?', 'What was the top Python story on HN today?',
 ])assert.equal(hackerNewsRanking(text),null,text);
 for(const text of ['So what was the biggest story in Hacker News today?',"What's the top HN item this morning?",'Read the leading Hacker News story from my morning brief'])assert.equal(hackerNewsRanking(text),'points',text);
 assert.equal(hackerNewsRanking('What HN story had the most comments today?'),'comments');
 assert.deepEqual(briefLookupPlan('What was the biggest news and biggest news today?'),[{source:'brief',rank:'points'}]);
 assert.equal(briefLookupPlan('What was the top HN story today, I mean'),null);
 assert.equal(briefLookupPlan('What was the top HN story today and'),null);
 for(const text of ['What was the top HN story today and comments?', 'What was the top HN story today and its comments?', 'What was the top HN story in the morning brief last month?', 'What was the top HN story today, not the most commented?'])assert.equal(briefLookupPlan(text),null,text);
 assert.deepEqual(briefLookupPlan('What was the top AI news and HN story today?'),[{source:'brief',rank:'points'},{source:'hn',rank:'points'}]);
 assert.deepEqual(briefLookupPlan('What was the top AI story and top HN story today, sorry, the most discussed HN story?'),[{source:'brief',rank:'points'},{source:'hn',rank:'comments'}]);
});
