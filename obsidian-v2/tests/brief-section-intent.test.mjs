import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectBriefSectionRequest,validBriefSectionPrevious} from '../runner/brief-section-intent.mjs';
const inspect=inspectBriefSectionRequest;
const previous={source:'brief-section',section:'github',date:'2026-09-12',briefSource:'inbox/research/morning-intel/2026-09-12-intel.md',count:3,offset:0};

test('natural saved section questions extract the precise section and inbox category',()=>{
 for(const [text,section,category] of [
  ['Any emails needing a reply?','inbox','reply'],
  ['Which messages need a reply according to the morning brief?','inbox','reply'],
  ['Do I have any urgent emails today?','inbox','urgent'],
  ['Were there any sponsor opportunities in my morning brief?','inbox','sponsor'],
  ['Were there any sponsor pitches in today’s brief?','inbox','sponsor'],
  ['What did the inbox section say?','inbox','summary'],
  ["What's new with Claude in the morning brief?",'ai-claude'],
  ['Any new Codex developments today?','ai-codex'],
  ['What happened with everyone else in AI?','ai-other'],
  ['What did the YouTube radar find today?','youtube'],
  ['Any small-channel outliers in the morning intel?','outliers'],
  ['What GitHub picks were in the saved report?','github'],
  ['What are the ranked YouTube content ideas?','content-youtube'],
  ["What YouTube ideas did today's content plan suggest?",'content-youtube'],
  ['Read the LinkedIn ideas from the morning brief','content-linkedin'],
  ['What Shorts content ideas were already suggested?','content-shorts'],
  ['What does the source status section say?','source-status'],
 ]){
  const result=inspect(text);assert.equal(result.kind,'lookup',text);assert.equal(result.section,section,text);if(category)assert.equal(result.category,category,text);assert.equal(result.count,undefined,text);
 }
});

test('ranked counts and explicit ordinal section requests remain exact',()=>{
 assert.deepEqual(inspect('Give me the top two GitHub picks'),{kind:'lookup',section:'github',count:2,offset:0});
 assert.deepEqual(inspect('What is the third YouTube content idea?'),{kind:'lookup',section:'content-youtube',count:1,offset:2});
 assert.deepEqual(inspect('Tell me sponsor email number two'),{kind:'lookup',section:'inbox',category:'sponsor',count:1,offset:1});
 assert.equal(inspect('What are the top 20 GitHub repos?').kind,'ambiguous');
 assert.equal(inspect('What is GitHub pick number zero?').kind,'ambiguous');
 assert.equal(inspect('What are the 12 GitHub repos?').kind,'ambiguous');
});

test('validated previous section resolves ordinals without swapping list identity',()=>{
 assert.equal(validBriefSectionPrevious(previous),true);
 assert.deepEqual(inspect('What was the second one?',{previous}),{kind:'lookup',section:'github',count:1,offset:1,date:previous.date,briefSource:previous.briefSource});
 assert.deepEqual(inspect('What is the next one?',{previous}),{kind:'lookup',section:'github',count:1,offset:3,date:previous.date,briefSource:previous.briefSource});
 const inbox={...previous,section:'inbox',category:'urgent',count:1};
 assert.equal(inspect('What was number two?',{previous:inbox}).category,'urgent');
 assert.equal(inspect('What is the next sponsor email?',{previous:inbox}).kind,'ambiguous');
 assert.equal(inspect('What is the second YouTube content idea?',{previous}).section,'content-youtube');
 assert.equal(inspect('What is the next one?',{previous:{...previous,offset:4,count:1}}).kind,'ambiguous');
 for(const invalid of [{...previous,source:'brief'},{...previous,section:'secrets'},{...previous,briefSource:'../secrets.md'},{...previous,briefSource:'inbox/research/morning-intel/2026-09-11-intel.md'},{...previous,count:99},{...previous,category:'urgent'}]){
  assert.equal(validBriefSectionPrevious(invalid),false);assert.notEqual(inspect('What was the second one?',{previous:invalid}).kind,'lookup');
 }
});

test('unknown one-section detail stays scoped instead of returning an incomplete list',()=>{
 for(const [text,section] of [
  ['Why did the Claude announcement matter in the morning brief?','ai-claude'],
  ['What did the sponsor emails mean for us?','inbox'],
  ['Which GitHub repos support Android?','github'],
  ['Which sources failed in the brief?','source-status'],
  ['What is the expected reach for our LinkedIn content ideas?','content-linkedin'],
 ]){const result=inspect(text);assert.equal(result.kind,'ambiguous',text);assert.equal(result.section,section,text)}
 assert.equal(inspect("Why are the urgent inbox items important in today's brief?").category,'urgent');
});

test('work, fresh checks, dates, negation and compound constraints cannot become saved lookups',()=>{
 for(const text of [
  'Reply to the urgent emails','Can you draft a reply to my sponsor?',
  'What should I reply to my sponsor?', 'Did you reply to the sponsor emails?', 'Emails needing reply, answer them',
  'Check my inbox live','What emails arrived since this morning?',
  'Check for new emails','What is my latest email?','Update Claude Code',
  'Any urgent emails yesterday?', 'What was new with Claude last week?',
  "Don't show the urgent emails",'Show sponsor emails excluding the spam',
  'What are the urgent emails and send a reply?','Read the GitHub picks and install the first repo',
  'Tell me what is new with Claude and Codex','Which urgent sponsor emails need a reply?',
  'Generate new LinkedIn content ideas','Recommend new YouTube content ideas',
  'Read the brief and make a diagram about the GitHub picks',
 ]){const result=inspect(text);assert.equal(result.kind,'outside',text);assert.equal(result.guarded,true,text)}
});

test('existing workflow, UI and distinct metrics requests retain their original routing',()=>{
 for(const text of ['GitHub Trending','Run GitHub Trending','Outlier Radar','Refresh morning intel','Inbox brief','Open my inbox','Show me the morning brief','Open GitHub Trending','How many people are subscribed to my YouTube channel?','What is my YouTube subscriber count?','What is my Codex weekly usage?']){
  const result=inspect(text);assert.equal(result.kind,'outside',text);assert.notEqual(result.guarded,true,text);
 }
});
