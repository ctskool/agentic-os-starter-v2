import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';
import {TerminalManager,TERMINAL_PASTE_SETTLE_MS,TERMINAL_DELIVERY_TIMEOUT_MS} from '../runner/terminals.mjs';
import {createCodexDeliveryWatch} from '../runner/terminal-delivery.mjs';
const session='01a09b1a-fb81-7433-a9d7-d8333de6cbe0';
const receipt=text=>JSON.stringify({type:'event_msg',payload:{type:'user_message',message:text}})+'\n';
function fixture(t,provider='codex'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-submit-')),home=path.join(root,'codex');let time=100000;
 const created=Number.parseInt(session.replaceAll('-','').slice(0,12),16),folder=path.join(home,'sessions',new Date(created).toISOString().slice(0,10).replaceAll('-',path.sep));
 fs.mkdirSync(folder,{recursive:true});const transcript=path.join(folder,`rollout-fixture-${session}.jsonl`);fs.writeFileSync(transcript,'');
 const timers=[],processes=[],manager=new TerminalManager(root,{directory:path.join(root,'work'),now:()=>time,schedule:()=>({unref(){}}),cancelSchedule(){},
  deliveryWatch:(id,text)=>createCodexDeliveryWatch(id,text,{home}),
  defer:(fn,delay)=>{const timer={fn,at:time+delay,canceled:false,unref(){}};timers.push(timer);return timer},cancelDeferred:timer=>timer.canceled=true,
  spawn:()=>{const proc={pid:500+processes.length,writes:[],write(text){this.writes.push(text)},onData(fn){this.data=fn},onExit(fn){this.exit=fn},resize(){},kill(){}};processes.push(proc);return proc},
 });
 const task=manager.start({selection:{provider,model:provider==='codex'?'gpt-6-astra':'sonnet'},prompt:'Initial request'});
 manager.accept(task.id,{type:provider==='codex'?'complete':'Stop',sessionId:session,turnId:'initial',text:'Ready.'});
 t.after(()=>{manager.close();fs.rmSync(root,{recursive:true,force:true})});
 return {manager,task,processes,transcript,timers,now:()=>time,
  advance(ms){time+=ms;for(const timer of timers)if(!timer.canceled&&timer.at<=time){timer.canceled=true;timer.fn()}manager.collect(task.id)},
  append(text){fs.appendFileSync(transcript,text)},
  pending(){return manager.live.get(task.id)?.pendingDelivery},
 };
}
test('receipt-confirmed delivery distinguishes accepted work from a successful PTY write',t=>{
 const f=fixture(t);f.manager.send(f.task.id,'Change the robot.\nKeep the labels.');const pending=f.pending(),proc=f.processes[0];
 f.advance(TERMINAL_PASTE_SETTLE_MS-1);assert.equal(proc.writes.length,1);
 f.advance(1);assert.deepEqual(proc.writes.slice(1),['\r']);assert.equal(f.pending(),pending);
 f.append(JSON.stringify({type:'event_msg',payload:{type:'task_started'}})+'\n'+receipt('Different request'));f.manager.collect();assert.equal(f.pending(),pending);
 f.append(receipt(pending.text));f.manager.collect();assert.equal(f.pending(),null);assert.equal(f.task.state,'working');
 f.advance(TERMINAL_DELIVERY_TIMEOUT_MS);assert.equal(f.task.error,null);assert.deepEqual(proc.writes.slice(1),['\r']);
});
test('missing receipt becomes visible once, never retries, and a later manual submit can recover',t=>{
 const f=fixture(t);f.manager.send(f.task.id,'Change the robot');const pending=f.pending(),proc=f.processes[0];
 f.advance(TERMINAL_DELIVERY_TIMEOUT_MS-1);assert.equal(f.task.state,'working');
 f.advance(1);assert.equal(f.task.state,'needs input');assert.match(f.task.error,/hasn't confirmed/);assert.equal(f.pending(),pending);
 const warning=f.task.error;f.advance(30000);assert.equal(f.task.error,warning);assert.deepEqual(proc.writes.slice(1),['\r']);
 assert.throws(()=>f.manager.send(f.task.id,'Duplicate request'),/hasn't confirmed/);
 f.manager.input(f.task.id,'\r');f.append(receipt(pending.text));f.manager.collect();assert.equal(f.pending(),null);assert.equal(f.task.state,'working');assert.equal(f.task.error,null);
 assert.deepEqual(proc.writes.slice(1),['\r','\r']);
});
test('a matching receipt before the scheduled Enter cancels it instead of submitting twice',t=>{
 const f=fixture(t);f.manager.send(f.task.id,'Already submitted');f.append(receipt(f.pending().text));f.advance(TERMINAL_PASTE_SETTLE_MS);
 assert.equal(f.pending(),null);assert.equal(f.processes[0].writes.length,1);
});
test('approval appearing between paste and Enter remains unanswered and is not overwritten by timeout',t=>{
 const f=fixture(t);f.manager.send(f.task.id,'Change the robot');
 f.processes[0].data('Would you like to make the following edits?\r\n› 1. Approve\r\n  2. Reject\r\nPress enter to confirm');
 assert.equal(f.task.state,'needs input');const warning=f.task.error;f.advance(TERMINAL_DELIVERY_TIMEOUT_MS);
 assert.equal(f.processes[0].writes.length,1);assert.equal(f.task.error,warning);assert.match(warning,/approval/);
});
test('human editing, stop, and replaced process each cancel the one scheduled Enter',t=>{
 for(const action of ['editing','stop','replacement']){
  const f=fixture(t);f.manager.send(f.task.id,'Follow up');const proc=f.processes[0];
  if(action==='editing')f.manager.input(f.task.id,' extra detail');
  else if(action==='stop')f.manager.stop(f.task.id);
  else {f.manager.stop(f.task.id);f.manager.resume(f.task.id)}
  f.advance(TERMINAL_PASTE_SETTLE_MS);assert.ok(!proc.writes.includes('\r'));
  if(action==='editing'){assert.ok(f.manager.live.get(f.task.id).inputBoundary.hasDraft);assert.equal(f.pending(),null);f.advance(TERMINAL_DELIVERY_TIMEOUT_MS);assert.equal(f.task.state,'editing');assert.equal(f.task.error,null)}
 }
});
test('automatic cursor, device and color replies preserve the pending Enter and do not make a draft',t=>{
 const f=fixture(t);f.manager.send(f.task.id,'Edit the image');const pending=f.pending();
 for(const reply of ['\x1b[12;34R','\x1b[?1;2c','\x1b[>0;276;0c','\x1b]10;rgb:ffff/ffff/ffff\x07','\x1b]11;rgb:0000/0000/0000\x1b\\']){f.manager.input(f.task.id,reply);assert.equal(f.pending(),pending)}
 f.advance(TERMINAL_PASTE_SETTLE_MS);assert.equal(f.processes[0].writes.at(-1),'\r');
 f.append(receipt(pending.text));f.manager.collect();assert.equal(f.pending(),null);assert.equal(f.manager.live.get(f.task.id).inputBoundary.hasDraft,false);
});
test('same-worded requests need fresh exact receipts and cannot reuse the previous turn',t=>{
 const f=fixture(t);f.manager.send(f.task.id,'Show it');const first=f.pending().text;f.append(receipt(first));f.advance(TERMINAL_PASTE_SETTLE_MS);
 f.manager.accept(f.task.id,{type:'complete',turnId:'first',text:'Done.'});f.manager.send(f.task.id,'Show it');const second=f.pending().text;
 assert.notEqual(first,second);f.append(receipt(first));f.manager.collect();assert.ok(f.pending());
 f.append(receipt(second));f.manager.collect();assert.equal(f.pending(),null);
});
test('completed turn cancels an unsent scheduled Enter without suppressing its answer',t=>{
 const f=fixture(t);f.manager.send(f.task.id,'Follow up');f.manager.accept(f.task.id,{type:'complete',turnId:'done',text:'Done.'});f.advance(TERMINAL_PASTE_SETTLE_MS);
 assert.equal(f.task.state,'ready');assert.equal(f.task.turns.at(-1).text,'Done.');assert.equal(f.pending(),null);assert.equal(f.processes[0].writes.length,1);
});
test('Claude confirms only the exact current request hook, ignores stale hooks and preserves approval gates',t=>{
 const f=fixture(t,'claude');f.manager.send(f.task.id,'Update the graphic');const pending=f.pending();
 const event={type:'UserPromptSubmit',sessionId:session,requestKey:pending.key,prompt:pending.text,ts:f.now()};
 for(const changed of [{prompt:'Other request'},{requestKey:crypto.randomUUID()},{ts:f.now()-1}]){f.manager.accept(f.task.id,{...event,...changed});assert.equal(f.pending(),pending)}
 f.manager.accept(f.task.id,event);f.advance(TERMINAL_DELIVERY_TIMEOUT_MS);assert.equal(f.pending(),null);assert.equal(f.task.state,'working');assert.equal(f.processes[0].writes.length,1);
});
test('Claude queued approval events cancel Enter before it reaches the CLI',t=>{
 const f=fixture(t,'claude');f.manager.send(f.task.id,'Update it');const file=path.join(f.manager.folder(f.task.id),'events','approval.json');
 fs.writeFileSync(file,JSON.stringify({type:'PermissionRequest',sessionId:session,ts:f.now()}));f.advance(TERMINAL_PASTE_SETTLE_MS);
 assert.equal(f.processes[0].writes.length,1);assert.equal(f.task.state,'needs input');assert.match(f.task.error,/approval/);
});
for(const provider of ['codex','claude'])test(`${provider} manual editing preserves the pasted helper identity; fresh typed turns rotate it`,t=>{
 const f=fixture(t,provider);f.manager.send(f.task.id,'Edit the robot');const pending=f.pending(),key=pending.key;
 assert.ok(pending.text.includes(key));f.manager.input(f.task.id,' Keep the background.');assert.equal(f.pending(),null);assert.equal(f.task.state,'editing');
 f.manager.input(f.task.id,'\r');assert.equal(f.task.artifactRequestKey,key);assert.equal(f.manager.live.get(f.task.id).draftRequestKey,null);
 for(const folder of [path.join(f.manager.folder(f.task.id),'events'),f.manager.artifactOutbox(f.task.id)])assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'active-request.meta'),'utf8')).requestKey,key);
 f.manager.accept(f.task.id,{type:'artifact',taskId:f.task.id,requestKey:key,path:'outputs/final.png',ts:f.now()});assert.equal(f.task.pendingArtifacts.at(-1).requestKey,key);
 f.manager.accept(f.task.id,{type:provider==='codex'?'complete':'Stop',turnId:'edited',text:'The edited graphic is ready.'});
 f.manager.input(f.task.id,'A fresh typed task');f.manager.input(f.task.id,'\r');assert.notEqual(f.task.artifactRequestKey,key);
});
test('receipt already appended before manual input makes that input the next draft with a fresh identity',t=>{
 const f=fixture(t);f.manager.send(f.task.id,'First request');const pending=f.pending();f.append(receipt(pending.text));
 f.manager.input(f.task.id,'The next typed request');assert.equal(f.pending(),null);assert.equal(f.manager.live.get(f.task.id).draftRequestKey,null);
 f.manager.accept(f.task.id,{type:'complete',turnId:'first-done',text:'Done.'});assert.equal(f.task.state,'editing');f.manager.input(f.task.id,'\r');assert.notEqual(f.task.artifactRequestKey,pending.key);
});
test('confirmed empty composer clears managed draft identity before new manual input',t=>{
 const f=fixture(t);f.manager.send(f.task.id,'First request');const key=f.pending().key;f.manager.input(f.task.id,'Edited');
 assert.equal(f.manager.live.get(f.task.id).draftRequestKey,key);f.manager.markReady(f.task.id,{confirmedEmpty:true});assert.equal(f.manager.live.get(f.task.id).draftRequestKey,null);
 f.manager.input(f.task.id,'New request\r');assert.notEqual(f.task.artifactRequestKey,key);
});
