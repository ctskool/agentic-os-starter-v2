import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {TerminalManager} from '../runner/terminals.mjs';
import {SKILLS} from '../shared/contract.mjs';
import {replaceDaily} from '../runner/note-edits.mjs';
import {runCommand} from '../runner/workflows.mjs';
const selection={provider:'codex',model:'gpt-6-astra'};
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-workflow-test-')),processes=[];const spawn=(command,args)=>{const proc={pid:123+processes.length,command,args,writes:[],onData(fn){this.data=fn},onExit(){},write(text){this.writes.push(text)},kill(){}};processes.push(proc);return proc};const manager=new TerminalManager(root,{directory:path.join(root,'sessions'),spawn});t.after(()=>{manager.close();fs.rmSync(root,{recursive:true,force:true})});return {root,manager,processes,spawn}}

for(const chosen of [selection,{provider:'claude',model:'sonnet'}])test(`${chosen.provider} named workflow continues the ready CLI with its actual model and a separate run identity`,t=>{
 const {root,manager,processes}=fixture(t),task=manager.start({selection:chosen,prompt:'An existing conversation'}),sessionId=crypto.randomUUID();
 manager.accept(task.id,{type:chosen.provider==='codex'?'complete':'Stop',sessionId,turnId:'initial',text:'The original answer'});
 const id=crypto.randomUUID(),requested={provider:chosen.provider,model:chosen.provider==='codex'?'gpt-5.6-luna':'opus'};
 const continued=manager.continueWorkflow(task.id,{id,selection:requested,skill:'weekly-review'});
 assert.equal(continued,task);assert.equal(processes.length,1);assert.equal(task.model,chosen.model);assert.equal(task.sessionId,sessionId);
 assert.equal(task.workflow.job.id,id);assert.equal(task.workflow.job.model,chosen.model);assert.equal(task.prompt,'An existing conversation');
 assert.match(processes[0].writes[0],new RegExp(`system/v2/task-instructions/${id}\\.md`));
 const instructions=fs.readFileSync(path.join(root,'system/v2/task-instructions',id+'.md'),'utf8');assert.match(instructions,/INTERACTIVE TERMINAL CONTRACT/);
 manager.accept(task.id,{type:chosen.provider==='codex'?'complete':'Stop',sessionId,turnId:'workflow',text:'# Complete weekly review\n\nResearch and next steps.'});
 const run=JSON.parse(fs.readFileSync(path.join(root,'system/v2/runs',id+'.json'),'utf8'));
 assert.equal(run.id,id);assert.equal(run.task_id,task.id);assert.equal(run.model,chosen.model);assert.equal(run.status,'ok');assert.equal(task.workflowCompleted,true);
 assert.equal(run.artifact_path,`system/v2/artifacts/${id}.md`);assert.equal(fs.existsSync(path.join(root,'system/v2/runs',task.id+'.json')),false);
});

test('sequential managed workflows keep old outputs and reject old completion replay beyond display history',t=>{
 const {root,manager}=fixture(t),task=manager.startWorkflow({selection,skill:'weekly-review'}),firstId=task.id;
 manager.accept(task.id,{type:'complete',turnId:'first-workflow',text:'# First report'});
 const firstDestination=task.resultPath,firstRun=fs.readFileSync(path.join(root,'system/v2/runs',firstId+'.json'),'utf8');
 for(let turn=0;turn<35;turn++)manager.accept(task.id,{type:'complete',turnId:`ordinary-${turn}`,text:`Ordinary answer ${turn}`});
 assert.equal(task.turns.some(turn=>turn.id==='first-workflow'),false);
 const secondId=crypto.randomUUID();manager.continueWorkflow(task.id,{id:secondId,selection,skill:'inbox-brief'});
 const pending=JSON.stringify(task);
 manager.accept(task.id,{type:'complete',turnId:'first-workflow',text:'# Replayed first report',ts:Date.now()});
 manager.accept(task.id,{type:'complete',turnId:'unseen-old-hook',text:'# Stale earlier completion',ts:task.workflow.startedAt-1});
 assert.equal(JSON.stringify(task),pending);assert.equal(fs.existsSync(path.join(root,'system/v2/artifacts',secondId+'.md')),false);
 manager.accept(task.id,{type:'complete',turnId:'second-workflow',text:'# Second inbox report'});
 const secondDestination=task.resultPath,secondRun=fs.readFileSync(path.join(root,'system/v2/runs',secondId+'.json'),'utf8');
 assert.equal(task.workflowHistory.length,1);assert.equal(task.workflowHistory[0].job.id,firstId);assert.equal(task.workflowHistory[0].resultPath,firstDestination);
 const summary=manager.list()[0];assert.equal(summary.workflowHistory,undefined);assert.equal(summary.completedTurnIds,undefined);
 manager.send(task.id,'Explain the result');manager.accept(task.id,{type:'complete',turnId:'later-question',text:'Explanation without replacing either report'});
 assert.equal(fs.readFileSync(path.join(root,firstDestination),'utf8'),'# First report');assert.equal(fs.readFileSync(path.join(root,secondDestination),'utf8'),'# Second inbox report');
 assert.equal(fs.readFileSync(path.join(root,'system/v2/runs',firstId+'.json'),'utf8'),firstRun);assert.equal(fs.readFileSync(path.join(root,'system/v2/runs',secondId+'.json'),'utf8'),secondRun);
});

test('continued workflow IDs deduplicate pending and historical runs without redispatch or cross-task reuse',t=>{
 const {root,manager,processes}=fixture(t),task=manager.start({selection,prompt:'Conversation'});
 manager.accept(task.id,{type:'complete',turnId:'initial',text:'Ready'});
 const id=crypto.randomUUID(),request={id,selection,skill:'deep-research-chase',args:{topic:'Original topic'}};
 manager.continueWorkflow(task.id,request);const pending=JSON.stringify(task),writes=processes[0].writes.length;
 assert.equal(manager.continueWorkflow(task.id,request),task);assert.equal(manager.startWorkflow(request),task);assert.equal(JSON.stringify(task),pending);assert.equal(processes[0].writes.length,writes);
 assert.throws(()=>manager.continueWorkflow(task.id,{...request,args:{topic:'Different topic'}}),/already used/);
 assert.throws(()=>manager.start({id,selection,prompt:'Reuse workflow identity'}),/already used/);
 manager.accept(task.id,{type:'complete',turnId:'research',text:'# Original research'});
 manager.continueWorkflow(task.id,{id:crypto.randomUUID(),selection,skill:'weekly-review'});
 const later=JSON.stringify(task),laterWrites=processes[0].writes.length;
 assert.equal(manager.continueWorkflow(task.id,request),task);assert.equal(manager.startWorkflow(request),task);assert.equal(JSON.stringify(task),later);assert.equal(processes[0].writes.length,laterWrites);
 const other=manager.start({selection,prompt:'Other conversation'});manager.accept(other.id,{type:'complete',turnId:'other-ready',text:'Ready'});
 assert.throws(()=>manager.continueWorkflow(other.id,request),/already used/);assert.equal(processes.length,2);assert.equal(processes[1].writes.length,0);
 assert.equal(fs.readFileSync(path.join(root,'system/v2/artifacts',id+'.md'),'utf8'),'# Original research');
});

test('blocked workflow continuations never create instructions, change metadata or type into a CLI',t=>{
 const {root,manager,processes}=fixture(t),task=manager.start({selection,prompt:'Conversation'});
 for(const state of ['working','starting','needs input','editing','stopping','error','stopped']){
  task.state=state;task.error=state==='needs input'?'Review this permission in its terminal.':null;
  const id=crypto.randomUUID(),before=JSON.stringify(task);
  assert.throws(()=>manager.continueWorkflow(task.id,{id,selection,skill:'weekly-review'}),/working|terminal|permission/);
  assert.equal(JSON.stringify(task),before);assert.equal(fs.existsSync(path.join(root,'system/v2/task-instructions',id+'.md')),false);assert.equal(processes[0].writes.length,0);
 }
 task.state='ready';manager.live.get(task.id).inputBoundary.update('A draft that must survive');
 const draft=JSON.stringify(task);assert.throws(()=>manager.continueWorkflow(task.id,{selection,skill:'weekly-review'}),/working/);assert.equal(JSON.stringify(task),draft);assert.equal(processes[0].writes.length,0);
 manager.live.get(task.id).inputBoundary.reset();manager.stop(task.id);const stopped=JSON.stringify(task);
 assert.throws(()=>manager.continueWorkflow(task.id,{selection,skill:'weekly-review'}),/Resume/);assert.equal(JSON.stringify(task),stopped);
});

test('continuing rejects direct scripts, provider changes and queued approvals before preparing output',t=>{
 const {root,manager,processes}=fixture(t),task=manager.start({selection,prompt:'Conversation'});
 manager.accept(task.id,{type:'complete',turnId:'initial',text:'Ready'});
 for(const skill of ['metrics-pull','github-trending'])assert.throws(()=>manager.continueWorkflow(task.id,{selection,skill}),/run as scripts/);
 assert.throws(()=>manager.continueWorkflow(task.id,{selection:{provider:'claude',model:'sonnet'},skill:'weekly-review'}),/different provider/);
 fs.writeFileSync(path.join(manager.folder(task.id),'events','queued-approval.json'),JSON.stringify({type:'PermissionRequest'}));
 const id=crypto.randomUUID();assert.throws(()=>manager.continueWorkflow(task.id,{id,selection,skill:'weekly-review'}),/approval/);
 assert.equal(task.state,'needs input');assert.equal(fs.existsSync(path.join(root,'system/v2/task-instructions',id+'.md')),false);assert.deepEqual(processes[0].writes,[]);
});

test('continued daily workflows retain destination locks, exact backups and conflict protection per run',t=>{
 const {root,manager}=fixture(t),lock=manager.startWorkflow({selection,skill:'plan-today'}),task=manager.start({selection,prompt:'Conversation'});
 manager.accept(task.id,{type:'complete',turnId:'initial',text:'Ready'});
 const blockedId=crypto.randomUUID();assert.throws(()=>manager.continueWorkflow(task.id,{id:blockedId,selection,skill:'refresh-schedule'}),/same note/);
 assert.equal(fs.existsSync(path.join(root,'system/v2/task-instructions',blockedId+'.md')),false);manager.stop(lock.id);
 const file=path.join(root,lock.workflow.destination),date=path.basename(file,'.md');fs.mkdirSync(path.dirname(file),{recursive:true});
 const before=`\uFEFF---\r\ndate: ${date}\r\nschema_version: 1\r\n---\r\n## Top 3 Priorities\r\n1. [x] Keep priority\r\n2. [ ] \r\n3. [ ] \r\n\r\n## Schedule\r\nOld\r\n\r\n## Notes\r\nKeep notes\r\n`;fs.writeFileSync(file,before);
 const answer=time=>`---\ndate: ${date}\nschema_version: 1\n---\n## Top 3 Priorities\n1. [ ] Suggested\n\n## Schedule\n- ${time} — Verified\n`;
 const first=crypto.randomUUID();manager.continueWorkflow(task.id,{id:first,selection,skill:'refresh-schedule'});manager.accept(task.id,{type:'complete',turnId:'daily-one',text:answer('10:00')});
 assert.equal(task.workflowStatus,'ok');assert.equal(fs.readFileSync(path.join(root,'system/v2/backups',first+'.md'),'utf8'),before);const merged=fs.readFileSync(file,'utf8');assert.match(merged,/Keep priority/);assert.match(merged,/Keep notes/);
 const second=crypto.randomUUID();manager.continueWorkflow(task.id,{id:second,selection,skill:'refresh-schedule'});const edited=merged.replace('10:00','11:00');fs.writeFileSync(file,edited);
 manager.accept(task.id,{type:'complete',turnId:'daily-two',text:answer('12:00')});assert.equal(task.workflowStatus,'error');assert.equal(fs.readFileSync(file,'utf8'),edited);
 assert.equal(task.resultPath,`system/v2/artifacts/${second}.md`);assert.equal(fs.existsSync(path.join(root,'system/v2/backups',second+'.md')),false);assert.equal(fs.readFileSync(path.join(root,'system/v2/backups',first+'.md'),'utf8'),before);
});

test('interrupted continued workflow resumes without submitting or saving readiness as its deliverable',t=>{
 const {root,manager,processes}=fixture(t),task=manager.start({selection,prompt:'Original request'}),sessionId=crypto.randomUUID();
 manager.accept(task.id,{type:'complete',sessionId,turnId:'initial',text:'Ready'});
 const id=crypto.randomUUID();manager.continueWorkflow(task.id,{id,selection,skill:'inbox-brief'});manager.stop(task.id);
 const recovery=manager.originalRequest(task.id);assert.equal(recovery.prompt,task.workflow.prompt);assert.equal(recovery.skill,'inbox-brief');assert.equal(recovery.title,SKILLS['inbox-brief'].label);assert.equal(recovery.selection.model,selection.model);
 const metadata=JSON.stringify(task);assert.throws(()=>manager.continueWorkflow(task.id,{selection,skill:'weekly-review'}),/Resume/);assert.equal(JSON.stringify(task),metadata);
 manager.resume(task.id);assert.equal(processes.length,2);assert.deepEqual(processes[1].writes,[]);assert.match(processes[1].args.at(-1),/without using tools or taking actions/);
 manager.accept(task.id,{type:'complete',sessionId,turnId:'resume-ready',text:'Ready for a follow-up.'});assert.equal(task.workflowCompleted,false);assert.equal(fs.existsSync(path.join(root,'system/v2/artifacts',id+'.md')),false);
 assert.throws(()=>manager.continueWorkflow(task.id,{selection,skill:'weekly-review'}),/unfinished workflow/);assert.deepEqual(processes[1].writes,[]);
 manager.send(task.id,'Continue the inbox brief');manager.accept(task.id,{type:'complete',sessionId,turnId:'completed-after-resume',text:'# Inbox brief\nVerified result'});
 assert.equal(task.workflowStatus,'ok');assert.equal(fs.readFileSync(path.join(root,'system/v2/artifacts',id+'.md'),'utf8'),'# Inbox brief\nVerified result');
});

test('persisted continued workflow identity survives restart without relaunch or duplicate work',t=>{
 const {root,manager,processes,spawn}=fixture(t),task=manager.start({selection,prompt:'Conversation'});
 manager.accept(task.id,{type:'complete',turnId:'initial',text:'Ready'});const request={id:crypto.randomUUID(),selection,skill:'weekly-review'};
 manager.continueWorkflow(task.id,request);manager.accept(task.id,{type:'complete',turnId:'continued',text:'# Weekly review'});
 manager.continueWorkflow(task.id,{id:crypto.randomUUID(),selection,skill:'inbox-brief'});manager.accept(task.id,{type:'complete',turnId:'latest',text:'# Inbox brief'});manager.stop(task.id);
 const reopened=new TerminalManager(root,{directory:path.join(root,'sessions'),spawn});t.after(()=>reopened.close());
 assert.equal(reopened.live.size,0);assert.equal(reopened.continueWorkflow(task.id,request).id,task.id);assert.equal(reopened.startWorkflow(request).id,task.id);assert.equal(processes.length,1);
 assert.throws(()=>reopened.continueWorkflow(task.id,{selection,skill:'weekly-review'}),/Resume/);assert.equal(processes.length,1);
 const pending=reopened.get(task.id);pending.workflowCompleted=false;pending.state='working';const before=JSON.stringify(pending);
 reopened.accept(task.id,{type:'complete',turnId:'continued',text:'# Replayed former output'});assert.equal(JSON.stringify(pending),before);
});

test('expiring a persistent terminal retires all workflow IDs while retaining deliverables and run evidence',t=>{
 const {root,manager,processes,spawn}=fixture(t),task=manager.start({selection,prompt:'Conversation'});
 manager.accept(task.id,{type:'complete',turnId:'initial',text:'Ready'});
 const first={id:crypto.randomUUID(),selection,skill:'weekly-review'},second={id:crypto.randomUUID(),selection,skill:'inbox-brief'};
 for(const request of [first,second]){manager.continueWorkflow(task.id,request);manager.accept(task.id,{type:'complete',turnId:request.id,text:`# ${request.skill} result`})}
 const paths=[task.workflowHistory[0].resultPath,task.resultPath];manager.stop(task.id);
 const later=manager.retention.expiresAt(task)+1;manager.now=()=>later;manager.prune();assert.equal(manager.records.has(task.id),false);
 for(const id of [task.id,first.id,second.id])assert.equal(manager.retention.retired.has(id),true);
 for(const file of paths)assert.equal(fs.existsSync(path.join(root,file)),true);
 for(const {id} of [first,second])for(const folder of ['runs','artifacts','task-instructions'])assert.equal(fs.existsSync(path.join(root,'system/v2',folder,id+(folder==='runs'?'.json':'.md'))),true);
 const reopened=new TerminalManager(root,{directory:path.join(root,'sessions'),spawn});
 try{
  const next=reopened.start({selection,prompt:'New conversation'});reopened.accept(next.id,{type:'complete',turnId:'new-ready',text:'Ready'});
  for(const request of [first,second]){
   assert.throws(()=>reopened.startWorkflow(request),/expired/);assert.throws(()=>reopened.continueWorkflow(next.id,request),/expired/);
   assert.throws(()=>reopened.start({id:request.id,selection,prompt:'Retry old identity'}),/expired/);
  }
  assert.equal(processes.length,2);assert.equal(processes[1].writes.length,0);
 }finally{reopened.close()}
});
test('model skills validate into persistent conversations with immutable task instructions',t=>{
 const {root,manager}=fixture(t);
 for(const [skill,spec] of Object.entries(SKILLS)){
  if(spec.direct)continue;
  const args=spec.arg?{[spec.arg]:spec.arg==='url'?'https://example.com':'Test topic'}:{};
  const task=manager.startWorkflow({selection,skill,args});assert.equal(task.workflow.job.skill,skill);assert.ok(task.prompt.includes('system/v2/task-instructions/'));assert.ok(fs.existsSync(path.join(root,'system/v2/task-instructions',task.id+'.md')));
  assert.equal(manager.startWorkflow({id:task.id,selection,skill,args}).id,task.id);manager.stop(task.id);
 }
});
test('same daily note tasks conflict but independent same-day reports have separate destinations',t=>{
 const {manager}=fixture(t);manager.startWorkflow({selection,skill:'plan-today'});
 assert.throws(()=>manager.startWorkflow({selection,skill:'refresh-schedule'}),/same note/);
 const a=manager.startWorkflow({selection,skill:'weekly-review'}),b=manager.startWorkflow({selection,skill:'weekly-review'});
 assert.notEqual(a.workflow.destination,b.workflow.destination);assert.equal(manager.live.size,3);
});
test('external edits survive completion and the proposed output remains available',t=>{
 const {root,manager}=fixture(t);const a=manager.startWorkflow({selection,skill:'weekly-review'});
 const destination=path.join(root,a.workflow.destination);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,'Newer user edit');
 manager.accept(a.id,{type:'complete',turnId:'one',text:'# Proposed weekly review'});
 assert.equal(fs.readFileSync(destination,'utf8'),'Newer user edit');assert.equal(a.workflowStatus,'error');assert.match(a.error,/changed/);assert.match(fs.readFileSync(path.join(root,a.resultPath),'utf8'),/Proposed/);
});
test('a skill result is saved once; resume readiness cannot become a deliverable',t=>{
 const {root,manager}=fixture(t);const a=manager.startWorkflow({selection,skill:'inbox-brief'});
 a.sessionId=crypto.randomUUID();manager.stop(a.id);manager.resume(a.id);
 manager.accept(a.id,{type:'complete',turnId:'ready',text:'Ready for a follow-up.'});assert.equal(a.workflowCompleted,undefined);
 manager.send(a.id,'Continue the inbox brief');manager.accept(a.id,{type:'complete',turnId:'done',text:'# Inbox brief\n\nVerified content.'});
 assert.equal(a.workflowStatus,'ok');assert.match(fs.readFileSync(path.join(root,a.resultPath),'utf8'),/Verified content/);
 manager.accept(a.id,{type:'complete',turnId:'followup',text:'A follow-up answer'});assert.match(fs.readFileSync(path.join(root,a.resultPath),'utf8'),/Verified content/);
});
test('blocked connector output cannot replace a real report',t=>{
 const {root,manager}=fixture(t);const a=manager.startWorkflow({selection,skill:'inbox-brief'});
 manager.accept(a.id,{type:'complete',turnId:'blocked',text:'BLOCKED: Gmail unavailable.'});assert.equal(a.workflowStatus,'error');assert.equal(fs.existsSync(path.join(root,a.workflow.destination)),false);
});
test('daily workflow merges only empty priorities and schedule, with an exact backup',t=>{
 const {root,manager}=fixture(t);const seed=manager.startWorkflow({selection,skill:'plan-today'});manager.stop(seed.id);
 const dest=path.join(root,seed.workflow.destination),date=path.basename(dest,'.md');fs.mkdirSync(path.dirname(dest),{recursive:true});
 const before=`---\ndate: ${date}\nschema_version: 1\n---\n## Top 3 Priorities\n1. [x] Keep my completed priority\n2. [ ] \n3. [ ] \n\n## Schedule\nOld schedule\n\n## Notes\nPrivate notes retained\n`;
 fs.writeFileSync(dest,before);const a=manager.startWorkflow({selection,skill:'plan-today'});
 manager.accept(a.id,{type:'complete',turnId:'daily',text:`---\ndate: ${date}\nschema_version: 1\n---\n## Top 3 Priorities\n1. [ ] New priority\n\n## Schedule\n- 10:00 — Verified event\n\n## Notes\nIgnore this replacement\n`});
 assert.equal(a.workflowStatus,'ok');const after=fs.readFileSync(dest,'utf8');assert.match(after,/Keep my completed priority/);assert.match(after,/Private notes retained/);assert.match(after,/2\. \[ \] New priority/);assert.match(after,/Verified event/);assert.equal(fs.readFileSync(path.join(root,'system/v2/backups',a.id+'.md'),'utf8'),before);
 replaceDaily(root,{path:a.workflow.destination,before:after,after:after+'User update\n'});
 assert.throws(()=>replaceDaily(root,{path:a.workflow.destination,before:after,after:'Stale replacement'}),/changed/);assert.match(fs.readFileSync(dest,'utf8'),/User update/);
 assert.throws(()=>replaceDaily(root,{path:'../outside.md',before:'',after:'no'}),/Invalid/);
});
test('an empty calendar section is valid, while a missing calendar heading remains blocked',t=>{
 const {root,manager}=fixture(t);const seed=manager.startWorkflow({selection,skill:'plan-today'});manager.stop(seed.id);
 const date=path.basename(seed.workflow.destination,'.md'),file=path.join(root,seed.workflow.destination);fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,`---\ndate: ${date}\nschema_version: 1\n---\n## Top 3 Priorities\n1. [ ] \n\n## Schedule\n\n## Notes\n`);
 const a=manager.startWorkflow({selection,skill:'plan-today'});
 manager.accept(a.id,{type:'complete',turnId:'empty',text:`---\ndate: ${date}\nschema_version: 1\n---\n## Top 3 Priorities\n1. [ ] Work\n\n## Schedule\n\n## Notes\n`});
 assert.equal(a.workflowStatus,'ok');assert.match(fs.readFileSync(path.join(root,a.resultPath),'utf8'),/## Schedule\n\n/);
 const b=manager.startWorkflow({selection,skill:'refresh-schedule'});
 manager.accept(b.id,{type:'complete',turnId:'missing',text:`---\ndate: ${date}\n---\n## Notes\nNo calendar checked.`});assert.equal(b.workflowStatus,'error');
});
test('direct workflows require no CLI, return immediately, deduplicate and publish a saved completion',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-direct-'));let calls=0,release;const changes=[];
 const manager=new TerminalManager(root,{directory:path.join(root,'sessions'),spawn:()=>assert.fail('direct skills must not spawn a PTY'),direct:async()=>{calls++;return new Promise(resolve=>{release=resolve})}});
 t.after(()=>{manager.close();fs.rmSync(root,{recursive:true,force:true})});manager.onChange=r=>changes.push({state:r.state,turns:r.turns.length});
 const task=manager.startWorkflow({selection,skill:'metrics-pull'}),done=manager.live.get(task.id).done;
 assert.equal(task.execution,'script');assert.equal(task.model,'none');assert.equal(task.state,'working');
 assert.equal(manager.startWorkflow({id:task.id,selection,skill:'metrics-pull'}),task);
 assert.throws(()=>manager.startWorkflow({selection,skill:'metrics-pull'}),/already running/);
 await Promise.resolve();assert.equal(calls,1);release({text:'# Metrics refresh\nDone'});await done;
 assert.equal(task.state,'stopped');assert.equal(task.workflowStatus,'ok');assert.equal(manager.live.size,0);assert.equal(task.turns.length,1);
 assert.equal(fs.readFileSync(path.join(root,task.resultPath),'utf8'),'# Metrics refresh\nDone');
 const record=JSON.parse(fs.readFileSync(path.join(root,'system/v2/runs',task.id+'.json'),'utf8'));assert.equal(record.execution,'script');assert.equal(record.model,'none');
 assert.ok(changes.some(change=>change.turns===1));assert.throws(()=>manager.resume(task.id),/new refresh/);
});
test('script-owned GitHub output is retained without a competing bridge replacement',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-direct-github-'));let expected;
 const manager=new TerminalManager(root,{directory:path.join(root,'sessions'),spawn:()=>assert.fail('no PTY'),direct:async(_root,job)=>{
  const task=manager.get(job.id);expected=path.join(root,task.workflow.destination);fs.mkdirSync(path.dirname(expected),{recursive:true});fs.writeFileSync(expected,'# GitHub source report');return {text:'# GitHub source report',ownsDestination:true};
 }});t.after(()=>{manager.close();fs.rmSync(root,{recursive:true,force:true})});
 const task=manager.startWorkflow({selection,skill:'github-trending'});await manager.live.get(task.id).done;
 assert.equal(task.workflowStatus,'ok');assert.equal(path.join(root,task.resultPath),expected);assert.equal(fs.readFileSync(expected,'utf8'),'# GitHub source report');
 assert.equal(fs.existsSync(path.join(root,'system/v2/backups',task.id+'.md')),false);
});
test('stopping a direct source refresh aborts it and cannot publish a late successful result',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-direct-stop-'));let signal,release;
 const manager=new TerminalManager(root,{directory:path.join(root,'sessions'),direct:async(_root,_job,options)=>{signal=options.signal;return new Promise(resolve=>{release=resolve})}});
 t.after(()=>{manager.close();fs.rmSync(root,{recursive:true,force:true})});
 const task=manager.startWorkflow({selection,skill:'metrics-pull'}),done=manager.live.get(task.id).done;await Promise.resolve();manager.stop(task.id);
 assert.equal(signal.aborted,true);assert.equal(task.state,'stopping');assert.equal(manager.live.size,1);assert.throws(()=>manager.startWorkflow({selection,skill:'metrics-pull'}),/already running/);
 release({text:'Late success'});await done;assert.equal(task.state,'stopped');assert.equal(manager.live.size,0);assert.equal(task.turns.length,0);assert.equal(task.workflowStatus,'error');assert.equal(fs.existsSync(path.join(root,task.workflow.destination)),false);
});
test('daily merges preserve concurrent activity logging but reject changed priorities or schedule',t=>{
 const {root,manager}=fixture(t);const seed=manager.startWorkflow({selection,skill:'plan-today'});manager.stop(seed.id);
 const file=path.join(root,seed.workflow.destination),date=path.basename(file,'.md');fs.mkdirSync(path.dirname(file),{recursive:true});
 const before=`---\ndate: ${date}\nschema_version: 1\n---\n## Top 3 Priorities\n1. [ ] \n\n## Schedule\n- 09:00 — Old\n\n## Activity Log\n- Existing entry\n\n## Notes\nKeep notes\n`;
 const answer=`---\ndate: ${date}\nschema_version: 1\n---\n## Top 3 Priorities\n1. [ ] Suggested priority\n\n## Schedule\n- 10:00 — New event\n`;
 fs.writeFileSync(file,before);const a=manager.startWorkflow({selection,skill:'plan-today'});
 const current=before.replace('- Existing entry','- Existing entry\n- Hook activity while agent worked').replace('Keep notes','Updated user notes');fs.writeFileSync(file,current);
 manager.accept(a.id,{type:'complete',turnId:'activity',text:answer});assert.equal(a.workflowStatus,'ok');const merged=fs.readFileSync(file,'utf8');
 assert.match(merged,/Hook activity while agent worked/);assert.match(merged,/Updated user notes/);assert.match(merged,/Suggested priority/);assert.match(merged,/New event/);
 assert.equal(fs.readFileSync(path.join(root,'system/v2/backups',a.id+'.md'),'utf8'),current);
 for(const change of [text=>text.replace('1. [ ] ','1. [ ] User priority'),text=>text.replace('09:00 — Old','11:00 — User appointment')]){
  fs.writeFileSync(file,before);const task=manager.startWorkflow({selection,skill:'plan-today'}),edited=change(before);fs.writeFileSync(file,edited);
  manager.accept(task.id,{type:'complete',turnId:'conflict',text:answer});assert.equal(task.workflowStatus,'error');assert.equal(fs.readFileSync(file,'utf8'),edited);
 }
});
test('cancelling a direct command terminates its owned subprocess tree',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aos-stop-tree-')),pidFile=path.join(directory,'owned-child.pid'),controller=new AbortController();let descendant;
 t.after(()=>{controller.abort();if(descendant){try{process.kill(descendant)}catch{}}fs.rmSync(directory,{recursive:true,force:true})});
 const program="const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);";
 const run=runCommand(process.execPath,['-e',program,pidFile],{signal:controller.signal,timeout:10000});
 for(let attempt=0;!fs.existsSync(pidFile)&&attempt<100;attempt++)await new Promise(resolve=>setTimeout(resolve,30));
 assert.ok(fs.existsSync(pidFile),'owned child started');descendant=Number(fs.readFileSync(pidFile,'utf8'));assert.ok(descendant>0);
 controller.abort();await assert.rejects(run,/Task stopped/);
 // Process closure can precede the platform removing the descendant entry.
 for(let attempt=0;attempt<30;attempt++){try{process.kill(descendant,0)}catch{return}await new Promise(resolve=>setTimeout(resolve,30))}
 assert.fail('the owned descendant remained alive after cancellation');
});
test('restarting after an interrupted source refresh clears its stale running receipt without replay',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-direct-restart-'));let release;
 const options={directory:path.join(root,'sessions'),direct:()=>new Promise(resolve=>{release=resolve})};
 const original=new TerminalManager(root,options),task=original.startWorkflow({selection,skill:'metrics-pull'}),done=original.live.get(task.id).done;await Promise.resolve();
 // Simulate a lost process; only persisted state passes to the new manager.
 original.live.delete(task.id);clearInterval(original.timer);
 const reopened=new TerminalManager(root,{...options,direct:()=>assert.fail('must not replay interrupted work')});
 t.after(()=>{reopened.close();fs.rmSync(root,{recursive:true,force:true})});release({text:'Lost completion'});await done;
 assert.equal(reopened.get(task.id).state,'stopped');assert.equal(reopened.get(task.id).workflowStatus,'error');
 const receipt=JSON.parse(fs.readFileSync(path.join(root,'system/v2/runs',task.id+'.json'),'utf8'));assert.equal(receipt.status,'error');assert.match(receipt.summary,/interrupted/);
});
