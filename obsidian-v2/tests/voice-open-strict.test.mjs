import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {openIntentGiven,resolveOpenStrict,strictOpenRouted,validateStrictOpen,invalidateStrictIndex,resolveOpenTarget,targetIndex,invalidateTargetIndex} from '../runner/voice-targets.mjs';

// The strict path is consulted only after Jev has said "this asks to open
// something". These tests treat Jev as confidently wrong: the code alone must
// refuse everything except one fully explained, literally named, unique file.
const NOW=new Date('2026-09-20T18:00:00-05:00'); // a Sunday
const FILES=['projects/2026-04-30-content-backfill-plan.md','projects/streak-plan.md',
 'inbox/research/2026-09-16-kevin-ngo-js-animation-teardown.md','inbox/research/2026-09-16-kevin-ngo-profile-sweep.md',
 'projects/2026-09-10-draft-script.md','projects/2026-09-17-draft-script-notes.md',
 'inbox/archive/2026-04-06-webinar-best-practices-research.md',
 'acme/research/launch-draft.md','acme/launch/research/draft.md','acme/partials/launch-research.md','acme/partials/research-launch-notes.md',
 'inbox/reports/weekly/2026-09-07-weekly-review.md','inbox/reports/weekly/2026-09-14-weekly-review.md',
 'inbox/research/morning-intel/2026-09-20-intel.md','inbox/reports/morning/2026-09-20-morning-report.md',
 'inbox/research/morning-intel/2026-09-19-intel.md','inbox/research/morning-intel/2026-09-19-intel-runner.md',
 'inbox/research/github-trending/2026-09-20-trending.md',
 'inbox/demo-assets/pricing-chart.png','inbox/demo-assets/anthropic-logo-wikipedia.svg','inbox/demo-assets/review-final-contact.jpg','wiki/claude-code/_index.md','daily-notes/2026-09-19.md','system/notes/hidden-plan.md'];
function vault(t,files=FILES){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-open-strict-'));
 t.after(()=>{invalidateStrictIndex(root);invalidateTargetIndex(root);fs.rmSync(root,{recursive:true,force:true})});
 for(const relative of files){const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'# fixture\n')}
 return root;
}
const open=(root,target,options={})=>resolveOpenStrict(root,target,{now:NOW,appScope:'native',...options});

test('a display lead is either the assistant showing it or the user looking at it; everything else is refused',()=>{
 const target=say=>openIntentGiven(say).target;
 for(const [say,expected] of [
  ['Pop open the streak plan','the streak plan'],['I wanna see the streak plan','the streak plan'],['Can I see the streak plan?','the streak plan'],
  ['Could we please take a quick look at the streak plan?','the streak plan'],['Let me look at the streak plan real quick','the streak plan'],["I'd like to view the streak plan",'the streak plan'],
  ['Hey Jarvis, can you pull up the research note on Kevin Ngo for me?','the research note on kevin ngo'],['Open the draft script in Obsidian','the draft script'],
  ['Pull the content backfill plan up for me please','the content backfill plan'],['Bring the draft script back up','the draft script'],['Take me to the streak plan','the streak plan'],
  ['Show me the latest github trending list on screen','the latest github trending list']])assert.equal(target(say),expected,say);
 for(const [say,reason] of [
  // The assistant is asked to inspect, not to show.
  ['Can you have a look at the webinar best practices research?','no-lead'],['Take a look at the draft script','no-lead'],['Look at the streak plan','no-lead'],['Can you check the streak plan','no-lead'],['Review the draft script','no-lead'],
  // Run and search verbs.
  ['Pull my metrics.','no-lead'],['Refresh the GitHub trending list.','no-lead'],['Get me the weekly review','no-lead'],['Give me the streak plan','no-lead'],['Find the streak plan','no-lead'],['Grab the draft script','no-lead'],['The streak plan, please','no-lead'],
  // Explanations, questions, negation.
  ['Can I see how you made that graphic?','refused-word'],['Can I see what the streak plan says','refused-word'],["Don't open the streak plan",'refused-word'],['Open the streak plan and read it to me','refused-word'],['Show me why the draft script changed','refused-word'],
  // Conditions and deferrals.
  ['Pop open the graphic you made only after I approve it','refused-word'],['Open the streak plan when you are done','refused-word'],['Open the streak plan later','refused-word'],['Pop open the streak plan tomorrow','refused-word'],
  // Second requests.
  ['Open the streak plan and then draft a summary','compound'],['Open the streak plan or the draft script','compound'],['Open the streak plan. Then close it.','multi-sentence'],
  // Any placement, including a tab.
  ['Pop open the webinar best practices research in a new tab','placement'],['Pop open the webinar best practices research in a new window','placement'],['Can I see the streak plan on the right','placement'],['Open the streak plan in a split','placement'],['Show me the draft script side by side','placement'],
  // Not files.
  ['Open my calendar','not-a-file'],['Show me the top stories','not-a-file'],['Open https://example.com/plan','shape'],['Open the "streak" plan','shape']])assert.equal(openIntentGiven(say).refused,reason,say);
 assert.equal(openIntentGiven(null).refused,'no-transcript');assert.equal(openIntentGiven('open '+'plan '.repeat(80)).refused,'shape');
});

test('a named file opens only when every word is literally in its name and exactly one file in the whole index qualifies',async t=>{
 const root=vault(t);
 const cases=[
  ['the streak plan','projects/streak-plan.md'],['the content backfill plan','projects/2026-04-30-content-backfill-plan.md'],
  ['the webinar best practices research','inbox/archive/2026-04-06-webinar-best-practices-research.md'],
  // Every word must be in the name: only the notes file has all three.
  ['the draft script notes','projects/2026-09-17-draft-script-notes.md'],
  // A type word may describe the file instead of naming it; a folder word may locate it.
  ['the streak plan note','projects/streak-plan.md'],['the note about the streak plan','projects/streak-plan.md'],['the research note on the kevin ngo profile sweep','inbox/research/2026-09-16-kevin-ngo-profile-sweep.md'],['the file called streak plan','projects/streak-plan.md'],['the kevin ngo profile sweep research note','inbox/research/2026-09-16-kevin-ngo-profile-sweep.md'],
  ['the pricing chart image','inbox/demo-assets/pricing-chart.png'],['the claude code index','wiki/claude-code/_index.md'],
  // A spoken format is the file's format.
  ['the pricing chart png','inbox/demo-assets/pricing-chart.png'],['the anthropic logo wikipedia svg','inbox/demo-assets/anthropic-logo-wikipedia.svg'],['the review final contact jpeg','inbox/demo-assets/review-final-contact.jpg'],['the streak plan markdown file','projects/streak-plan.md']];
 for(const [target,expected] of cases){const resolved=await open(root,target);assert.equal(resolved.path,expected,`${target} -> ${JSON.stringify(resolved)}`);assert.equal(resolved.kind,'note')}
 const refusals=[
  // A different valid word is a different file, however close it sounds.
  ['the context backfill plan','no-match'],['the streaks plan','no-match'],['the content backfil plan','no-match'],
  // A qualifier nothing explains.
  ['the previous content backfill plan','no-match'],['the old streak plan','no-match'],['the new draft script','no-match'],['a copy of the streak plan','no-match'],['the second draft script','no-match'],
  // Two files qualify. One of them ranks fourth in the fuzzy search and would be missed by a result limit.
  ['the research note on kevin ngo','ambiguous:2'],['the acme launch research draft','ambiguous:2'],
  // An exact title is not a tie-break: two files contain "draft script", so neither opens.
  ['the draft script','ambiguous:2'],['the draft script file','ambiguous:2'],
  // Relationship words are kept: what is IN or FROM a file is not that file, and a plural asks for several things.
  ['the files in the content backfill plan','no-match'],['the notes from the content backfill plan','no-match'],['the image in the content backfill plan','no-match'],['the plan for the content backfill','no-match'],
  ['the streak plan notes','no-match'],['the streak plan files','no-match'],['the content backfill plan of record','no-match'],
  // One naming construction is understood; a nested one is a relationship between two things.
  ['the note about the file called streak plan','no-match'],['the document about the file named content backfill plan','no-match'],['the note on the file streak plan','no-match'],['the streak plan note file','no-match'],['the note about streak plan about pricing','no-match'],
  // "Latest" has no defined meaning for a named file; an older exact title must not win.
  ['the latest draft script','newest-named-file'],['the current streak plan','newest-named-file'],['the most recent content backfill plan','newest-named-file'],
  // The type must agree; an index file must be asked for; skipped folders stay hidden.
  ['the content backfill plan pdf','no-match'],['the pricing chart note','no-match'],['claude code','no-match'],['the hidden plan','no-match'],
  // "The logo png" is never the SVG, and a subtype noun ("screenshot", "poster") does not describe any image.
  ['the logo wikipedia png','no-match'],['the review final contact png','no-match'],['the pricing chart svg','no-match'],['the pricing chart pdf','no-match'],['the streak plan png','no-match'],
  ['the anthropic logo wikipedia screenshot','no-match'],['the pricing chart poster','no-match']];
 for(const [target,reason] of refusals)assert.equal((await open(root,target)).refused,reason,target);
 // The dashboard shows Markdown only.
 assert.equal((await open(root,'the pricing chart',{appScope:'web'})).refused,'no-match');
 assert.equal((await open(root,'the pricing chart')).path,'inbox/demo-assets/pricing-chart.png');
});

test('a saved report is an ordered phrase with an unambiguous date',async t=>{
 const root=vault(t),older=path.join(root,'inbox/research/morning-intel/2026-09-19-intel.md'),newer=path.join(root,'inbox/research/morning-intel/2026-09-19-intel-runner.md');
 fs.utimesSync(older,new Date('2026-09-19T12:00:00Z'),new Date('2026-09-19T12:00:00Z'));fs.utimesSync(newer,new Date('2026-09-19T15:00:00Z'),new Date('2026-09-19T15:00:00Z'));
 for(const [target,expected] of [
  ['the weekly review','inbox/reports/weekly/2026-09-14-weekly-review.md'],['the latest weekly review report','inbox/reports/weekly/2026-09-14-weekly-review.md'],
  ["last week's weekly review",'inbox/reports/weekly/2026-09-07-weekly-review.md'],['the weekly review from 2026-09-07','inbox/reports/weekly/2026-09-07-weekly-review.md'],['the weekly review from september 7th, 2026','inbox/reports/weekly/2026-09-07-weekly-review.md'],
  // Two folders; the preferred file name wins over the legacy folder's file.
  ['the morning intel','inbox/research/morning-intel/2026-09-20-intel.md'],["today's morning intel report",'inbox/research/morning-intel/2026-09-20-intel.md'],
  // Same date: the newer file, as the rules path orders them.
  ["yesterday's morning intel",'inbox/research/morning-intel/2026-09-19-intel-runner.md'],
  ['the github trending list','inbox/research/github-trending/2026-09-20-trending.md']]){const resolved=await open(root,target);assert.equal(resolved.path,expected,`${target} -> ${JSON.stringify(resolved)}`);assert.equal(resolved.kind,'report')}
 for(const [target,reason] of [
  // The shared parser counts a weekday backwards and moves a yearless date into last year.
  ['the past week weekly review','date-form'],["the past week's weekly review",'date-form'],['the weekly review from this friday','date-form'],['the weekly review from friday','date-form'],['the weekly review from last monday','date-form'],['the morning intel from october 1','date-form'],['the morning intel from 10/1','date-form'],
  ['the weekly review from two weeks ago','date-form'],['the weekly review from the 14th','date-form'],['the latest weekly review from yesterday','date-form'],["today's weekly review from 2026-09-07",'date-form'],
  // A real date with no file is not an open, and a nearer file is not offered.
  ['the weekly review from yesterday','report-missing'],['the morning intel from october 1, 2025','report-missing'],
  // Words around the report name are not deleted; a derivative request is not the report.
  ['the weekly review in a list','report-grammar'],['the weekly review as a list','report-grammar'],['the weekly review for the report','report-grammar'],['the list of the weekly review','report-grammar'],['a summary of the weekly review','report-grammar'],
  // A request about what is inside a report is not the report.
  ['the files in the weekly review','report-grammar'],['the notes from the weekly review','report-grammar'],['the weekly review template','report-grammar'],['the highlights from the weekly review','report-grammar'],['the weekly review report copy','report-grammar'],['the sponsor brief','report-grammar']])assert.equal((await open(root,target)).refused,reason,target);
 // "Previous" is a constraint nothing here can honour, so nothing opens.
 assert.equal((await open(root,'the previous weekly review')).refused,'report-grammar');
});

test('branches this release defers are recognised and refused with their reason',async t=>{
 const root=vault(t);
 for(const [target,reason] of [['that graphic','deferred-referential'],['it','deferred-referential'],['the poster you made','deferred-referential'],['the report you just created for me','deferred-referential'],
  ["yesterday's daily note",'deferred-daily'],['the daily note from 2026-09-19','deferred-daily'],['the content cascade','deferred-workflow-output']])assert.equal((await open(root,target)).refused,reason,target);
 assert.equal((await open(root,'')).refused,'no-target');
});

test('the validator for resolved opens accepts only an exact, existing, supported path in the default place',async t=>{
 const root=vault(t);
 const report=strictOpenRouted(await open(root,'the weekly review')),note=strictOpenRouted(await open(root,'the streak plan')),image=strictOpenRouted(await open(root,'the pricing chart'));
 assert.deepEqual(report,{tier:2,engine:'rules',context:'',panels:['documents'],lookupRoute:'open',reply:'',deliverable:'inbox/reports/weekly/2026-09-14-weekly-review.md',reveal:'open'});
 assert.deepEqual(note,{tier:2,engine:'rules',context:'',panels:['documents'],lookupRoute:'open',reply:'',obsidian:{op:'open-note',query:'projects/streak-plan.md'}});
 for(const routed of [report,note])for(const appScope of ['web','native'])assert.equal(validateStrictOpen(routed,{root,appScope}),true);
 assert.equal(validateStrictOpen(image,{root,appScope:'native'}),true);assert.equal(validateStrictOpen(image,{root,appScope:'web'}),false);
 assert.equal(strictOpenRouted({refused:'no-match'}),null);assert.equal(strictOpenRouted({kind:'artifact'}),null);
 const bad=[null,{},{...note,tier:3},{...note,reply:'Opening it.'},{...note,lookupRoute:'clarification'},{...note,engine:'luna'},
  {...note,obsidian:{...note.obsidian,where:'right-sidebar'}},{...note,obsidian:{op:'search',query:'projects/streak-plan.md'}},{...note,obsidian:{op:'open-note',query:'projects/missing.md'}},
  {...note,obsidian:{op:'open-note',query:'../outside.md'}},{...note,obsidian:{op:'open-note',query:path.join(root,'projects/streak-plan.md')}},{...note,obsidian:{op:'open-note',query:'projects\\streak-plan.md'}},
  {...note,obsidian:{op:'open-note',query:'projects'}},{...note,obsidian:{op:'open-note',query:'.obsidian/app.json'}},{...note,obsidian:{op:'open-note',query:''}},
  {...note,deliverable:'projects/streak-plan.md',reveal:'open'},{...note,reveal:'open'},{...note,reopenArtifact:{taskId:'x'}},{...note,write:{kind:'add',text:'x'}},
  {...report,reveal:'peek'},{...report,deliverable:'inbox/demo-assets/pricing-chart.png'},{...report,deliverable:'inbox/reports/weekly/missing.md'}];
 for(const routed of bad)assert.equal(validateStrictOpen(routed,{root,appScope:'native'}),false,JSON.stringify(routed));
});

test('structural regression: when the rules path opens a file for "open <target>", the strict path names the same file or nothing',async t=>{
 const root=vault(t);let compared=0;
 for(const target of ['the streak plan','the content backfill plan','the streak plan note','the weekly review','the morning intel',"yesterday's morning intel",'the github trending list','the kevin ngo teardown','the webinar research','the acme launch draft','the context backfill plan','the streaks plan']){
  const rules=resolveOpenTarget(root,`open ${target}`,{now:NOW,appScope:'native'}),strict=await open(root,target);
  if(rules?.path&&strict.path){compared++;assert.equal(strict.path,rules.path,`strict opened ${strict.path}, rules ${rules.path} for ${target}`)}
 }
 assert.ok(compared>=5,`only ${compared} targets were opened by both paths`);
});

test('the strict path keeps its own index: it never fills or reads the rules cache, and it does not block the event loop',async t=>{
 const root=vault(t),add=relative=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'# later\n')};
 // A strict resolution leaves the rules index unbuilt: a file added afterwards is visible to the rules path at once.
 const order=[];const pending=open(root,'the streak plan').then(value=>{order.push('resolved');return value});setImmediate(()=>order.push('event loop turned'));
 assert.equal((await pending).path,'projects/streak-plan.md');assert.deepEqual(order,['event loop turned','resolved']);
 add('projects/added-after-strict.md');
 assert.ok(targetIndex(root).some(entry=>entry.path==='projects/added-after-strict.md'),'the strict path filled the rules cache');
 // The rules index is now cached and stale; the strict path does not read it.
 add('projects/added-after-rules.md');invalidateStrictIndex(root);
 assert.equal(targetIndex(root).some(entry=>entry.path==='projects/added-after-rules.md'),false);
 assert.equal((await open(root,'added after rules')).path,'projects/added-after-rules.md');
 // Its own cache is reused within its lifetime and can be isolated per caller.
 add('projects/added-while-cached.md');
 assert.equal((await open(root,'added while cached')).refused,'no-match');
 assert.equal((await open(root,'added while cached',{cache:new Map()})).path,'projects/added-while-cached.md');
 // A cancelled build is not served later.
 invalidateStrictIndex(root);const abort=new AbortController();abort.abort();
 await assert.rejects(open(root,'the streak plan',{signal:abort.signal}),/cancelled/);
 assert.equal((await open(root,'the streak plan')).path,'projects/streak-plan.md');
});
