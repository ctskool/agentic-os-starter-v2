import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {TerminalManager,cleanPrompt,terminalSpec,TERMINAL_PASTE_SETTLE_MS} from '../runner/terminals.mjs';
import {routeVoice} from '../runner/bridge-core.mjs';
import {spawn,spawnSync} from 'node:child_process';
import {windowsArguments,stopOwnedPtyTree,releaseStoppedWindowsPty} from '../runner/terminal-transport.mjs';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {WORKER_SPOKEN_STYLE,ARTIFACT_HANDOFF_INSTRUCTIONS} from '../runner/spoken-answer.mjs';
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aos-terminal-'));const processes=[];
 const spawn=(command,args)=>{const proc={pid:100+processes.length,command,args,writes:[],onData(fn){this.data=fn},onExit(fn){this.exit=fn},write(data){this.writes.push(data)},resize(){},kill(){this.killed=true}};processes.push(proc);return proc};
 const manager=new TerminalManager(directory,{directory:path.join(directory,'work'),spawn});
 t.after(()=>{manager.close();fs.rmSync(directory,{recursive:true,force:true})});return {manager,processes,directory,spawn};
}
const selection={provider:'codex',model:'gpt-6-astra'};

for(const provider of ['codex','claude'])test(`${provider} voice style travels with one work request without changing saved requests or manual resumes`,t=>{
 const {manager,processes}=fixture(t),prompt='Create a visual explanation. Return exact JSON if requested.',chosen={provider,model:provider==='codex'?'gpt-6-astra':'sonnet'};
 const task=manager.start({selection:chosen,prompt,spoken:true});
 assert.equal(processes.length,1);assert.ok(processes[0].args.at(-1).startsWith(`${prompt}\n\n${WORKER_SPOKEN_STYLE}\n\n${ARTIFACT_HANDOFF_INSTRUCTIONS}`));assert.ok(processes[0].args.at(-1).includes(task.artifactRequestKey));
 assert.equal(task.prompt,prompt);manager.start({id:task.id,selection:chosen,prompt,spoken:true});assert.equal(processes.length,1);
 manager.accept(task.id,{type:'complete',sessionId:crypto.randomUUID(),turnId:'initial',text:'{"artifact":"graphic.svg"}'});
 assert.equal(task.turns[0].text,'{"artifact":"graphic.svg"}');manager.stop(task.id);manager.resume(task.id);
 assert.match(processes[1].args.at(-1),/^Resume this conversation without using tools/);assert.ok(!processes[1].args.at(-1).includes(WORKER_SPOKEN_STYLE));
 manager.accept(task.id,{type:'complete',turnId:'resumed',text:'Ready.'});manager.send(task.id,'Typed request');assert.ok(processes[1].writes[0].startsWith(`\x1b[200~Typed request\n\n${ARTIFACT_HANDOFF_INSTRUCTIONS}`));assert.ok(processes[1].writes[0].endsWith('\x1b[201~'));assert.ok(processes[1].writes[0].includes(task.artifactRequestKey));
});

test('attachment input and resize cannot cross a stop/resume boundary with the same task ID',t=>{
 const {manager,processes}=fixture(t),task=manager.start({selection,prompt:'Attachment identity fixture'});
 const first=manager.output(task.id).instance;
 manager.accept(task.id,{type:'complete',sessionId:crypto.randomUUID(),turnId:'first',text:'Ready.'});
 manager.input(task.id,'x',first);assert.deepEqual(processes[0].writes,['x']);
 manager.stop(task.id);assert.throws(()=>manager.resize(task.id,80,24,first),/session changed/);
 manager.resume(task.id);const second=manager.output(task.id).instance;assert.notEqual(second,first);
 for(const bad of [first,'',null,17]){
  assert.throws(()=>manager.input(task.id,'\r',bad),/session changed/);
  assert.throws(()=>manager.resize(task.id,80,24,bad),/session changed/);
 }
 assert.deepEqual(processes[1].writes,[]);assert.equal(manager.live.get(task.id).sizes.at(-1).cols,110);
 manager.input(task.id,'y',second);manager.resize(task.id,80,24,second);
 assert.deepEqual(processes[1].writes,['y']);assert.equal(manager.live.get(task.id).sizes.at(-1).cols,80);
 manager.live.get(task.id).exitObserved=true;
 assert.throws(()=>manager.input(task.id,'\r',second),/session changed/);
});
test('shared terminal replay preserves the geometry of each output segment',t=>{const {manager,processes}=fixture(t);
 const task=manager.start({selection,prompt:'Geometry check'});processes[0].data('wide');manager.resize(task.id,80,20);processes[0].data('narrow');
 const all=manager.output(task.id);assert.deepEqual(all.frames,[{cols:110,rows:30,data:'wide'},{cols:80,rows:20,data:'narrow'}]);
 manager.resize(task.id,90,25);const delta=manager.output(task.id,all.cursor,all.instance);assert.deepEqual(delta.frames,[{cols:90,rows:25,data:''}]);
 processes[0].data('x'.repeat(510000));const trimmed=manager.output(task.id);assert.equal(trimmed.frames[0].cols,90);assert.equal(trimmed.frames[0].data.length,400000);
});
test('separate provider conversations run concurrently; no task is globally serialized',t=>{const {manager,processes}=fixture(t);
 const a=manager.start({selection,prompt:'First request'}),b=manager.start({selection:{provider:'claude',model:'sonnet'},prompt:'Second request'});
 assert.equal(manager.live.size,2);assert.equal(processes.length,2);
 manager.accept(a.id,{type:'complete',sessionId:crypto.randomUUID(),turnId:'one',text:'First answer'});
 manager.accept(b.id,{type:'Stop',sessionId:b.id,turnId:'two',text:'Second answer'});
 manager.send(a.id,'Follow up only on the first');assert.equal(processes[0].writes.length,1);assert.equal(processes[1].writes.length,0);
 assert.equal(manager.get(b.id).turns[0].text,'Second answer');
});
test('duplicate starts cannot repeat work, and resume never replays initial prompt',t=>{const {manager,processes}=fixture(t);const id=crypto.randomUUID();const a=manager.start({id,selection,prompt:'Original request'});
 manager.start({id,selection,prompt:'Original request'});assert.equal(processes.length,1);
 assert.throws(()=>manager.start({id,selection,prompt:'Different request'}));manager.stop(id);assert.throws(()=>manager.resume(id),/No saved/);
 manager.accept(id,{type:'complete',sessionId:crypto.randomUUID(),turnId:'one',text:'Answer'});manager.resume(id);
 assert.ok(processes[1].args.includes('resume'));assert.ok(!processes[1].args.includes(a.prompt));
});
test('voice cannot overwrite a terminal draft or inject terminal control sequences',t=>{const {manager}=fixture(t);const a=manager.start({selection,prompt:'Initial'});
 assert.throws(()=>manager.send(a.id,'too soon'),/working/);manager.accept(a.id,{type:'complete',text:'Answer',turnId:'one'});
 manager.input(a.id,'unfinished draft');assert.equal(a.state,'editing');assert.throws(()=>manager.send(a.id,'overwrite'),/working/);
 assert.throws(()=>cleanPrompt('hello\x1b[201~\rquit'),/Control/);
});
test('restarting the bridge preserves session history but does not auto-launch agents',t=>{const {manager,directory,spawn}=fixture(t);const a=manager.start({selection,prompt:'Initial'});
 manager.accept(a.id,{type:'complete',sessionId:crypto.randomUUID(),turnId:'one',text:'Saved answer'});manager.stop(a.id);
 const reopened=new TerminalManager(directory,{directory:path.join(directory,'work'),spawn});t.after(()=>reopened.close());
 assert.equal(reopened.live.size,0);assert.equal(reopened.get(a.id).state,'stopped');assert.equal(reopened.get(a.id).turns[0].text,'Saved answer');
});
test('voice explicitly requests separate terminals, and targeted follow-up skips the fast router',async t=>{const {manager,directory,processes}=fixture(t);const id=crypto.randomUUID();
 const response=await routeVoice(directory,{id,selection,transcript:'Start separate tasks: research task A and draft task B',terminalMode:true},undefined,async()=>({text:JSON.stringify({action:'tasks',reply:'Opening tasks',tasks:[{prompt:'Task A'},{prompt:'Task B'}]})}),manager);
 assert.equal(response.workIds.length,2);assert.equal(processes.length,2);assert.equal(response.tier,3);
 manager.accept(response.workIds[0],{type:'complete',text:'Answer A',turnId:'one'});
 await routeVoice(directory,{id:crypto.randomUUID(),selection,transcript:'Follow up',terminalMode:true,workTarget:response.workIds[0]},undefined,()=>{throw new Error('Should not route')},manager);
 assert.equal(processes[0].writes.length,1);assert.equal(processes[1].writes.length,0);
 await assert.rejects(routeVoice(directory,{id:crypto.randomUUID(),selection:{provider:'claude',model:'sonnet'},transcript:'Follow up',terminalMode:true,workTarget:response.workIds[0]},undefined,undefined,manager),/different provider/);
});
test('pasted follow-ups receive one separate Enter after the CLI paste window',async t=>{const {manager,processes}=fixture(t);const r=manager.start({selection,prompt:'Initial'});manager.accept(r.id,{type:'complete',text:'Ready',turnId:'one'});manager.send(r.id,'Next turn');assert.ok(processes[0].writes[0].startsWith(`\x1b[200~Next turn\n\n${ARTIFACT_HANDOFF_INSTRUCTIONS}`));assert.ok(processes[0].writes[0].endsWith('\x1b[201~'));await new Promise(resolve=>setTimeout(resolve,TERMINAL_PASTE_SETTLE_MS+50));assert.deepEqual(processes[0].writes.slice(1),['\r']);assert.ok(manager.live.get(r.id).pendingDelivery)});
test('completion hook ignores unrelated threads and preserves legitimate JSON answers',t=>{const {directory}=fixture(t);const sessionId=crypto.randomUUID();const hook=new URL('../runner/terminal-hook.mjs',import.meta.url);const event={type:'agent-turn-complete','thread-id':sessionId,'turn-id':'first','last-assistant-message':'{"title":"Requested JSON answer"}'};
 const run=data=>spawnSync(process.execPath,[hook.pathname.replace(/^\/([A-Za-z]:)/,'$1'),JSON.stringify(data)],{env:{...process.env,AOS_WORK_EVENTS:directory,AOS_WORK_SESSION:sessionId},encoding:'utf8'});
 const first=run(event);assert.equal(first.status,0,first.stderr);const count=fs.readdirSync(directory).filter(f=>f.endsWith('.json')).length;assert.equal(count,1);
 run({...event,'thread-id':crypto.randomUUID()});assert.equal(fs.readdirSync(directory).filter(f=>f.endsWith('.json')).length,1);
});
test('an established terminal session ignores all events from a different conversation',t=>{
 const {manager}=fixture(t),task=manager.start({selection,prompt:'Initial'}),sessionId=crypto.randomUUID(),otherId=crypto.randomUUID();
 manager.accept(task.id,{type:'complete',sessionId,turnId:'first',text:'Original answer'});
 manager.input(task.id,'Preserve this draft');
 const before=JSON.stringify(task);
 for(const type of ['complete','Stop','PermissionRequest','StopFailure','UserPromptSubmit'])manager.accept(task.id,{type,sessionId:otherId,turnId:type,text:'Unrelated answer'});
 assert.equal(JSON.stringify(task),before);assert.equal(task.sessionId,sessionId);assert.equal(task.state,'editing');
 manager.accept(task.id,{type:'complete',sessionId,turnId:'same-session',text:'Correct follow-up'});
 assert.equal(task.turns.at(-1).text,'Correct follow-up');assert.equal(task.sessionId,sessionId);
});
test('Codex interactive prompts survive split ANSI chunks, surface a reason, and do not answer themselves',t=>{
 const {manager,processes}=fixture(t);const task=manager.start({selection,prompt:'Complex work'}),proc=processes[0];
 proc.data('\x1b[1');proc.data('mHooks need rev');proc.data('iew\x1b[0m\r\n7 hooks are new or changed.\r\n');
 assert.equal(task.state,'working');
 proc.data('› 1. Review hooks\r\n2. Trust all and continue\r\nPress enter to confirm or esc to go back');
 assert.equal(task.state,'needs input');assert.match(task.error,/review its hooks/);assert.equal(proc.writes.length,0);
 assert.throws(()=>manager.send(task.id,'Next task'),/review its hooks/);
 manager.input(task.id,'\r');assert.equal(task.state,'working');assert.equal(task.error,null);
 proc.data('Starting the requested work');assert.equal(task.state,'working');
 proc.data('\x1b[2JDo you trust the contents of this directory?\r\n› 1. Yes, continue\r\nPress enter to confirm');
 assert.equal(task.state,'needs input');assert.match(task.error,/trust this workspace/);
 manager.input(task.id,'\r');proc.data('Would you like to run the following command?\r\n› 1. Yes, proceed\r\nPress enter to confirm');
 assert.equal(task.state,'needs input');assert.match(task.error,/your approval/);
 manager.accept(task.id,{type:'complete',turnId:'done',text:'Done'});assert.equal(task.state,'ready');assert.equal(task.error,null);
 proc.data('Documentation mentions Hooks need review as a possible prompt.');assert.equal(task.state,'ready');
 manager.stop(task.id);proc.data('\nHooks need review\n› 1. Review hooks\nPress enter to confirm');assert.equal(task.state,'stopped');
});
test('all pinned Codex action approval screens pause work without sending an answer',t=>{
 const {manager,processes}=fixture(t);
 for(const header of ['Would you like to make the following edits?','Would you like to grant these permissions?','Would you like to send input to terminal 1?','Approve app tool call?']){
  const task=manager.start({selection,prompt:'Harmless approval fixture'}),proc=processes.at(-1);
  const screen=`${header}\r\n  1. Approve\r\n  2. Approve for me\r\n› 3. Reject\r\n`;
  for(let at=0;at<screen.length;at+=7)proc.data(screen.slice(at,at+7));
  assert.equal(task.state,'needs input');assert.match(task.error,/waiting for your approval/);
  assert.throws(()=>manager.send(task.id,'Follow up before approval'),/waiting for your approval/);
  assert.deepEqual(proc.writes,[]);
  manager.input(task.id,'\r');assert.equal(task.state,'working');assert.equal(task.error,null);
  manager.accept(task.id,{type:'complete',turnId:'done',text:'Done'});assert.equal(task.state,'ready');
 }
});
test('an interrupted first turn preserves its exact original request for explicit recovery',t=>{
 const {manager,processes}=fixture(t),prompt='"Compare X and Y"\nKeep this second line.';
 const task=manager.start({selection,prompt});manager.stop(task.id);
 assert.equal(task.recoveryAvailable,true);assert.equal(manager.originalRequest(task.id).prompt,prompt);
 assert.deepEqual(manager.originalRequest(task.id).selection,selection);assert.throws(()=>manager.resume(task.id),/Recover request/);assert.equal(processes.length,1);
 assert.equal(manager.list()[0].prompt,undefined);
});
test('Windows raw PTY arguments round-trip literal quotes, Unicode, spaces and backslashes through real argv', {skip:process.platform!=='win32'},t=>{
 const {directory}=fixture(t);const probe=path.join(directory,'argument probe.cjs');fs.writeFileSync(probe,'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
 const prompts=['"Compare X and Y"','"partially quoted request','request ending with "','Line one\nLine two','C:\\Example Path\\','résumé 星 "quoted"'];
 for(const prompt of prompts){
  const spec=terminalSpec(directory,{...selection,prompt},{command:'codex.exe',prefix:[]});
  const result=spawnSync(process.execPath,[windowsArguments([probe,...spec.args])],{argv0:windowsArguments([process.execPath]),encoding:'utf8',windowsVerbatimArguments:true,timeout:5000});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),spec.args);assert.equal(JSON.parse(result.stdout).at(-1),`${prompt}\n\n${ARTIFACT_HANDOFF_INSTRUCTIONS}`);
 }
});
test('empty completion permits follow-up without inventing an answer, but preserves a pending CLI draft',t=>{
 const {manager,processes}=fixture(t);const task=manager.start({selection,prompt:'Initial'});
 manager.accept(task.id,{type:'complete',turnId:'empty',text:''});assert.equal(task.state,'ready');assert.equal(task.turns.length,0);
 manager.input(task.id,'unfinished');manager.accept(task.id,{type:'Stop',turnId:'empty-two',text:''});assert.equal(task.state,'editing');
 manager.input(task.id,'\x7f');assert.equal(task.state,'editing');assert.throws(()=>manager.markReady(task.id),/Confirm/);
 const writes=processes[0].writes.length;manager.markReady(task.id,{confirmedEmpty:true});assert.equal(task.state,'ready');assert.equal(processes[0].writes.length,writes);
 manager.send(task.id,'Now safe to continue');assert.equal(task.state,'working');manager.input(task.id,'\x03');assert.equal(task.state,'editing');
 manager.markReady(task.id,{confirmedEmpty:true});assert.equal(task.state,'ready');
});
test('bracketed multiline paste is a draft until a separate Enter, including split envelope chunks',t=>{
 const {manager}=fixture(t);const task=manager.start({selection,prompt:'Initial'});manager.accept(task.id,{type:'complete',text:''});
 manager.input(task.id,'\x1b[200~first\rsecond\x1b[201~');assert.equal(task.state,'editing');assert.throws(()=>manager.send(task.id,'Overwrite'),/working/);
 manager.input(task.id,'\r');assert.equal(task.state,'working');manager.accept(task.id,{type:'complete',text:''});assert.equal(task.state,'ready');
 manager.input(task.id,'\x1b[20');manager.input(task.id,'0~one\r');manager.input(task.id,'two\x1b[201~');assert.equal(task.state,'editing');
 manager.markReady(task.id,{confirmedEmpty:true});assert.equal(task.state,'ready');
});
test('late completion cannot revive a stopping terminal or announce successful work',t=>{
 const {manager}=fixture(t);const task=manager.start({selection,prompt:'Task'}),sessionId=crypto.randomUUID();task.state='stopping';
 manager.accept(task.id,{type:'complete',sessionId,turnId:'late',text:'Late completed answer'});
 assert.equal(task.state,'stopping');assert.equal(task.sessionId,sessionId);assert.equal(task.turns.length,0);
 assert.throws(()=>manager.markReady(task.id,{confirmedEmpty:true}),/running terminal/);
});
test('PTY tree cleanup refuses exited or unowned roots and stops only its owned process tree', {skip:process.platform!=='win32'},async t=>{
 let launches=0;const fake={proc:{pid:12345},exitObserved:true};
 assert.equal(await stopOwnedPtyTree(fake,{launch:()=>{launches++;assert.fail('exited PID cannot be used')}}),false);
 assert.equal(await stopOwnedPtyTree({...fake,exitObserved:false},{isCurrent:()=>false,launch:()=>{launches++;assert.fail('unowned PID cannot be used')}}),false);assert.equal(launches,0);
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aos-pty-tree-')),pidFile=path.join(directory,'child.pid');let descendant;
 const program="const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);";
 const proc=spawn(process.execPath,['-e',program,pidFile],{stdio:'ignore',windowsHide:true}),live={proc,exitObserved:false};proc.once('exit',()=>{live.exitObserved=true});
 t.after(()=>{if(!live.exitObserved)proc.kill();if(descendant){try{process.kill(descendant)}catch{}}fs.rmSync(directory,{recursive:true,force:true})});
 for(let attempt=0;!fs.existsSync(pidFile)&&attempt<100;attempt++)await new Promise(resolve=>setTimeout(resolve,30));
 assert.ok(fs.existsSync(pidFile));descendant=Number(fs.readFileSync(pidFile,'utf8'));
 assert.equal(await stopOwnedPtyTree(live,{isCurrent:()=>!live.exitObserved}),true);
 for(let attempt=0;attempt<30;attempt++){try{process.kill(descendant,0)}catch{return}await new Promise(resolve=>setTimeout(resolve,30))}
 assert.fail('owned child survived PTY tree cleanup');
});
test('real node-pty shuts down after tree termination without a second console-attach helper', {skip:process.platform!=='win32'},async t=>{
 const require=createRequire(import.meta.url),pty=require('node-pty'),childProcess=require('node:child_process');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aos-real-pty-')),pidFile=path.join(directory,'descendant.pid');let descendant,enumerations=0;
 const originalFork=childProcess.fork;childProcess.fork=function(file,...args){if(String(file).includes('conpty_console_list_agent'))enumerations++;return originalFork.call(this,file,...args)};
 const program="const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);";
 const manager=new TerminalManager(directory,{directory:path.join(directory,'sessions'),stopTree:true,spawn:(_command,_args,options)=>pty.spawn(process.execPath,windowsArguments(['-e',program,pidFile]),options)});
 t.after(()=>{manager.close();childProcess.fork=originalFork;if(descendant){try{process.kill(descendant)}catch{}}fs.rmSync(directory,{recursive:true,force:true})});
 const task=manager.start({selection,prompt:'No model is called'});
 for(let attempt=0;!fs.existsSync(pidFile)&&attempt<100;attempt++)await new Promise(resolve=>setTimeout(resolve,30));
 assert.ok(fs.existsSync(pidFile));descendant=Number(fs.readFileSync(pidFile,'utf8'));manager.stop(task.id);assert.equal(task.state,'stopping');
 for(let attempt=0;manager.live.has(task.id)&&attempt<100;attempt++)await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(manager.live.size,0);assert.equal(task.state,'stopped');assert.equal(task.pid,null);assert.equal(enumerations,0);
 assert.throws(()=>process.kill(descendant,0));
});
test('natural exit also releases its owned node-pty worker, and unknown resource shapes fail closed', {skip:process.platform!=='win32'},async t=>{
 assert.equal(await releaseStoppedWindowsPty({}),false);
 const require=createRequire(import.meta.url),pty=require('node-pty'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'aos-pty-natural-'));
 const manager=new TerminalManager(directory,{directory:path.join(directory,'sessions'),stopTree:true,spawn:(_command,_args,options)=>pty.spawn(process.execPath,windowsArguments(['-e','process.stdout.write("Complete")']),options)});
 t.after(()=>{manager.close();fs.rmSync(directory,{recursive:true,force:true})});const task=manager.start({selection,prompt:'No model'});
 for(let attempt=0;manager.live.has(task.id)&&attempt<100;attempt++)await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(manager.live.size,0);assert.equal(task.state,'stopped');assert.equal(task.pid,null);
});
test('owned PTY cleanup waits for the conout worker before closing its pipe destination',async()=>{
 const worker=new EventEmitter(),actions=[];let finish;
 worker.terminate=()=>{actions.push('terminate');return new Promise(resolve=>finish=resolve)};
 const proc={_agent:{_useConpty:true,_ptyNative:{kill(){actions.push('native-close')}},_conoutSocketWorker:{_worker:worker},inSocket:{destroy(){actions.push('input-close')}},outSocket:{destroy(){actions.push('output-close')}}}};
 const release=releaseStoppedWindowsPty(proc);await Promise.resolve();
 assert.deepEqual(actions,['native-close','terminate']);
 worker.emit('error',Object.assign(new Error('closed pipe'),{code:'EPIPE'}));
 finish();assert.equal(await release,true);assert.deepEqual(actions,['native-close','terminate','input-close','output-close']);
 assert.equal(await releaseStoppedWindowsPty(proc),true);assert.equal(actions.length,4);
});

test('a promised open survives an intervening turn and opens the first file the worker produces',t=>{
 const {manager,directory}=fixture(t);
 fs.writeFileSync(path.join(directory,'result.md'),'# Final document\n');
 const task=manager.start({selection,prompt:'Write the explainer, then open it.',spoken:true,openWhenDone:true});
 assert.equal(task.openWhenDone,true);
 manager.accept(task.id,{type:'complete',sessionId:crypto.randomUUID(),turnId:'question',text:'Which colour scheme?'});
 assert.equal(task.openWhenDone,true);assert.equal(task.turns[0].artifacts,undefined);
 manager.accept(task.id,{type:'complete',turnId:'done',text:'Saved it: [Report](result.md)'});
 assert.equal(task.openWhenDone,undefined);
 const [artifact]=task.turns[1].artifacts;assert.equal(artifact.open,true);assert.equal(artifact.isFinal,true);assert.equal(artifact.mime,'text/markdown');
 // A later turn without the promise opens nothing on its own.
 manager.send(task.id,'Also save a copy',{spoken:true});
 manager.accept(task.id,{type:'complete',turnId:'copy',text:'Copied: [Copy](result.md)'});
 assert.equal(task.turns[2].artifacts[0].open,false);
 manager.send(task.id,'Now redo it and show me when done',{spoken:true,openWhenDone:true});
 assert.equal(task.openWhenDone,true);
});
