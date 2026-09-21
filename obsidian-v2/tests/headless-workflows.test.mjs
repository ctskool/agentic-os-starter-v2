import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {NativeTerminalManager} from '../runner/native-terminals.mjs';
import {destinationFor} from '../runner/workflows.mjs';

const selections=[{provider:'codex',model:'gpt-6-astra'},{provider:'claude',model:'sonnet'}];
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-background-')),calls=[];
 const options={directory:path.join(root,'sessions'),spawn:()=>assert.fail('Background jobs must not allocate a PTY'),resolveNativeCli:()=>assert.fail('Background jobs must not create native terminal tickets'),execute:(root,job,prompt,{signal})=>new Promise((resolve,reject)=>calls.push({root,job,prompt,signal,resolve,reject}))};
 const manager=new NativeTerminalManager(root,options);
 t.after(async()=>{manager.close();for(const call of calls)call.reject(new Error('Fixture closed'));await Promise.allSettled([...manager.live.values()].map(live=>live.done));fs.rmSync(root,{recursive:true,force:true})});
 const run=id=>JSON.parse(fs.readFileSync(path.join(root,'system/v2/runs',id+'.json'),'utf8'));
 return {root,manager,options,calls,run};
}
for(const selection of selections)for(const appScope of ['native','web'])test(`${selection.provider} ${appScope} button runs one background CLI and saves its report without a conversation`,async t=>{
 const {root,manager,calls,run}=fixture(t),request={id:crypto.randomUUID(),selection,skill:'weekly-review',execution:'headless',appScope};
 const task=manager.startWorkflow(request),done=manager.live.get(task.id).done;
 assert.equal(task.execution,'headless');assert.equal(task.appScope,appScope);assert.equal(task.state,'working');assert.equal(task.native,undefined);
 assert.equal(run(task.id).status,'running');assert.equal(run(task.id).appScope,appScope);
 assert.equal(manager.startWorkflow(request),task);
 await Promise.resolve();assert.equal(calls.length,1);assert.equal(calls[0].job.provider,selection.provider);assert.equal(calls[0].job.model,selection.model);assert.equal(calls[0].job.execution,'headless');
 const instructions=fs.readFileSync(path.join(root,'system/v2/task-instructions',task.id+'.md'),'utf8');
 assert.match(instructions,/BACKGROUND WORKFLOW CONTRACT/);assert.doesNotMatch(instructions,/INTERACTIVE TERMINAL CONTRACT/);assert.match(calls[0].prompt,/Return JSON/);
 manager.accept(task.id,{type:'complete',sessionId:crypto.randomUUID(),turnId:'unexpected-hook',text:'# Wrong report'});
 assert.equal(task.sessionId,null);assert.equal(task.workflowCompleted,undefined);assert.equal(task.turns.length,0);
 assert.throws(()=>manager.input(task.id,'text'),/Background workflows/);assert.throws(()=>manager.send(task.id,'follow-up'),/Background workflows/);assert.throws(()=>manager.resume(task.id),/Background workflows/);
 calls[0].resolve({status:'ok',summary:'Weekly report ready',text:'# Weekly review\n\nCompleted research.'});await done;
 assert.equal(task.state,'stopped');assert.equal(task.workflowStatus,'ok');assert.equal(task.turns.length,0);assert.equal(task.sessionId,null);assert.equal(task.recoveryAvailable,false);assert.equal(manager.live.size,0);
 assert.equal(run(task.id).status,'ok');assert.equal(run(task.id).execution,'headless');assert.equal(run(task.id).appScope,appScope);
 assert.equal(fs.readFileSync(path.join(root,run(task.id).deliverable_path),'utf8'),'# Weekly review\n\nCompleted research.');
 assert.equal(manager.startWorkflow(request),task);assert.equal(calls.length,1);
 assert.throws(()=>manager.startWorkflow({...request,appScope:appScope==='native'?'web':'native'}),/different workflow or app/);
 assert.throws(()=>manager.startWorkflow({...request,execution:appScope==='native'?'native':undefined}),/different workflow or app/);
});
for(const selection of selections)test(`${selection.provider} blocked or failed headless runs never replace a report or advertise success`,async t=>{
 const {root,manager,calls,run}=fixture(t);
 for(const outcome of ['blocked','empty','timeout']){
  const task=manager.startWorkflow({selection,skill:'weekly-review',execution:'headless'}),done=manager.live.get(task.id).done;
  const destination=path.join(root,task.workflow.destination);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,'Existing report');
  await Promise.resolve();const call=calls.at(-1);
  if(outcome==='timeout')call.reject(new Error('Worker timed out after 1200 seconds'));
  else call.resolve(outcome==='blocked'?{status:'blocked',summary:'Calendar connector unavailable',text:'Could not read the calendar'}:{status:'ok',text:''});
  await done;assert.equal(task.state,'error');assert.equal(task.workflowStatus,'error');assert.equal(run(task.id).status,'error');assert.equal(run(task.id).deliverable_path,null);
  assert.equal(fs.readFileSync(destination,'utf8'),'Existing report');assert.equal(task.turns.length,0);
 }
});
test('cancellation keeps the running lock until CLI closure and discards a late successful result',async t=>{
 const {root,manager,calls,run}=fixture(t),selection=selections[0];
 const task=manager.startWorkflow({selection,skill:'plan-today',execution:'headless'}),done=manager.live.get(task.id).done;
 await Promise.resolve();manager.stop(task.id);assert.equal(calls[0].signal.aborted,true);assert.equal(task.state,'stopping');assert.equal(manager.live.size,1);
 assert.throws(()=>manager.startWorkflow({selection,skill:'refresh-schedule',execution:'headless'}),/same note/);
 calls[0].resolve({status:'ok',text:'# A late result'});await done;
 assert.equal(task.state,'stopped');assert.equal(run(task.id).status,'error');assert.match(run(task.id).summary,/stopped/);assert.equal(fs.existsSync(path.join(root,task.workflow.destination)),false);assert.equal(manager.live.size,0);
});
test('daily-note background saves preserve BOM, CRLF, notes and concurrent editing conflicts',async t=>{
 const {root,manager,calls,run}=fixture(t),selection=selections[0],id=crypto.randomUUID();
 const relative=destinationFor({id,skill:'refresh-schedule',ts:new Date().toISOString()}),file=path.join(root,relative),date=path.basename(relative,'.md');fs.mkdirSync(path.dirname(file),{recursive:true});
 const before=`\uFEFF---\r\ndate: ${date}\r\nschema_version: 1\r\n---\r\n## Top 3 Priorities\r\n1. [x] User priority\r\n2. [ ] \r\n3. [ ] \r\n\r\n## Schedule\r\nOld schedule\r\n\r\n## Notes\r\nKeep my notes\r\n`;
 const answer=`---\ndate: ${date}\nschema_version: 1\n---\n## Top 3 Priorities\n1. [ ] Suggested\n\n## Schedule\n- 10:00 — Calendar event\n`;
 fs.writeFileSync(file,before);const first=manager.startWorkflow({id,selection,skill:'refresh-schedule',execution:'headless'}),firstDone=manager.live.get(first.id).done;
 await Promise.resolve();calls[0].resolve({status:'ok',text:answer});await firstDone;
 const merged=fs.readFileSync(file,'utf8');assert.equal(run(first.id).status,'ok');assert.equal(merged[0],'\uFEFF');assert.doesNotMatch(merged,/(?<!\r)\n/);assert.match(merged,/User priority/);assert.match(merged,/Keep my notes/);assert.match(merged,/Calendar event/);
 assert.equal(fs.readFileSync(path.join(root,'system/v2/backups',first.id+'.md'),'utf8'),before);
 const second=manager.startWorkflow({selection,skill:'refresh-schedule',execution:'headless'}),secondDone=manager.live.get(second.id).done;
 const newer=merged.replace('10:00','11:00');fs.writeFileSync(file,newer);await Promise.resolve();calls[1].resolve({status:'ok',text:answer});await secondDone;
 assert.equal(run(second.id).status,'error');assert.equal(fs.readFileSync(file,'utf8'),newer);assert.equal(fs.readFileSync(path.join(root,run(second.id).artifact_path),'utf8'),answer);
});
test('bridge recovery marks interrupted background runs failed without replaying work',async t=>{
 const {root,manager,options,calls,run}=fixture(t),task=manager.startWorkflow({selection:selections[0],skill:'weekly-review',execution:'headless',appScope:'native'}),done=manager.live.get(task.id).done;
 await Promise.resolve();manager.closed=true;clearInterval(manager.timer);clearInterval(manager.retentionTimer);manager.live.clear();
 const recovered=new NativeTerminalManager(root,{...options,execute:()=>assert.fail('A restarted bridge must never replay a workflow')});
 try{
  const restored=recovered.get(task.id);assert.equal(restored.state,'error');assert.equal(restored.workflowStatus,'error');assert.equal(restored.recoveryAvailable,false);assert.equal(recovered.live.size,0);assert.match(run(task.id).summary,/interrupted/);
  calls[0].resolve({status:'ok',text:'# Stale result'});await done;assert.equal(fs.existsSync(path.join(root,task.workflow.destination)),false);assert.match(run(task.id).summary,/interrupted/);
 }finally{recovered.close()}
});
test('direct script buttons keep their script runner with app ownership and no PTY/model',async t=>{
 const {manager,run}=fixture(t);manager.direct=async()=>({text:'# Metrics\nFresh source data'});
 const task=manager.startWorkflow({selection:selections[1],skill:'metrics-pull',execution:'headless',appScope:'native'}),done=manager.live.get(task.id).done;
 assert.equal(task.execution,'script');assert.equal(task.background,true);assert.equal(task.appScope,'native');await done;
 assert.equal(run(task.id).status,'ok');assert.equal(run(task.id).execution,'script');assert.equal(run(task.id).appScope,'native');
});
test('request persistence failure prevents any headless CLI launch',async t=>{
 const {manager,calls}=fixture(t),id=crypto.randomUUID();manager.save=()=>{throw new Error('Fixture disk write refused')};
 assert.throws(()=>manager.startWorkflow({id,selection:selections[0],skill:'weekly-review',execution:'headless'}),/disk write refused/);
 await Promise.resolve();assert.equal(calls.length,0);assert.equal(manager.live.size,0);assert.equal(manager.get(id).state,'error');assert.match(manager.get(id).error,/No worker was started/);
});
test('unconfirmed CLI shutdown stays failed and retains its source lock until actual closure',async t=>{
 const {manager,calls,run}=fixture(t),selection=selections[0];
 const task=manager.startWorkflow({selection,skill:'refresh-schedule',execution:'headless'}),done=manager.live.get(task.id).done;
 await Promise.resolve();manager.stop(task.id);
 let closed;const error=new Error('Workflow cancelled; process shutdown could not be confirmed.');error.cleanupUnconfirmed=true;error.closed=new Promise(resolve=>{closed=resolve});
 calls[0].reject(error);await done;
 assert.equal(task.state,'error');assert.match(task.error,/could not be confirmed/);assert.equal(run(task.id).status,'error');assert.equal(manager.live.size,1);assert.equal(task.workflowCompleted,false);
 assert.throws(()=>manager.startWorkflow({selection,skill:'plan-today',execution:'headless'}),/same note/);
 closed();await Promise.resolve();assert.equal(manager.live.size,0);assert.equal(task.state,'error');assert.equal(task.workflowCompleted,true);
});
