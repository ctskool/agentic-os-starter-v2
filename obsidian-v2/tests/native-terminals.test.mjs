import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {NativeTerminalManager,NATIVE_LAUNCH_TIMEOUT_MS,NATIVE_PRESENCE_TIMEOUT_MS} from '../runner/native-terminals.mjs';
import {terminalSpec,TERMINAL_DELIVERY_TIMEOUT_MS} from '../runner/terminals.mjs';
import {WORKER_SPOKEN_STYLE,ARTIFACT_HANDOFF_INSTRUCTIONS} from '../runner/spoken-answer.mjs';
import {readNativeTicket,runNativeLaunch} from '../runner/native-launch.mjs';
import {taskInScope,setCurrent,readCurrentState} from '../runner/current-conversations.mjs';

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-terminal-coordinator-')),processes=[],managers=[],watches=[];
 let now=100000;
 const resolveNativeCli=provider=>({command:process.execPath,prefix:[`fixture-${provider}.mjs`],source:'fixture'});
 const options={directory:path.join(root,'work'),now:()=>now,resolveNativeCli,stopTree:false,
  schedule:()=>({unref(){}}),cancelSchedule(){},defer:()=>({unref(){}}),cancelDeferred(){},
  deliveryWatch:(session,text)=>{const watcher={session,text,poll:()=>false,closed:false,close(){this.closed=true}};watches.push(watcher);return watcher},
  spawn(command,args){const proc={command,args,pid:500+processes.length,writes:[],killed:false,write(text){this.writes.push(text)},onData(fn){this.data=fn},onExit(fn){this.exit=fn},resize(){},kill(){this.killed=true}};processes.push(proc);return proc},
 };
 const open=()=>{const manager=new NativeTerminalManager(root,options);managers.push(manager);return manager};
 const manager=open();
 t.after(()=>{for(const item of managers)item.close();fs.rmSync(root,{recursive:true,force:true})});
 const start=(provider='codex',extra={})=>manager.start({selection:{provider,model:provider==='codex'?'gpt-6-astra':'sonnet'},prompt:'Initial request',execution:'native',...extra});
 const action=(task,type)=>task.native.actions.find(item=>item.type===type&&item.state==='pending');
 const launched=task=>{const launch=action(task,'launch');manager.claimNative(launch.id);manager.accept(task.id,{type:'native-start',taskId:task.id,nativeInstance:task.native.instance,pid:700,ts:now});manager.nativeEvent({taskId:task.id,instance:task.native.instance,actionId:launch.id,type:'launched',hostPid:600});return launch};
 const ready=task=>{launched(task);manager.accept(task.id,{type:task.provider==='codex'?'complete':'Stop',sessionId:crypto.randomUUID(),nativeInstance:task.native.instance,turnId:crypto.randomUUID(),text:'The first saved answer.',ts:now});assert.equal(task.state,'ready');return task};
 const followup=task=>{manager.send(task.id,'Add the next detail.',{spoken:true});return action(task,'send')};
 const check=(task,send)=>manager.submitNative({taskId:task.id,instance:task.native.instance,actionId:send.id,requestKey:send.requestKey});
 return {root,manager,processes,watches,start,action,launched,ready,followup,check,open,resolveNativeCli,now:()=>now,advance:(ms,current=manager)=>{now+=ms;current?.collect()}};
}

for(const sessionId of [undefined,'11111111-1111-4111-8111-111111111111']){
 test(`native Codex ${sessionId?'resume':'launch'} requests builtin automatic review without bypassing sandbox or prompts`,t=>{
  const f=fixture(t),record={provider:'codex',model:'gpt-6-astra',prompt:'A harmless fixture',execution:'native',sessionId};
  const spec=terminalSpec(f.root,record,f.resolveNativeCli('codex'));
  const flags=spec.args.slice(0,spec.args.indexOf('--'));
  assert.ok(flags.includes('--approve-for-me'));
  for(const forbidden of ['-a','--ask-for-approval','never','danger-full-access','--dangerously-bypass-approvals-and-sandbox','--dangerously-bypass-hook-trust'])assert.ok(!flags.includes(forbidden),forbidden);
  if(sessionId)assert.deepEqual(flags.slice(1,3),['resume',sessionId]);
 });
 test(`web Codex ${sessionId?'resume':'launch'} keeps explicit sandbox and user review`,t=>{
  const f=fixture(t),spec=terminalSpec(f.root,{provider:'codex',model:'gpt-6-astra',prompt:'A harmless fixture',sessionId},f.resolveNativeCli('codex'));
  assert.ok(!spec.args.includes('--approve-for-me'));
  assert.equal(spec.args[spec.args.indexOf('-s')+1],'workspace-write');
  assert.equal(spec.args[spec.args.indexOf('-a')+1],'on-request');
 });
}

for(const provider of ['codex','claude']){
 test(`${provider}: native launch writes one full CLI ticket and never starts a bridge PTY`,t=>{
  const f=fixture(t),prompt='Keep the exact newlines and quotes.\n'+('Long request detail "quoted" $(literal) `literal`.\n'.repeat(220));
  const task=f.start(provider,{prompt,spoken:true});
  assert.equal(f.processes.length,0);assert.equal(task.execution,'native');assert.equal(task.state,'starting');assert.equal(task.pid,null);
  const nativeLive=f.manager.live.get(task.id);assert.equal(nativeLive.proc,undefined);assert.equal(nativeLive.output,undefined);assert.equal(nativeLive.sizes,undefined);
  const launch=f.action(task,'launch'),ticket=readNativeTicket(task.native.ticket);
  assert.equal(ticket.args.includes('--approve-for-me'),provider==='codex');
  const expected=terminalSpec(f.root,task,f.resolveNativeCli(provider),{events:f.manager.artifactOutbox(task.id)});
  assert.deepEqual({command:ticket.command,args:ticket.args},expected);assert.equal(ticket.args.at(-1),ticket.env.AOS_WORK_PROMPT);
  assert.ok(ticket.args.at(-1).startsWith(`${prompt.trim()}\n\n${WORKER_SPOKEN_STYLE}`));assert.ok(ticket.args.at(-1).includes(ARTIFACT_HANDOFF_INSTRUCTIONS));
  assert.equal(ticket.taskId,task.id);assert.equal(ticket.instance,task.native.instance);assert.equal(ticket.cwd,f.root);
  assert.equal(launch.launch.executable,process.execPath);assert.equal(launch.launch.args.at(-1),task.native.ticket);assert.ok(!launch.launch.args.includes(prompt));
  assert.ok(launch.launch.environment.some(entry=>entry[0]==='AOS_V2_NATIVE_DIRECT'&&entry[1]==='1'));
  const expectedHash=crypto.createHash('sha256').update(ticket.args.at(-1).replace(/\r\n?/g,'\n').trim()).digest('hex');
  for(const dir of [ticket.events,f.manager.artifactOutbox(task.id)]){
   const meta=JSON.parse(fs.readFileSync(path.join(dir,'active-request.meta'),'utf8'));assert.equal(meta.expectedPromptHash,expectedHash);assert.equal(meta.accepted,false);
  }
  assert.equal(f.manager.start({id:task.id,selection:{provider,model:task.model},prompt,spoken:true,execution:'native'}),task);
  assert.equal(f.manager.pendingNative().actions.length,1);assert.equal(f.processes.length,0);
 });

 test(`${provider}: a native command has one durable claim and no second input submission`,t=>{
  const f=fixture(t),task=f.ready(f.start(provider)),send=f.followup(task),original=task.prompt;
  assert.equal(f.check(task,send).submit,false,'Unclaimed input cannot submit');
  const claimed=f.manager.claimNative(send.id).action;assert.equal(claimed.text,send.text);assert.ok(claimed.text.startsWith('Add the next detail.\n\n'+WORKER_SPOKEN_STYLE));
  assert.ok(claimed.text.includes(task.artifactRequestKey));assert.equal(task.prompt,original);assert.equal(f.processes.length,0);
  assert.throws(()=>f.manager.claimNative(send.id),/already claimed/);assert.equal(f.check(task,send).submit,true);
  assert.equal(f.manager.submitNative({taskId:task.id,instance:task.native.instance,actionId:send.id,requestKey:crypto.randomUUID()}).submit,false);
  f.manager.nativeEvent({taskId:task.id,instance:task.native.instance,actionId:send.id,type:'input-written'});
  assert.equal(f.check(task,send).submit,false);assert.equal(f.manager.pendingNative().actions.length,0);
  f.manager.nativeEvent({taskId:task.id,instance:task.native.instance,actionId:send.id,type:'input-written'});
  assert.equal(f.processes.length,0,'Acknowledgement retry never creates a PTY or writes input');
 });

 test(`${provider}: approval, human editing and cancelled input revoke native Enter authorization`,t=>{
  for(const type of ['approval','editing','input-cancelled']){
   const f=fixture(t),task=f.ready(f.start(provider)),send=f.followup(task);f.manager.claimNative(send.id);assert.equal(f.check(task,send).submit,true);
   f.manager.nativeEvent({taskId:task.id,instance:task.native.instance,...(type==='input-cancelled'?{actionId:send.id}:{}),type,reason:'Keep this draft and review the permission.'});
   assert.equal(f.check(task,send).submit,false);assert.throws(()=>f.manager.send(task.id,'Overwrite the draft'),/working|permission|draft/);
   const before={state:task.state,error:task.error};f.advance(TERMINAL_DELIVERY_TIMEOUT_MS+1);assert.deepEqual({state:task.state,error:task.error},before);
   assert.equal(f.processes.length,0);
  }
 });

 test(`${provider}: native exit retains the answer and explicit resume creates a new direct ticket`,t=>{
  const f=fixture(t),task=f.ready(f.start(provider)),instance=task.native.instance,firstTicket=task.native.ticket;
  f.manager.accept(task.id,{type:'native-exit',nativeInstance:instance,code:0,ts:100001});
  assert.equal(task.state,'stopped');assert.equal(task.native.ended,true);assert.equal(task.pid,null);assert.equal(f.manager.live.has(task.id),false);assert.equal(task.turns[0].text,'The first saved answer.');
  f.manager.resume(task.id);assert.notEqual(task.native.instance,instance);assert.notEqual(task.native.ticket,firstTicket);assert.equal(f.processes.length,0);
  const next=readNativeTicket(task.native.ticket);assert.match(next.args.at(-1),/^Resume this conversation without using tools/);assert.ok(!next.args.at(-1).includes(task.prompt));
  f.manager.accept(task.id,{type:'native-exit',nativeInstance:instance,code:5});assert.equal(task.state,'starting','Old instance cannot terminate the replacement');
  f.manager.accept(task.id,{type:'native-exit',nativeInstance:task.native.instance,code:5});assert.equal(task.state,'error');assert.match(task.error,/CLI exited/);
 });
}

test('bridge close leaves native Terminal processes alone and still stops web-owned PTYs',t=>{
 const f=fixture(t),native=f.ready(f.start()),web=f.manager.start({selection:{provider:'codex',model:'gpt-6-astra'},prompt:'Web request'});
 assert.equal(f.processes.length,1);assert.equal(f.processes[0].killed,false);
 const before=JSON.stringify(native);f.manager.close();assert.equal(f.processes[0].killed,true);assert.equal(web.state,'stopped');
 assert.equal(JSON.stringify(native),before);assert.equal(f.manager.live.has(native.id),true);assert.equal(f.manager.live.get(native.id).proc,undefined);
 assert.equal(f.manager.pendingNative().actions.some(action=>action.type==='stop'),false);
});

test('restarting the coordinator restores status and claims without relaunching native sessions',t=>{
 const f=fixture(t),task=f.ready(f.start()),send=f.followup(task);f.manager.claimNative(send.id);
 const before=JSON.stringify(task),ticket=fs.readFileSync(task.native.ticket,'utf8');f.manager.close();
 const restored=f.open(),saved=restored.get(task.id);assert.equal(f.processes.length,0);assert.equal(saved.pid,700);assert.equal(saved.native.instance,task.native.instance);
 assert.equal(restored.live.has(task.id),true);assert.equal(restored.pendingNative().actions.length,0);assert.throws(()=>restored.claimNative(send.id),/already claimed/);
 assert.equal(fs.readFileSync(saved.native.ticket,'utf8'),ticket);assert.equal(saved.state,JSON.parse(before).state);
});

test('native process screens and terminal input cannot be proxied through the bridge',t=>{
 const f=fixture(t),task=f.ready(f.start());
 assert.throws(()=>f.manager.input(task.id,'arbitrary input'),/directly/);assert.throws(()=>f.manager.output(task.id),/directly/);assert.throws(()=>f.manager.resize(task.id,80,24),/Obsidian owns/);
 assert.equal(f.processes.length,0);
});

test('same request ID cannot change terminal ownership and provider selections reject the other app',t=>{
 const f=fixture(t),native=f.start(),web=f.manager.start({selection:{provider:'codex',model:'gpt-6-astra'},prompt:'Web request'});
 assert.throws(()=>f.manager.start({id:native.id,selection:{provider:native.provider,model:native.model},prompt:native.prompt}),/already used/);
 assert.throws(()=>f.manager.start({id:web.id,selection:{provider:web.provider,model:web.model},prompt:web.prompt,execution:'native'}),/already used/);
 setCurrent(f.root,f.manager,{scope:'native',provider:'codex',id:native.id});setCurrent(f.root,f.manager,{provider:'codex',id:web.id});
 assert.throws(()=>setCurrent(f.root,f.manager,{scope:'native',provider:'codex',id:web.id}),/different app/);
 assert.throws(()=>setCurrent(f.root,f.manager,{provider:'codex',id:native.id}),/different app/);
 assert.equal(readCurrentState(f.root,'native').codex,native.id);assert.equal(readCurrentState(f.root).codex,web.id);
 assert.equal(taskInScope(native,'native'),true);assert.equal(taskInScope(native,'web'),false);assert.equal(taskInScope(web,'web'),true);
});

test('native Stop before any launch claim cancels the unused ticket without touching a process',t=>{
 const f=fixture(t),task=f.start(),launch=f.action(task,'launch');f.manager.stop(task.id);
 assert.equal(task.state,'stopped');assert.equal(task.native.ended,true);assert.equal(f.manager.live.has(task.id),false);assert.equal(f.manager.pendingNative().actions.length,0);
 assert.throws(()=>f.manager.claimNative(launch.id),/claimed|replaced/);assert.equal(f.processes.length,0);
});

test('native Stop after launch waits for CLI exit and never calls bridge process-kill',t=>{
 const f=fixture(t),task=f.ready(f.start());f.manager.stop(task.id);assert.equal(task.state,'stopping');assert.equal(f.manager.live.has(task.id),true);
 const stop=f.action(task,'stop');assert.ok(stop);f.manager.stop(task.id);assert.equal(task.native.actions.filter(action=>action.type==='stop').length,1);
 assert.equal(f.processes.length,0);f.manager.accept(task.id,{type:'native-exit',nativeInstance:task.native.instance,code:0});assert.equal(task.state,'stopped');assert.equal(f.manager.live.has(task.id),false);
});

test('a reattached native view reports presence for its current instance without replaying launch',t=>{
 const f=fixture(t),task=f.ready(f.start());f.manager.close();const restored=f.open();
 assert.doesNotThrow(()=>restored.nativePresence([{taskId:task.id,instance:task.native.instance,hostPid:600,hasDraft:false}]));
 assert.equal(restored.get(task.id).state,'ready');assert.equal(restored.pendingNative().actions.length,0);assert.equal(f.processes.length,0);
});

test('a view closing after launch claim cannot authorize a duplicate before CLI exit arrives',t=>{
 const f=fixture(t),task=f.start(),launch=f.action(task,'launch');f.manager.claimNative(launch.id);
 f.manager.nativeEvent({taskId:task.id,instance:task.native.instance,type:'closed',reason:'View closed while opening'});
 assert.equal(task.native.ended,false);assert.equal(f.manager.live.has(task.id),true);assert.equal(task.state,'stopping');
 f.manager.accept(task.id,{type:'native-start',nativeInstance:task.native.instance,pid:700});assert.equal(task.pid,700);assert.equal(task.state,'stopping');
 assert.equal(f.processes.length,0);
});

test('verified empty native input returns to ready without any clearing keys',t=>{
 const f=fixture(t),task=f.ready(f.start());f.manager.nativeEvent({taskId:task.id,instance:task.native.instance,type:'editing'});
 assert.throws(()=>f.manager.markReady(task.id),/Confirm/);f.manager.markReady(task.id,{confirmedEmpty:true});
 assert.equal(task.state,'ready');assert.equal(task.error,null);assert.equal(f.processes.length,0);
});

test('native prompt hooks cannot replace a different provider session request identity',t=>{
 const f=fixture(t),task=f.ready(f.start('claude')),snapshot=()=>({sessionId:task.sessionId,artifactRequestKey:task.artifactRequestKey,pendingArtifacts:task.pendingArtifacts,state:task.state}),before=snapshot();
 f.manager.accept(task.id,{type:'UserPromptSubmit',nativeInstance:task.native.instance,sessionId:crypto.randomUUID(),requestKey:crypto.randomUUID(),prompt:'An unrelated session request',ts:100001});
 assert.deepEqual(snapshot(),before);
});

test('expected native shutdown maps signalled and nonzero exits to stopped while unexpected failures stay errors',t=>{
 for(const code of [null,1,137]){
  const f=fixture(t),task=f.ready(f.start());f.manager.stop(task.id);assert.equal(task.state,'stopping');
  f.manager.accept(task.id,{type:'native-exit',nativeInstance:task.native.instance,code,signal:code===null?'SIGTERM':null});
  assert.equal(task.state,'stopped');assert.equal(task.error,null);assert.equal(task.native.ended,true);assert.equal(task.pid,null);assert.equal(f.manager.live.has(task.id),false);
 }
 const f=fixture(t),task=f.ready(f.start());f.manager.accept(task.id,{type:'native-exit',nativeInstance:task.native.instance,code:null,signal:'SIGKILL'});
 assert.equal(task.state,'error');assert.match(task.error,/CLI exited/);
});

test('native presence preserves a human draft and reports completed sessions ready without relaunching',t=>{
 const f=fixture(t),task=f.ready(f.start()),sessions=[{taskId:task.id,instance:task.native.instance,hasDraft:true}];
 const result=f.manager.nativePresence(sessions);assert.deepEqual(result.ready,[{taskId:task.id,instance:task.native.instance}]);
 assert.throws(()=>f.manager.send(task.id,'Overwrite the human draft'),/working|input/);assert.equal(f.manager.pendingNative().actions.length,0);
 f.manager.nativePresence([{...sessions[0],hasDraft:false}]);f.manager.send(task.id,'Now start the follow-up');assert.equal(f.manager.pendingNative().actions.length,1);assert.equal(f.processes.length,0);
});

test('stale native view events are harmless and cannot change a resumed instance',t=>{
 const f=fixture(t),task=f.ready(f.start()),oldInstance=task.native.instance;
 f.manager.accept(task.id,{type:'native-exit',nativeInstance:oldInstance,code:0});f.manager.resume(task.id);const before=JSON.stringify(task);
 for(const type of ['closed','editing','submitted','approval','error','launched'])assert.deepEqual(f.manager.nativeEvent({taskId:task.id,instance:oldInstance,type}),{ok:true,ignored:true});
 assert.equal(JSON.stringify(task),before);assert.equal(f.processes.length,0);
});

test('a lost launch claim is bounded and its provably unused ticket is revoked before offering recovery',async t=>{
 const f=fixture(t),task=f.start(),launch=f.action(task,'launch');f.manager.claimNative(launch.id);
 f.advance(NATIVE_LAUNCH_TIMEOUT_MS-1);assert.equal(task.state,'starting');f.advance(1);
 assert.equal(task.state,'needs input');assert.match(task.error,/unused launch was cancelled/);assert.equal(task.recoveryAvailable,true);
 assert.equal(task.native.ended,true);assert.equal(f.manager.live.has(task.id),false);assert.equal(f.manager.pendingNative().actions.length,0);
 const claim=JSON.parse(fs.readFileSync(task.native.ticket+'.claimed','utf8'));assert.equal(claim.cancelled,true);assert.equal(claim.instance,task.native.instance);
 await assert.rejects(runNativeLaunch(task.native.ticket,{env:{},spawnImpl:()=>assert.fail('A late launcher must not execute the revoked request')}),/already used/);
 assert.equal(f.processes.length,0);const before=JSON.stringify(task);f.advance(NATIVE_PRESENCE_TIMEOUT_MS);assert.equal(JSON.stringify(task),before);
});

test('user Stop revokes a never-consumed launch even after its claim response was sent',async t=>{
 for(const claimed of [false,true]){
  const f=fixture(t),task=f.start(),launch=f.action(task,'launch');if(claimed)f.manager.claimNative(launch.id);
  f.manager.stop(task.id);assert.equal(task.state,'stopped');assert.equal(task.native.launchCancelled,true);assert.equal(task.recoveryAvailable,true);
  await assert.rejects(runNativeLaunch(task.native.ticket,{env:{},spawnImpl:()=>assert.fail('Stopping must revoke a delayed native launch')}),/already used/);
  assert.equal(f.processes.length,0);
 }
});

test('a consumed launch without a PID stays uncertain and cannot be recovered or relaunched automatically',t=>{
 const f=fixture(t),task=f.start(),launch=f.action(task,'launch');f.manager.claimNative(launch.id);
 const claim={taskId:task.id,instance:task.native.instance,launcherPid:91234,ts:100000};fs.writeFileSync(task.native.ticket+'.claimed',JSON.stringify(claim));
 f.advance(NATIVE_LAUNCH_TIMEOUT_MS);assert.equal(task.state,'needs input');assert.match(task.error,/may still be running/);
 assert.equal(task.native.ended,false);assert.equal(task.recoveryAvailable,false);assert.equal(f.manager.live.has(task.id),true);
 assert.equal(f.manager.resume(task.id),task);assert.throws(()=>f.manager.send(task.id,'Repeat the original request'),/may still be running/);
 assert.deepEqual(JSON.parse(fs.readFileSync(task.native.ticket+'.claimed','utf8')),claim);assert.equal(f.processes.length,0);
});

test('missing native launch evidence never makes an unreadable or missing ticket safe to recover',t=>{
 const f=fixture(t),task=f.start(),launch=f.action(task,'launch');f.manager.claimNative(launch.id);fs.unlinkSync(task.native.ticket);
 f.advance(NATIVE_LAUNCH_TIMEOUT_MS);assert.equal(task.state,'needs input');assert.equal(task.recoveryAvailable,false);assert.equal(task.native.ended,false);
 assert.equal(f.manager.live.has(task.id),true);assert.equal(fs.existsSync(task.native.ticket+'.claimed'),false);assert.equal(f.processes.length,0);
});

test('native presence is launch evidence even before a process PID was reported',t=>{
 const f=fixture(t),task=f.start();f.manager.nativePresence([{taskId:task.id,instance:task.native.instance,hostPid:600,hasDraft:false}]);
 f.advance(NATIVE_LAUNCH_TIMEOUT_MS);assert.equal(task.state,'starting');f.advance(NATIVE_PRESENCE_TIMEOUT_MS-NATIVE_LAUNCH_TIMEOUT_MS);
 assert.equal(task.state,'needs input');assert.match(task.error,/not reconnected/);assert.equal(task.recoveryAvailable,false);assert.equal(task.native.ended,false);
 assert.equal(fs.existsSync(task.native.ticket+'.claimed'),false);
});

test('an active native session gets a fresh reconnect grace after bridge restart without launching or killing it',t=>{
 const f=fixture(t),task=f.ready(f.start());f.manager.close();f.advance(600000,null);const restored=f.open(),saved=restored.get(task.id);
 restored.collect();assert.equal(saved.state,'ready');assert.equal(saved.pid,700);assert.equal(restored.live.has(task.id),true);
 f.advance(NATIVE_PRESENCE_TIMEOUT_MS-1,restored);assert.equal(saved.state,'ready');
 restored.nativePresence([{taskId:saved.id,instance:saved.native.instance,hostPid:600,hasDraft:false}]);f.advance(2,restored);
 assert.equal(saved.state,'ready');assert.equal(restored.pendingNative().actions.length,0);assert.equal(f.processes.length,0);
});

test('restart waits for presence before warning and a late matching launch event restores its state',t=>{
 const f=fixture(t),task=f.start(),launch=f.action(task,'launch');f.manager.claimNative(launch.id);
 fs.writeFileSync(task.native.ticket+'.claimed',JSON.stringify({taskId:task.id,instance:task.native.instance,launcherPid:91234}));
 f.manager.close();f.advance(600000,null);const restored=f.open(),saved=restored.get(task.id);
 assert.equal(saved.recoveryAvailable,false,'Restart cannot offer recovery while an unknown native process may still be running');
 f.advance(NATIVE_PRESENCE_TIMEOUT_MS-1,restored);assert.equal(saved.state,'starting');f.advance(1,restored);assert.equal(saved.state,'needs input');
 restored.accept(saved.id,{type:'native-start',nativeInstance:saved.native.instance,pid:700});assert.equal(saved.state,'working');assert.equal(saved.error,null);assert.equal(saved.inputReason,undefined);
 assert.equal(saved.native.connectionWarning,undefined);assert.equal(f.processes.length,0);
});

test('an interrupted save after exclusive launch cancellation can reconcile the same proof after restart',t=>{
 const f=fixture(t),task=f.start();fs.writeFileSync(task.native.ticket+'.claimed',JSON.stringify({taskId:task.id,instance:task.native.instance,cancelled:true,ts:100000}));
 f.manager.close();const restored=f.open(),saved=restored.get(task.id);f.advance(NATIVE_PRESENCE_TIMEOUT_MS,restored);
 assert.equal(saved.native.ended,true);assert.equal(saved.recoveryAvailable,true);assert.equal(saved.state,'needs input');assert.equal(f.processes.length,0);
});

test('a failed launch delivery can offer recovery only after cancelling its still-unused ticket',t=>{
 const f=fixture(t),task=f.start(),launch=f.action(task,'launch');f.manager.claimNative(launch.id);
 f.manager.nativeEvent({taskId:task.id,instance:task.native.instance,actionId:launch.id,type:'error',reason:'The launch reply was lost.'});
 assert.equal(task.state,'needs input');assert.equal(task.native.presenceConfirmed,undefined);
 f.advance(NATIVE_LAUNCH_TIMEOUT_MS);assert.equal(task.recoveryAvailable,true);assert.equal(task.native.launchCancelled,true);assert.match(task.error,/unused launch/);
});

test('native presence, reconnect warnings, keep changes, stop and process exit never renew conversational activity',t=>{
 const f=fixture(t),task=f.ready(f.start()),activity=task.conversationActivityAt;
 f.advance(NATIVE_PRESENCE_TIMEOUT_MS);assert.equal(task.state,'needs input');assert.equal(task.conversationActivityAt,activity);
 f.manager.nativePresence([{taskId:task.id,instance:task.native.instance,hasDraft:false}]);assert.equal(task.state,'ready');assert.equal(task.conversationActivityAt,activity);
 for(const act of [()=>f.manager.nativePresence([{taskId:task.id,instance:task.native.instance,hasDraft:false}]),()=>f.manager.list(),()=>f.manager.setKeep(task.id,true),()=>f.manager.setKeep(task.id,false),()=>f.manager.nativeEvent({taskId:task.id,instance:task.native.instance,type:'approval',reason:'Review permission'}),()=>f.manager.stop(task.id),()=>f.manager.accept(task.id,{type:'native-exit',nativeInstance:task.native.instance,code:0})]){
  f.advance(1000);act();assert.equal(task.conversationActivityAt,activity);
 }
 assert.equal(task.state,'stopped');assert.ok(task.lastActivityAt>activity);assert.equal(f.processes.length,0);
});

test('native coordinator restart preserves existing and legacy meaningful timestamps independently of reconnect presence',t=>{
 for(const legacy of [false,true]){
  const f=fixture(t),task=f.ready(f.start()),activity=task.conversationActivityAt;
  if(legacy){delete task.conversationActivityAt;f.manager.save(task)}
  f.manager.close();f.advance(600000,null);const restored=f.open(),saved=restored.get(task.id);
  assert.equal(saved.conversationActivityAt,activity);assert.equal(saved.state,'ready');assert.equal(f.processes.length,0);
  restored.nativePresence([{taskId:saved.id,instance:saved.native.instance,hasDraft:false}]);
  assert.equal(saved.native.lastSeen,f.now());assert.equal(saved.conversationActivityAt,activity);
 }
});

for(const provider of ['codex','claude'])test(`${provider}: native launch, send, editing, submitted prompt and completed answer renew conversation activity`,t=>{
 const f=fixture(t),task=f.start(provider);assert.equal(task.conversationActivityAt,f.now());
 f.advance(1000);f.launched(task);assert.equal(task.conversationActivityAt,f.now());
 const sessionId=crypto.randomUUID(),complete=()=>({type:provider==='codex'?'complete':'Stop',sessionId,nativeInstance:task.native.instance,turnId:crypto.randomUUID(),text:'A completed answer',ts:f.now()});
 f.advance(1000);f.manager.accept(task.id,complete());assert.equal(task.conversationActivityAt,f.now());
 f.advance(1000);const send=f.followup(task);assert.equal(task.conversationActivityAt,f.now());f.manager.claimNative(send.id);
 for(const type of ['input-written','editing','submitted']){
  f.advance(1000);f.manager.nativeEvent({taskId:task.id,instance:task.native.instance,type,...(type==='input-written'?{actionId:send.id}:{})});assert.equal(task.conversationActivityAt,f.now());
 }
 f.advance(1000);f.manager.accept(task.id,{type:'UserPromptSubmit',nativeInstance:task.native.instance,sessionId,requestKey:crypto.randomUUID(),prompt:'A typed follow-up',ts:f.now()});assert.equal(task.conversationActivityAt,f.now());
 f.advance(1000);const answer=complete();f.manager.accept(task.id,answer);assert.equal(task.conversationActivityAt,f.now());
 const activity=task.conversationActivityAt;f.advance(1000);f.manager.accept(task.id,answer);assert.equal(task.conversationActivityAt,activity);
 assert.equal(f.processes.length,0);
});

for(const provider of ['codex','claude'])test(`${provider}: a promised open on a native follow-up survives to the file the worker produces`,t=>{
 const f=fixture(t),task=f.ready(f.start(provider));
 fs.writeFileSync(path.join(f.root,'result.md'),'# Revised document\n');
 f.manager.send(task.id,'Create the revised document and open it when done.',{spoken:true,openWhenDone:true});
 assert.equal(task.openWhenDone,true);
 const send=f.action(task,'send');
 assert.equal(f.check(task,send).submit,false);
 f.manager.claimNative(send.id);assert.equal(f.check(task,send).submit,true);
 f.manager.nativeEvent({taskId:task.id,instance:task.native.instance,actionId:send.id,type:'input-written'});
 assert.equal(f.check(task,send).submit,false);
 if(provider==='claude')f.manager.accept(task.id,{type:'UserPromptSubmit',sessionId:task.sessionId,nativeInstance:task.native.instance,requestKey:send.requestKey,prompt:send.text,ts:f.now()});
 else {f.watches.at(-1).poll=()=>true;f.manager.collect(task.id)}
 assert.equal(f.manager.live.get(task.id).pendingDelivery,null);
 assert.equal(task.openWhenDone,true);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.manager.folder(task.id),'session.json'),'utf8')).openWhenDone,true);
 f.manager.accept(task.id,{type:provider==='codex'?'complete':'Stop',sessionId:task.sessionId,nativeInstance:task.native.instance,turnId:crypto.randomUUID(),text:'Saved: [Report](result.md)',ts:f.now()});
 const artifact=task.turns.at(-1).artifacts?.[0];
 assert.ok(artifact,'the follow-up turn recorded the linked file');assert.equal(artifact.open,true);assert.equal(artifact.mime,'text/markdown');assert.equal(task.openWhenDone,undefined);
});

for(const provider of ['codex','claude'])test(`${provider}: the production manager forwards a promised open for a non-native conversation too`,t=>{
 const f=fixture(t),done=provider==='codex'?'complete':'Stop';
 const task=f.manager.start({selection:{provider,model:provider==='codex'?'gpt-6-astra':'sonnet'},prompt:'Initial request',spoken:true});
 f.manager.accept(task.id,{type:done,sessionId:crypto.randomUUID(),turnId:'first',text:'Ready.'});
 fs.writeFileSync(path.join(f.root,'web-result.md'),'# Revised document\n');
 f.manager.send(task.id,'Create the revised document and open it when done.',{spoken:true,openWhenDone:true});
 assert.equal(task.openWhenDone,true);
 // The follow-up was pasted into the PTY; the fixture's inert defer means Enter is not exercised here.
 assert.ok(f.processes.at(-1).writes.some(w=>w.includes('Create the revised document and open it when done.')),'the follow-up reached the PTY');
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.manager.folder(task.id),'session.json'),'utf8')).openWhenDone,true);
 f.manager.accept(task.id,{type:done,sessionId:task.sessionId,turnId:'second',text:'Saved: [Report](web-result.md)'});
 assert.equal(task.turns.at(-1).artifacts[0].open,true);assert.equal(task.openWhenDone,undefined);
});
