import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {classifyVoice,invalidateVoiceSnapshot} from '../runner/voice-router.mjs';
import {localDate} from '../runner/brief-voice.mjs';

// Fictional section markers make wrong-source answers visible without needing a
// real model, mailbox, service, terminal, or user vault.
const report=`# Morning Intel

## Top Story
EditorialAurora: a public benchmark release.

## AI News (last 24h)
### Anthropic / Claude
- ClaudeNotebook: a coding-agent changelog added a local review command.
### OpenAI / Codex
- OpenKernel: a model announcement describes a new evaluation method.
### Everyone else
- OtherHelix: an independent lab published a speech dataset.

## Hacker News Pulse
| Points | Comments | Story |
|---|---|---|
| 400 | 90 | PublicHNBeacon |

## YouTube Radar
| Title | Channel | Subscribers | Views | Ratio |
|---|---|---|---|---|
| RadarAstrolabe | Studio A | 1000 | 600 | 0.6 |
| RadarBonsai | Studio B | 2000 | 800 | 0.4 |

### Small-Channel Outliers (last 24h)
| Title | Channel | Views | Age | Lifetime multiplier |
|---|---|---|---|---|
| OutlierKite | Tiny studio | 900 | 3h | 4x |

## GitHub Radar
1. [RepoLantern](https://github.com/example/lantern): a local evaluation runner.
2. [RepoPebble](https://github.com/example/pebble): a compact note index.
3. [RepoWillow](https://github.com/example/willow): an agent trace viewer.

## Inbox (last 24h)
### Urgent
1. UrgentInvoice: a fictional payment confirmation needs attention today.
2. UrgentAccess: a fictional access request expires this afternoon.
### Needs reply
1. ReplyCalendar: confirm a fictional interview slot.
2. ReplyLaunch: answer a fictional launch question.
### Sponsor pitches
1. SponsorBeacon: a fictional brand requested the media kit.
### FYI
- InboxArchive: a fictional receipt was filed.

## So What - Content Plan
### YouTube
1. **YouTubeLaunch**
   - Hook: explain the local agent workflow in a short demo.
   - Rides: OpenKernel and RepoLantern.
2. **YouTubeReview**
   - Hook: compare documented evaluation results.
### LinkedIn
1. **LinkedInChecklist**
   - Hook: share the existing evaluation checklist.
### Shorts / Carousels
1. **ShortsSetup**
   - Hook: one small terminal shortcut.
2. **CarouselCards**
   - Hook: five documented review questions.

## Source Status
| Source | Status | Freshness |
|---|---|---|
| Gmail | ok | SavedMailboxStatus at 07:00 |
| YouTube | ok | SavedVideoStatus at 07:00 |
`;
const inboxMarkers=['UrgentInvoice','UrgentAccess','ReplyCalendar','ReplyLaunch','SponsorBeacon','InboxArchive'];
const outsideMarkers=['EditorialAurora','PublicHNBeacon','UnrelatedDailyData','UnrelatedMetricData'];
const choice=provider=>({provider,model:provider==='codex'?'gpt-6-astra':'sonnet'});
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-section-acceptance-')),today=localDate();
 const write=(relative,text)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text)};
 const writeBrief=(text=report,date=today)=>write(`inbox/research/morning-intel/${date}-intel.md`,text);
 writeBrief();write(`daily-notes/${today}.md`,'## Current Focus\nUnrelatedDailyData');write('system/metrics/latest-video.json',JSON.stringify({title:'UnrelatedMetricData',status:'ok'}));
 const terminalReads=[];
 const terminals={list:()=>{terminalReads.push('list');return []},get:()=>{terminalReads.push('get');return null}};
 const classify=(provider,transcript,execute=()=>assert.fail(`Saved section lookup unexpectedly called a model: ${transcript}`),extra={})=>classifyVoice(root,{id:crypto.randomUUID(),transcript,chosen:choice(provider),terminals,execute,...extra});
 let receiptTime=Date.now()-1000;
 const save=(provider,transcript,result,workTarget=null)=>{
  const relative=`system/v2/voice-results/${crypto.randomUUID()}.json`;
  const receipt={ts:receiptTime++,provider,transcript,reply:result.reply,tier:result.engine==='rules'?1:2,lookup:result.lookup,workTarget,deliverable:result.deliverable};
  write(relative,JSON.stringify(receipt));return {relative,receipt};
 };
 t.after(()=>{invalidateVoiceSnapshot(root);fs.rmSync(root,{recursive:true,force:true})});
 return {root,today,write,writeBrief,classify,save,terminalReads};
}
async function traceReads(root,fn){
 const reads=[],originals={};
 for(const name of ['readFileSync','readdirSync']){
  originals[name]=fs[name];fs[name]=function(file,...args){
   if(typeof file==='string'){const relative=path.relative(root,file).replaceAll('\\','/');if(relative&&!relative.startsWith('../')&&!path.isAbsolute(relative))reads.push(relative)}
   return originals[name].call(this,file,...args);
  };
 }
 try{return {result:await fn(),reads}}finally{Object.assign(fs,originals)}
}
function absent(text,markers,message){for(const marker of markers)assert.ok(!text.includes(marker),`${message}: ${marker}`)}
const noUnrelatedReads=reads=>assert.ok(!reads.some(p=>/^(?:daily-notes|system\/(?:metrics|runs|queue|v2\/(?:runs|queue|processing)))(?:\/|$)/.test(p)),`unrelated source reads: ${reads.join(', ')}`);

for(const provider of ['codex','claude']){
 test(`${provider}: urgent, reply, sponsor and general inbox reads retain their own saved category`,async t=>{
  const f=fixture(t);
  const cases=[
   ['What needs urgent attention in my morning inbox brief?','urgent',['UrgentInvoice','UrgentAccess'],['ReplyCalendar','SponsorBeacon']],
   ['Which messages need a reply according to the morning brief?','reply',['ReplyCalendar','ReplyLaunch'],['UrgentInvoice','SponsorBeacon']],
   ["Were there any sponsor pitches in today's brief?",'sponsor',['SponsorBeacon'],['UrgentInvoice','ReplyCalendar']],
   ["Give me the inbox summary from today's morning intel.",'summary',['UrgentInvoice'],[]],
  ];
  for(const [utterance,category,present,missing] of cases){
   const {result,reads}=await traceReads(f.root,()=>f.classify(provider,utterance));
   assert.equal(result.engine,'rules',utterance);assert.equal(result.lookup?.section,'inbox');
   assert.equal(result.lookup?.category,category);assert.ok(result.reply.length<=880);
   for(const marker of present)assert.ok(result.reply.includes(marker),`${utterance}: missing ${marker}`);
   absent(result.reply,[...outsideMarkers,'OpenKernel','ClaudeNotebook','RepoLantern',...missing],utterance);noUnrelatedReads(reads);
  }
  assert.deepEqual(f.terminalReads,[],'direct saved reads do not need terminal state');
 });

 test(`${provider}: named AI provider sections do not inherit the selected runner as a news filter`,async t=>{
  const f=fixture(t);
  for(const [utterance,section,expected,unwanted] of [
   ["What did today's morning brief say about OpenAI?",'ai-codex','OpenKernel','ClaudeNotebook'],
   ["What Anthropic updates were in today's brief?",'ai-claude','ClaudeNotebook','OpenKernel'],
   ["What did the brief cover from the other AI companies today?",'ai-other','OtherHelix','OpenKernel'],
  ]){
   const {result,reads}=await traceReads(f.root,()=>f.classify(provider,utterance));
   assert.equal(result.engine,'rules',utterance);assert.equal(result.lookup?.section,section);assert.ok(result.reply.includes(expected),utterance);
   absent(result.reply,[...inboxMarkers,...outsideMarkers,unwanted,'RepoLantern','RadarAstrolabe'],utterance);noUnrelatedReads(reads);
  }
 });

 test(`${provider}: GitHub, YouTube and outlier lookups read distinct saved sections`,async t=>{
  const f=fixture(t);
  for(const [utterance,section,expected,unwanted] of [
   ["Which GitHub repositories were in this morning's radar?",'github','RepoLantern',['RadarAstrolabe','OutlierKite']],
   ["What videos showed up in today's YouTube radar?",'youtube','RadarAstrolabe',['RepoLantern','OutlierKite']],
   ["Which small-channel outliers did the morning brief find?",'outliers','OutlierKite',['RepoLantern','RadarAstrolabe']],
  ]){
   const {result,reads}=await traceReads(f.root,()=>f.classify(provider,utterance));
   assert.equal(result.engine,'rules',utterance);assert.equal(result.lookup?.section,section);assert.ok(result.reply.includes(expected),utterance);
   absent(result.reply,[...inboxMarkers,...outsideMarkers,...unwanted],utterance);noUnrelatedReads(reads);
  }
 });

 test(`${provider}: saved platform content plans remain distinct from content creation`,async t=>{
  const f=fixture(t);
  for(const [utterance,section,expected,unwanted] of [
   ["What YouTube ideas did today's content plan suggest?",'content-youtube','YouTubeLaunch',['LinkedInChecklist','ShortsSetup']],
   ["What did the morning brief recommend for LinkedIn content?",'content-linkedin','LinkedInChecklist',['YouTubeLaunch','ShortsSetup']],
   ["What shorts ideas were in today's content plan?",'content-shorts','ShortsSetup',['YouTubeLaunch','LinkedInChecklist']],
  ]){
   const {result,reads}=await traceReads(f.root,()=>f.classify(provider,utterance));
   assert.equal(result.engine,'rules',utterance);assert.equal(result.lookup?.section,section);assert.ok(result.reply.includes(expected),utterance);
   absent(result.reply,[...inboxMarkers,...outsideMarkers,...unwanted],utterance);noUnrelatedReads(reads);
  }
 });

 test(`${provider}: an interpretive section question sends only that section to the fast model`,async t=>{
  const f=fixture(t),utterance="Why were the GitHub projects in today's radar worth watching?";let calls=0;
  const {result,reads}=await traceReads(f.root,()=>f.classify(provider,utterance,async(_root,job,_prompt,options)=>{
   calls++;assert.equal(job.provider,provider);assert.equal(job.model,provider==='codex'?'gpt-5.6-luna':'haiku');assert.equal(options.user,utterance);assert.ok(options.system.length<12000);
   assert.ok(options.system.includes('RepoLantern'));absent(options.system,[...inboxMarkers,...outsideMarkers,'RadarAstrolabe','OutlierKite','OpenKernel','LinkedInChecklist'],'scoped section interpretation');
   return {text:JSON.stringify({tier:2,reply:'The saved GitHub descriptions explain local evaluation and indexing use cases.'})};
  }));
  assert.equal(calls,1);assert.equal(result.tier,2);assert.equal(result.lookupRoute,'scoped-model');noUnrelatedReads(reads);
 });

 test(`${provider}: interpreting an urgent inbox category excludes other categories and prior sponsor context`,async t=>{
  const f=fixture(t),priorAsk="What sponsor pitches were in today's morning brief?";
  const prior=await f.classify(provider,priorAsk,undefined,{workTarget:'conversation-a'});f.save(provider,priorAsk,prior,'conversation-a');
  const utterance="Why are the urgent inbox items important in today's brief?";let calls=0;
  const {result,reads}=await traceReads(f.root,()=>f.classify(provider,utterance,async(_root,job,_prompt,options)=>{
   calls++;assert.equal(job.provider,provider);assert.equal(options.user,utterance);assert.ok(options.system.includes('UrgentInvoice'));
   absent(options.system,['SponsorBeacon','ReplyCalendar','ReplyLaunch','InboxArchive',...outsideMarkers,'RepoLantern'],'urgent-only interpretation');
   return {text:JSON.stringify({tier:2,reply:'The saved urgent category lists a payment confirmation and an expiring access request.'})};
  },{workTarget:'conversation-a'}));
  assert.equal(calls,1);assert.equal(result.tier,2);noUnrelatedReads(reads);
 });

 test(`${provider}: live checks, explicit work, unsupported dates and compound requests are never mislabeled saved section reads`,async t=>{
  const f=fixture(t);
  for(const [utterance,work] of [
   ['Check my Gmail for new urgent messages right now.',false],
   ["Refresh the GitHub radar with today's live results.",true],
   ['Draft a reply to the first sponsor in my morning brief.',true],
   ['Create a LinkedIn post from the saved content plan.',true],
   ["Read today's sponsor pitches and then draft a reply to the first one.",true],
   ["What were yesterday's urgent inbox items?",false],
  ]){
   let calls=0;
   const result=await f.classify(provider,utterance,async(_root,job,_prompt,options)=>{
    calls++;assert.equal(job.provider,provider);assert.equal(options.user,utterance);
    return {text:JSON.stringify(work?{tier:3,reply:'Working on the full request.'}:{tier:2,reply:'That needs the requested source or a fresh check.'})};
   });
   assert.ok(calls<=1);assert.notEqual(result.lookupRoute,'local',utterance);
   if(work)assert.equal(result.tier,3,utterance);
   else absent(result.reply,['UrgentInvoice','SponsorBeacon','RepoLantern'],utterance);
  }
 });

 test(`${provider}: absent and stale categories cannot borrow neighboring content or claim fresh mailbox access`,async t=>{
  const f=fixture(t);
  f.writeBrief('## Inbox (last 24h)\n### Opportunities / Needs reply\n- MixedOpportunity: a fictional collaboration request.\n\n## Top Story\nPublic unrelated news.');
  const missing=await f.classify(provider,"What sponsor pitches were in today's morning brief?");
  assert.equal(missing.engine,'rules');absent(missing.reply,['MixedOpportunity','Public unrelated news'],'missing sponsor category');assert.match(missing.reply,/missing|not|no |unavailable|doesn't|couldn't/i);
  const mixed=await f.classify(provider,"Which messages need a reply in today's morning brief?");
  assert.equal(mixed.engine,'rules');absent(mixed.reply,['MixedOpportunity'],'mixed opportunities are not all confirmed needs-reply messages');assert.match(mixed.reply,/missing|not|no |unavailable|doesn't|couldn't/i);
  fs.unlinkSync(path.join(f.root,`inbox/research/morning-intel/${f.today}-intel.md`));
  f.writeBrief(report,'2000-01-01');f.writeBrief(report,'2999-01-01');
  const stale=await f.classify(provider,"What urgent messages were in today's morning brief?");
  assert.equal(stale.engine,'rules');absent(stale.reply,inboxMarkers,'stale inbox data');assert.match(stale.reply,/don't have|not available|missing|2000-01-01/i);
 });

 test(`${provider}: fenced headings, duplicate sections and malformed tables cannot manufacture saved facts`,async t=>{
  const f=fixture(t);
  f.writeBrief('## AI News (last 24h)\n### OpenAI\nExample formatting:\n```markdown\n## Inbox\n### Urgent\n- FencedGhost: this is a code example, not an inbox item.\n```\n\n## GitHub Radar\n1. RepoLantern: public content.');
  const result=await f.classify(provider,"What urgent items were in today's morning brief?");
  assert.equal(result.engine,'rules');absent(result.reply,['FencedGhost','RepoLantern'],'fenced heading boundary');assert.match(result.reply,/missing|not|no |unavailable|doesn't|couldn't/i);
  f.writeBrief('## Inbox\n### Urgent\n- DuplicateOne: unresolvable duplicate heading.\n\n## Inbox\n### Urgent\n- DuplicateTwo: unresolvable duplicate heading.');
  const duplicate=await f.classify(provider,"What urgent inbox items were in today's brief?");
  assert.equal(duplicate.engine,'rules');absent(duplicate.reply,['DuplicateOne','DuplicateTwo'],'duplicate section boundary');assert.match(duplicate.reply,/readable|malformed|unavailable/i);
  f.writeBrief('## YouTube Radar\n| Title | Channel | Views |\n|---|---|---|\n| InvalidTableVideo | Missing a cell |\n\n### Small-Channel Outliers\n- NeighborOutlier: a separate source.');
  const malformed=await f.classify(provider,"What videos were in today's YouTube radar?");
  assert.equal(malformed.engine,'rules');absent(malformed.reply,['InvalidTableVideo','NeighborOutlier'],'malformed table isolation');assert.match(malformed.reply,/readable|malformed|unavailable/i);
 });

 test(`${provider}: numbered section follow-ups require fresh same-provider same-conversation provenance`,async t=>{
  const f=fixture(t),utterance="Read the GitHub projects from today's morning brief.";
  const first=await f.classify(provider,utterance,undefined,{workTarget:'conversation-a'});
  assert.equal(first.lookup?.source,'brief-section');f.save(provider,utterance,first,'conversation-a');
  const second=await f.classify(provider,'What was the second repo on that list?',undefined,{workTarget:'conversation-a'});
  assert.equal(second.engine,'rules');assert.match(second.reply,/RepoPebble/);absent(second.reply,['RepoLantern','RepoWillow',...inboxMarkers],'ordinal selected entry');
  const failures=[];
  for(const boundary of ['provider','task','age','date','intervening']){
   try{
    const b=fixture(t),initial=await b.classify(provider,utterance,undefined,{workTarget:'conversation-a'}),saved=b.save(provider,utterance,initial,'conversation-a');
    saved.receipt.reply+=' OtherContextMarker';
    if(boundary==='age')saved.receipt.ts-=181000;
    if(boundary==='date')saved.receipt.lookup.date='2000-01-01';
    b.write(saved.relative,JSON.stringify(saved.receipt));
    if(boundary==='intervening')b.save(provider,'Thanks',{engine:'rules',reply:'You are welcome.'},'conversation-a');
    const nextProvider=boundary==='provider'?(provider==='codex'?'claude':'codex'):provider;
    const result=await b.classify(nextProvider,'What was the second repo on that list?',async(_root,_job,_prompt,options)=>{
     assert.ok(!options.system.includes('OtherContextMarker'),`${boundary} leaked prior section context`);return {text:JSON.stringify({tier:2,reply:'Which saved list do you mean?'})};
    },{workTarget:boundary==='task'?'conversation-b':'conversation-a'});
    absent(result.reply,['RepoPebble'],boundary);
   }catch(error){failures.push(`${boundary}: ${error.message}`)}
  }
  assert.deepEqual(failures,[]);
 });

 test(`${provider}: tied receipt timestamps cannot establish the latest list or offer`,async t=>{
  for(const reversed of [false,true])for(const mtimeDelta of [-20,0,20]){
   const f=fixture(t),ts=Date.now()-1000,workTarget='conversation-a';
   const utterance="Read the GitHub projects from today's morning brief.";
   const first=await f.classify(provider,utterance,undefined,{workTarget});
   const section={ts,provider,workTarget,tier:1,transcript:utterance,reply:first.reply+' Want me to research those repositories?',lookup:first.lookup};
   const thanks={ts,provider,workTarget,tier:1,transcript:'Thanks',reply:'You are welcome.'};
   for(const [name,receipt,mtime] of [[reversed?'z':'a',section,ts],[reversed?'a':'z',thanks,ts+mtimeDelta]]){
    const relative=`system/v2/voice-results/${name}.json`;
    f.write(relative,JSON.stringify(receipt));fs.utimesSync(path.join(f.root,relative),new Date(mtime),new Date(mtime));
   }
   const label=`reversed=${reversed}, mtimeDelta=${mtimeDelta}`;
   const ordinal=await f.classify(provider,'What was the second repo on that list?',undefined,{workTarget});
   assert.equal(ordinal.lookupRoute,'clarification',label);absent(ordinal.reply,['RepoPebble'],label);
   const affirmation=await f.classify(provider,'Yes',undefined,{workTarget});
   assert.match(affirmation.reply,/What would you like me to go ahead with\?/,label);assert.equal(affirmation.tier,2,label);
   // A strictly newer timestamp restores provenance even when its file has an
   // older mtime, and the older ambiguous pair remains in conversation memory.
   const relative='system/v2/voice-results/newest.json';
   f.write(relative,JSON.stringify({...section,ts:ts+1}));fs.utimesSync(path.join(f.root,relative),new Date(ts-20),new Date(ts-20));
   const restored=await f.classify(provider,'What was the second repo on that list?',undefined,{workTarget});
   assert.equal(restored.lookupRoute,'local',label);assert.match(restored.reply,/RepoPebble/,label);
  }
 });
}
