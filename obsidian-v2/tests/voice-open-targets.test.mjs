import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveOpenTarget,openIntent,searchTargets,invalidateTargetIndex,describeCandidates,deferredOpen,matchSkill} from '../runner/voice-targets.mjs';

// 2026-09-16 is a Wednesday in America/Chicago.
const now=new Date('2026-09-16T17:00:00Z');
function vault(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'voice-open-targets-')));
 t.after(()=>{invalidateTargetIndex(root);fs.rmSync(root,{recursive:true,force:true})});
 const write=(relative,text='# note\n')=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return relative};
 for(const rel of [
  'inbox/research/morning-intel/2026-09-16-intel.md','inbox/research/morning-intel/2026-09-15-intel.md','inbox/research/morning-intel/2026-09-12-intel.md',
  'inbox/research/morning-intel/_index.md','inbox/reports/inbox-briefs/2026-09-15-inbox-brief.md',
  'inbox/reports/weekly/2026-09-13-weekly-review.md','inbox/reports/weekly/2026-09-06-weekly-review.md',
  'inbox/reports/yt-reviews/2026-09-13-yt-week-review.md','inbox/research/github-trending/2026-09-16-trending.md',
  'daily-notes/2026-09-15.md','daily-notes/2026-09-16.md',
  'projects/2026-05-10-skoot-crm-playbook.md','projects/proposals/2026-06-01-dario-proposal.md',
  'projects/2026-04-30-content-backfill-plan.md','projects/2026-05-02-content-calendar-plan.md',
  'projects/archive/2026-01-05-old-content-backfill-plan.md',
  'wiki/agentic-os/jarvis-hud.md','wiki/_index.md','system/v2/artifacts/files/abc.png','.obsidian/plugins/x/main.js',
 ])write(rel);
 fs.mkdirSync(path.join(root,'inbox/demo-assets'),{recursive:true});
 fs.writeFileSync(path.join(root,'inbox/demo-assets/agentic-os-diagram.png'),Buffer.from([137,80,78,71]));
 return {root,write};
}
const resolve=(root,text,extra={})=>resolveOpenTarget(root,text,{now,...extra});

test('open intent survives politeness, restatements, separable verbs and placement words',()=>{
 assert.deepEqual(openIntent('Can you pull up the morning Intel brief from this morning?'),{target:'the morning intel brief from this morning',where:undefined});
 assert.deepEqual(openIntent("Can't you pull up that explainer in one of the obsidian tabs?"),{target:'that explainer',where:undefined});
 assert.deepEqual(openIntent('Now, can you just pull it up for me? Can you pull up the report so I can see it inside of Obsidian?'),{target:'the report',where:undefined});
 assert.deepEqual(openIntent('Can you pull the skoot playbook up?'),{target:'the skoot playbook',where:undefined});
 assert.deepEqual(openIntent('Open my proposal for Dario on the right'),{target:'my proposal for dario',where:'right-sidebar'});
 assert.deepEqual(openIntent("I want to see yesterday's daily note"),{target:"yesterday's daily note",where:undefined});
 for(const text of ['Read me the inbox brief','What is my schedule looking like today?','Open the morning intel brief and summarize it',"Don't pull up the brief",'pull up my calendar','Open the morning intel brief or the inbox brief','How do I open the morning intel?','Research the skoot playbook','open https://example.com'])assert.equal(openIntent(text),null,text);
});

test('named reports resolve to the newest file, a spoken date, or an honest miss with the nearest earlier file',t=>{
 const {root}=vault(t);
 for(const text of ['Can you pull up the morning Intel brief from this morning?','Pull up the morning intel brief.','Can you pull up the morning Intel brief for me?','show me the latest intel']){
  const r=resolve(root,text);assert.equal(r.kind,'report',text);assert.equal(r.path,'inbox/research/morning-intel/2026-09-16-intel.md',text);
 }
 assert.equal(resolve(root,"Open yesterday's intel").path,'inbox/research/morning-intel/2026-09-15-intel.md');
 assert.equal(resolve(root,'pull up the intel brief from the 12th').path,'inbox/research/morning-intel/2026-09-12-intel.md');
 const monday=resolve(root,'pull up the intel from monday');
 assert.equal(monday.kind,'missing');assert.equal(monday.dateLabel,'Monday, September 14');assert.equal(monday.nearest.path,'inbox/research/morning-intel/2026-09-12-intel.md');
 assert.match(monday.nearest.label,/morning intel report from Saturday, September 12/);
 assert.equal(resolve(root,'show me the top story in the brief'),null);
 assert.equal(resolve(root,'show me the graphic you made from the morning intel brief').kind,'unresolved');
 assert.equal(resolve(root,'open the morning intel video plan').kind,'unresolved');
 const offered=resolve(root,'yes',{exchanges:[{ts:new Date(now.getTime()-5000).toISOString(),you:'pull up the intel from monday',jarvis:'offer',lookup:{source:'open-offer',path:monday.nearest.path,label:monday.nearest.label}}]});
 assert.equal(offered.kind,'note');assert.equal(offered.path,'inbox/research/morning-intel/2026-09-12-intel.md');
 const week=resolve(root,"show me last week's weekly review");assert.equal(week.kind,'report');assert.equal(week.path,'inbox/reports/weekly/2026-09-13-weekly-review.md');
 assert.equal(resolve(root,'open the youtube weekly review').path,'inbox/reports/yt-reviews/2026-09-13-yt-week-review.md');
 assert.equal(resolve(root,'bring up the github trending report').path,'inbox/research/github-trending/2026-09-16-trending.md');
 const none=resolve(root,'pull up the inbox brief from september 10');assert.equal(none.kind,'missing');assert.equal(none.nearest,null);
 const radar=resolve(root,'open the outlier radar');assert.equal(radar.kind,'missing');assert.equal(radar.nearest,null);
});

test('daily notes resolve by date and never substitute another day silently',t=>{
 const {root}=vault(t);
 // Today's note keeps the existing daily-note action; only dated asks resolve here.
 assert.equal(resolve(root,'open my daily note'),null);
 assert.equal(resolve(root,'open my daily note on the left'),null);
 assert.deepEqual([resolve(root,"open today's daily note").kind,resolve(root,"open today's daily note").path],['daily','daily-notes/2026-09-16.md']);
 assert.equal(resolve(root,"open yesterday's daily note").path,'daily-notes/2026-09-15.md');
 const friday=resolve(root,'pull up my daily note from last friday');
 assert.equal(friday.kind,'missing');assert.equal(friday.dateLabel,'Friday, September 11');assert.equal(friday.nearest,null);
 const tomorrow=resolve(root,"show me tomorrow's daily note");assert.equal(tomorrow.kind,'missing');assert.equal(tomorrow.nearest.path,'daily-notes/2026-09-16.md');
});

test('named notes match by title words, tolerate speech errors, and ask when two notes tie',t=>{
 const {root,write}=vault(t);
 assert.equal(resolve(root,'pull up the skoot crm playbook').path,'projects/2026-05-10-skoot-crm-playbook.md');
 assert.equal(resolve(root,'Can you pull the skoot playbook up?').path,'projects/2026-05-10-skoot-crm-playbook.md');
 assert.equal(resolve(root,'open the scoot CRM playbook').path,'projects/2026-05-10-skoot-crm-playbook.md');
 assert.equal(resolve(root,'open my proposal for Dorio').path,'projects/proposals/2026-06-01-dario-proposal.md');
 const placed=resolve(root,'open the skoot playbook on the right');assert.equal(placed.where,'right-sidebar');
 assert.equal(resolve(root,'open the jarvis hud note').path,'wiki/agentic-os/jarvis-hud.md');
 const ambiguous=resolve(root,'open the content plan');
 assert.equal(ambiguous.kind,'ambiguous');assert.deepEqual(ambiguous.candidates.map(c=>c.path),['projects/2026-05-02-content-calendar-plan.md','projects/2026-04-30-content-backfill-plan.md']);
 assert.equal(describeCandidates(ambiguous.candidates),'content calendar plan or content backfill plan');
 const exchanges=[{ts:new Date(now.getTime()-5000).toISOString(),you:'open the content plan',jarvis:'which one?',lookup:{source:'open-candidates',candidates:ambiguous.candidates}}];
 assert.equal(resolve(root,'the second one',{exchanges}).path,'projects/2026-04-30-content-backfill-plan.md');
 assert.equal(resolve(root,'the calendar one',{exchanges}).path,'projects/2026-05-02-content-calendar-plan.md');
 assert.equal(resolve(root,'open the content backfill plan').path,'projects/2026-04-30-content-backfill-plan.md');
 const image=resolve(root,'open the agentic os diagram');assert.equal(image.kind,'note');assert.equal(image.type,'image');assert.equal(image.path,'inbox/demo-assets/agentic-os-diagram.png');
 assert.equal(resolve(root,'open the quarterly tax memo').kind,'unresolved');
 // Same title twice: the date tells them apart, then the folder.
 write('inbox/research/call-transcripts/2026-05-20-dario-proposal.md');write('projects/proposals/2026-06-01-dario-proposal.pdf','%PDF-1.4\n');invalidateTargetIndex(root);
 const twins=resolve(root,'open the dario proposal');assert.equal(twins.kind,'ambiguous');
 assert.deepEqual(twins.candidates.map(c=>c.label).sort(),['dario proposal as a PDF','dario proposal from Monday, June 1','dario proposal from Wednesday, May 20']);
 assert.equal(resolve(root,'the pdf one',{exchanges:[{ts:new Date(now.getTime()-5000).toISOString(),you:'open the dario proposal',jarvis:'which one?',lookup:{source:'open-candidates',candidates:twins.candidates}}]}).path,'projects/proposals/2026-06-01-dario-proposal.pdf');
 assert.equal(resolve(root,'the may one',{exchanges:[{ts:new Date(now.getTime()-5000).toISOString(),you:'open the dario proposal',jarvis:'which one?',lookup:{source:'open-candidates',candidates:twins.candidates}}]}).path,'inbox/research/call-transcripts/2026-05-20-dario-proposal.md');
 // Bare nouns that are also workflow names are notes, not workflow outputs.
 assert.deepEqual(matchSkill('the plan'),[]);assert.deepEqual(matchSkill('the outline'),[]);assert.deepEqual(matchSkill('plan tomorrow'),[]);
 assert.equal(resolve(root,'open the main plugin file').kind,'unresolved');
 assert.ok(searchTargets(root,'playbook').matches.every(m=>!m.entry.index));
 assert.equal(searchTargets(root,'wiki index').matches[0].entry.path,'wiki/_index.md');
});

test('referential asks use the selected conversation first, then what was just shown',t=>{
 const {root}=vault(t);
 const png={id:'a'.repeat(40),path:'system/v2/artifacts/files/abc.png',label:'Preview',mime:'image/png',bytes:4,open:true,isFinal:true};
 const md={id:'b'.repeat(40),path:'system/v2/artifacts/files/def.md',label:'Notes',mime:'text/markdown',bytes:4,open:false,isFinal:true};
 const task={id:'11111111-1111-4111-8111-111111111111',title:'Explainer task',turns:[{id:'t1',ts:1,text:'done',artifacts:[md,png]}]};
 const graphic=resolve(root,'show me the graphic you made',{selectedTask:task});
 assert.equal(graphic.kind,'artifact');assert.equal(graphic.artifact.path,png.path);assert.equal(graphic.selected,true);
 assert.equal(resolve(root,'pull it up',{selectedTask:task}).artifact.path,png.path);
 assert.equal(resolve(root,'open the notes you wrote',{selectedTask:task}).artifact.path,md.path);
 assert.equal(resolve(root,'Now, can you just pull it up for me? Can you pull up the report so I can see it inside of Obsidian?',{selectedTask:task}).kind,'artifact');
 const html={id:'22222222-2222-4222-8222-222222222222',title:'Jev explainer',turns:[{id:'t1',ts:1,text:'Done.\n\n[View the explainer](<'+root.replace(/\\/g,'/')+'/outputs/jev-explainer/jev-explainer.html>)',artifactErrors:['This artifact type is not supported for preview.']}]};
 const blocked=resolve(root,"Can't you pull up that explainer in one of the obsidian tabs?",{selectedTask:html});
 assert.equal(blocked.kind,'undisplayable');assert.equal(blocked.path,'outputs/jev-explainer/jev-explainer.html');assert.equal(blocked.ext,'html');
 const exchanges=[{ts:new Date(now.getTime()-5000).toISOString(),you:'what was the top news',jarvis:'...',deliverable:'inbox/research/morning-intel/2026-09-16-intel.md',workIds:[]}];
 const referent=resolve(root,'pull that up',{exchanges});assert.equal(referent.kind,'note');assert.equal(referent.path,'inbox/research/morning-intel/2026-09-16-intel.md');assert.equal(referent.referent,true);
 const viaWork=resolve(root,'show me the image',{exchanges:[{ts:new Date(now.getTime()-5000).toISOString(),you:'make a diagram',jarvis:'ok',workIds:[task.id]}],taskById:id=>id===task.id?task:null});
 assert.equal(viaWork.kind,'artifact');assert.equal(viaWork.selected,false);assert.equal(viaWork.taskTitle,'Explainer task');
 assert.equal(resolve(root,'pull it up').kind,'unresolved');
 assert.equal(resolve(root,'What is my schedule looking like today?',{selectedTask:task}),null);
});

// The September 16 afternoon transcript: a work request whose last clause asks
// for the result to be opened when it exists.
const JEV='Actually, can you instead of explaining that, can you actually create using your image generation tool, a visual explainer of how Jev works? And once you create that, can you open it up for me?';

test('a promised open rides with the work and is never an open request now',()=>{
 const promised=[JEV,'make me a diagram of the pipeline and then show me',"build a one-pager on Jev and open it when you're done",'generate the chart, then pull it up',"draft the summary and when it's ready, bring it up in obsidian",'research jev and show me what you found when you are done'];
 for(const text of promised){assert.equal(deferredOpen(text),true,text);assert.equal(openIntent(text),null,text)}
 const plain=['Can you pull up the morning Intel brief from this morning?','create a visual explainer of how jev works',"don't open it when you're done",'open the skoot playbook','What is the biggest news in AI today?','research the leads and then tell me what you found',"put together a one-pager on Jev and once you're done, ping me",'yes','the second one'];
 for(const text of plain)assert.equal(deferredOpen(text),false,text);
});

test('named workflow outputs open from the run ledgers by whole words, never by filler',t=>{
 const {root,write}=vault(t);
 write('inbox/reports/cascades/2026-09-15-1e089d8f.md','# cascade');write('inbox/reports/cascades/2026-07-16-1901fc7d.md','# cascade');write('inbox/reports/metrics/2026-08-15-pull-19e39d85.md','# metrics');
 write('system/runs/new.json',JSON.stringify({id:'new',skill:'content-cascade',status:'ok',summary:'The cascade is complete — blog is live, the LinkedIn post is scheduled, and the X tweet is drafted and waiting for your manual video upload.',deliverable_path:'inbox/reports/cascades/2026-09-15-1e089d8f.md',ts_completed:'2026-09-15T20:00:00Z'}));
 write('system/v2/runs/old.json',JSON.stringify({id:'old',skill:'content-cascade',status:'ok',summary:'Older cascade.',deliverable_path:'inbox/reports/cascades/2026-07-16-1901fc7d.md',ts_completed:'2026-07-16T20:00:00Z'}));
 write('system/runs/metrics.json',JSON.stringify({id:'m',skill:'metrics-pull',status:'ok',summary:'Pulled metrics.',deliverable_path:'inbox/reports/metrics/2026-08-15-pull-19e39d85.md'}));
 write('system/runs/bad.json',JSON.stringify({id:'bad',skill:'vault-cleanup',status:'ok',summary:'x',deliverable_path:'../outside.md'}));
 write('system/runs/failed.json',JSON.stringify({id:'f',skill:'ai-trend-scan',status:'error',summary:'x',deliverable_path:'inbox/reports/cascades/2026-09-15-1e089d8f.md'}));
 invalidateTargetIndex(root);
 assert.deepEqual(matchSkill('the content cascade').map(s=>s.key),['content-cascade']);
 assert.deepEqual(matchSkill('the trend scan').map(s=>s.key),['ai-trend-scan']);
 assert.deepEqual(matchSkill('the metrics report').map(s=>s.key),['metrics-pull']);
 assert.deepEqual(matchSkill('today'),[]);assert.deepEqual(matchSkill('the research'),[]);assert.deepEqual(matchSkill('the content plan'),[]);assert.deepEqual(matchSkill('the skoot crm playbook'),[]);
 for(const text of ['show me the content cascade','bring up the latest cascade','show me the latest content cascade report']){
  const r=resolve(root,text);assert.equal(r.kind,'report',text);assert.equal(r.report,'content-cascade',text);assert.equal(r.path,'inbox/reports/cascades/2026-09-15-1e089d8f.md',text);
 }
 assert.equal(resolve(root,'pull up the cascade from july 16').path,'inbox/reports/cascades/2026-07-16-1901fc7d.md');
 assert.equal(resolve(root,'pull up the metrics report').path,'inbox/reports/metrics/2026-08-15-pull-19e39d85.md');
 const cleanup=resolve(root,'open the vault cleanup report');assert.equal(cleanup.kind,'missing');assert.equal(cleanup.label,'vault cleanup report');assert.equal(cleanup.nearest,null);
 const scan=resolve(root,'show me the trend scan');assert.equal(scan.kind,'missing');assert.equal(scan.label,'AI trend scan report');
 const dated=resolve(root,'show me the cascade from monday');assert.equal(dated.kind,'missing');assert.equal(dated.nearest.path,'inbox/reports/cascades/2026-07-16-1901fc7d.md');
 assert.equal(resolve(root,'open the content plan').kind,'ambiguous');
 assert.equal(resolve(root,'pull up the skoot crm playbook').kind,'note');
 assert.equal(resolve(root,JEV),null);
 assert.notEqual(resolve(root,'show me today')?.kind,'report');
});

test('a work sentence ahead of "then open it" is a promise, conditions and negations are not, and phrasing variants count',t=>{
 const {root}=vault(t);
 assert.equal(openIntent('Create a new diagram. Then open it.'),null);assert.equal(deferredOpen('Create a new diagram. Then open it.'),true);
 assert.equal(resolve(root,'Create a new diagram. Then open it.'),null);
 for(const text of ['Create a chart and open it only after I approve it.','Create a chart and open it tomorrow.','Write a summary and when you are finished, do not under any circumstances open it.'])assert.equal(deferredOpen(text),false,text);
 for(const text of ['Create the chart; once completed, open it.','Create a chart and then, um, open it.','Create an illustration and then show the artwork.','Make the diagram and show em when done'])assert.equal(deferredOpen(text),true,text);
});

test('an exact note title beats a fuzzy workflow name, and a long ledger does not hide a workflow output',t=>{
 const {root,write}=vault(t);
 write('inbox/notes/context.md','# Context\n');write('inbox/reports/cascades/2026-09-15-1e089d8f.md','# cascade');
 write('system/runs/cascade.json',JSON.stringify({id:'c',skill:'content-cascade',status:'ok',summary:'Done.',deliverable_path:'inbox/reports/cascades/2026-09-15-1e089d8f.md',ts_completed:'2026-09-15T20:00:00Z'}));
 for(let i=0;i<120;i++)write(`system/v2/runs/metrics-${String(i).padStart(3,'0')}.json`,JSON.stringify({id:`m${i}`,skill:'metrics-pull',status:'ok',summary:'Pulled.',deliverable_path:`inbox/reports/metrics/2026-09-${String(1+(i%16)).padStart(2,'0')}-pull-${i}.md`,ts_completed:'2026-09-16T00:00:00Z'}));
 for(let i=0;i<120;i++)write(`inbox/reports/metrics/2026-09-${String(1+(i%16)).padStart(2,'0')}-pull-${i}.md`,'# metrics');
 invalidateTargetIndex(root);
 assert.deepEqual(matchSkill('context'),[]);
 const note=resolve(root,'open context');assert.equal(note.kind,'note');assert.equal(note.path,'inbox/notes/context.md');
 const cascade=resolve(root,'show me the content cascade');assert.equal(cascade.kind,'report');assert.equal(cascade.path,'inbox/reports/cascades/2026-09-15-1e089d8f.md');
});

test('editing before an open request cannot reopen an earlier output',t=>{
 const {root}=vault(t);
 const selectedTask={id:'11111111-1111-4111-8111-111111111111',turns:[{id:'old',artifacts:[{id:'a'.repeat(40),path:'old.png',mime:'image/png',open:true,isFinal:true}]}]};
 for(const text of ['Update the diagram. Then open it.','Edit the proposal. Then open it.','Fix the chart. Then open it.']){
  assert.equal(openIntent(text),null,text);assert.equal(deferredOpen(text),true,text);
  assert.equal(resolve(root,text,{selectedTask}),null,text);
 }
});

test('an exact note stays ahead of three newer partial titles and a workflow',t=>{
 const {root,write}=vault(t);write('Cascade.md');
 for(const suffix of ['agenda','ideas','notes'])write('notes/2026-09-16-cascade-'+suffix+'.md');
 write('inbox/reports/cascades/2026-09-16-deliverable.md');
 write('system/runs/cascade.json',JSON.stringify({skill:'content-cascade',status:'ok',deliverable_path:'inbox/reports/cascades/2026-09-16-deliverable.md',ts_completed:'2026-09-16T12:00:00Z'}));
 invalidateTargetIndex(root);
 const result=resolve(root,'Open cascade');assert.equal(result.kind,'note');assert.equal(result.path,'Cascade.md');
});

// --- second audit (2026-09-16, later) ---
test('a noun after a determiner is not work, and any sentence of work blocks an open now',t=>{
 const {root,write}=vault(t);write('projects/2026-06-02-design.md');write('projects/2026-06-03-draft.md');invalidateTargetIndex(root);
 assert.equal(resolve(root,'Open the design. Actually, open the proposal.')?.path,'projects/proposals/2026-06-01-dario-proposal.md');
 assert.equal(resolve(root,'Open the draft. Actually, open the proposal.')?.path,'projects/proposals/2026-06-01-dario-proposal.md');
 assert.equal(resolve(root,'Open the design')?.path,'projects/2026-06-02-design.md');
 for(const text of ['Open the proposal. Then create a summary.','Change the colours. Then show me.','Update the diagram. Then open it.','I want to design a logo. Then open it.','First create a chart. Then open it.'])assert.equal(openIntent(text),null,text);
 for(const text of ['Change the colours. Then show me.','I want to design a logo. Then open it.','First create a chart. Then open it.'])assert.equal(deferredOpen(text),true,text);
 const selectedTask={id:'11111111-1111-4111-8111-111111111111',turns:[{id:'old',artifacts:[{id:'a'.repeat(40),path:'old.png',mime:'image/png',open:true,isFinal:true}]}]};
 assert.equal(resolve(root,'First create a chart. Then open it.',{selectedTask}),null);
 // A description in a second sentence is not work.
 for(const text of ['Open the proposal. It is complete.','Open the proposal. The blue design is outdated.'])assert.equal(resolve(root,text)?.path,'projects/proposals/2026-06-01-dario-proposal.md',text);
});

test('conditions, times and retractions cancel a promise whatever the punctuation',()=>{
 for(const text of ['Create a chart and open it. Only after I approve it.','Create a chart and when done, do not, under any circumstances, open it.','Create a chart and open it in an hour.','Create a chart and open it at 5 pm.','Create a chart and open it tonight.','Create a chart and open it when done. Actually, do not.','Create a chart and open it when done. Actually, never mind the opening.'])assert.equal(deferredOpen(text),false,text);
 assert.equal(deferredOpen('Create a chart and open it at 5:30 pm.'),false);
 for(const text of ['Create a chart of sales at 3 stores and open it when done.','Write a summary and when you are finished, open it. Thanks.','Create a chart and open it when done, please.','Create a chart and open it when done. I will call the client tomorrow.'])assert.equal(deferredOpen(text),true,text);
});

test('a busy workflow ledger cannot hide an older workflow',t=>{
 const {root,write}=vault(t);
 write('inbox/reports/cascades/2026-09-10-cascade.md');write('inbox/reports/metrics/2026-09-16-metrics.md');
 const old=(Date.now()-86400000)/1000;const cascade=write('system/runs/cascade.json',JSON.stringify({skill:'content-cascade',status:'ok',deliverable_path:'inbox/reports/cascades/2026-09-10-cascade.md',ts_completed:'2026-09-10T12:00:00Z'}));fs.utimesSync(path.join(root,cascade),old,old);
 for(let i=0;i<700;i++)write(`system/runs/m${String(i).padStart(4,'0')}.json`,JSON.stringify({skill:'metrics-pull',status:'ok',deliverable_path:'inbox/reports/metrics/2026-09-16-metrics.md',ts_completed:'2026-09-16T12:00:00Z'}));
 invalidateTargetIndex(root);
 const result=resolve(root,'Show me the content cascade');assert.equal(result.kind,'report');assert.equal(result.path,'inbox/reports/cascades/2026-09-10-cascade.md');
});

test('same-title candidates in same-named folders are told apart by their parents',t=>{
 const {root,write}=vault(t);write('customers/acme/drafts/proposal.md');write('customers/other/drafts/proposal.md');invalidateTargetIndex(root);
 const result=resolve(root,'Open proposal');assert.equal(result.kind,'ambiguous');
 assert.deepEqual(result.candidates.map(c=>c.label).sort(),['proposal in acme/drafts','proposal in other/drafts']);
});
