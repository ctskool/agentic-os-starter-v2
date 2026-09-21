import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {build} from 'esbuild';
import {TerminalManager,terminalIdleStopMs,IDLE_STOP_MS,IDLE_SWEEP_MS,QUIET_BEFORE_CLOSE_MS} from '../runner/terminals.mjs';
import {NativeTerminalManager} from '../runner/native-terminals.mjs';
import {taskSummary} from '../shared/work-feed.mjs';

const presentation=await build({entryPoints:['shared/work-presentation.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {taskStatus,isOpenWork}=await import('data:text/javascript;base64,'+Buffer.from(presentation.outputFiles[0].text).toString('base64'));

const MIN=60*1000;
function bench(t,{Manager=TerminalManager,...options}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-idle-close-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const clock={now:1_000_000},timers=[],deferred=[],processes=[],proof={submitted:false};
 const schedule=(fn,ms)=>{const timer={fn,ms,cancelled:false,unref(){}};timers.push(timer);return timer};
 const spawn=(command,args)=>{const proc={pid:20000+processes.length,command,args,writes:[],onData(fn){this.data=fn},onExit(fn){this.exit=fn},write(text){this.writes.push(text)},resize(){},kill(){this.killed=true}};processes.push(proc);return proc};
 const manager=new Manager(root,{directory:path.join(root,'sessions'),spawn,now:()=>clock.now,schedule,cancelSchedule:timer=>{if(timer)timer.cancelled=true},
  defer:(fn,ms)=>{const timer={fn,ms,cancelled:false,unref(){}};deferred.push(timer);return timer},cancelDeferred:timer=>{if(timer)timer.cancelled=true},
  // The Codex delivery watcher: "was this exact text found in the session?"
  deliveryWatch:()=>({poll:()=>proof.submitted,close(){}}),...options});
 // A terminal that finished its first turn: ready at its prompt, with a saved session. Nobody has typed in it.
 const ready=(provider='codex',fields={})=>{
  const task=manager.start({selection:{provider,model:provider==='codex'?'gpt-6-astra':'sonnet'},prompt:'Do the work.',...fields});
  manager.accept(task.id,{type:provider==='codex'?'complete':'Stop',sessionId:crypto.randomUUID(),turnId:'first',text:'Done.',ts:clock.now});
  assert.equal(manager.get(task.id).state,'ready');return manager.get(task.id);
 };
 const done=(task,turnId)=>manager.accept(task.id,{type:task.provider==='codex'?'complete':'Stop',sessionId:manager.get(task.id).sessionId,turnId,text:'Answer.',ts:clock.now});
 const runDeferred=()=>{for(const timer of deferred.splice(0))if(!timer.cancelled)timer.fn()};
 return {root,clock,timers,processes,proof,manager,ready,done,runDeferred};
}
const refused=error=>error.code==='TERMINAL_NOT_IDLE'&&/no longer idle/.test(error.message);

test('a finished terminal nobody typed in is closed after 30 quiet minutes, not before; its conversation stays resumable',t=>{
 const b=bench(t),task=b.ready(),live=b.manager.live.get(task.id);
 assert.equal(b.manager.idleStopMs,IDLE_STOP_MS);
 b.clock.now+=29*MIN;assert.deepEqual(b.manager.sweepIdle(),[]);assert.equal(b.manager.live.has(task.id),true);
 b.clock.now+=MIN;assert.deepEqual(b.manager.sweepIdle(),[task.id]);
 const record=b.manager.get(task.id);
 assert.equal(record.state,'stopped');assert.equal(b.manager.live.has(task.id),false);assert.equal(live.proc.killed,true);assert.ok(record.sessionId,'the saved session is what makes it resumable');
 assert.equal(record.idleStoppedAt,b.clock.now);
 const summary=taskSummary(b.manager.list().find(item=>item.id===task.id));
 assert.equal(summary.idleStoppedAt,b.clock.now);assert.equal(taskStatus(summary),'Closed (idle)');assert.equal(isOpenWork(summary),false);
 assert.deepEqual(b.manager.sweepIdle(),[],'nothing left to close');
 // A follow-up reopens it (the existing resume path) and the idle marker goes.
 b.manager.send(task.id,'One more thing.',{resumeStopped:true});
 assert.equal(b.manager.live.has(task.id),true);assert.equal(b.manager.get(task.id).idleStoppedAt,undefined);
 assert.equal(taskStatus(taskSummary(b.manager.list().find(item=>item.id===task.id))),'Working');
});

test('only the sweep labels a close as idle; an ordinary Stop never does, and the label needs a closed terminal',t=>{
 const b=bench(t),task=b.ready();b.manager.get(task.id).idleStoppedAt=123;b.manager.stop(task.id);
 assert.equal(b.manager.get(task.id).idleStoppedAt,undefined);assert.equal(taskStatus(taskSummary(b.manager.list().find(item=>item.id===task.id))),'Closed');
 assert.equal(taskStatus({state:'ready',idleStoppedAt:5}),'Ready');assert.equal(taskSummary({...b.manager.get(task.id),state:'error',idleStoppedAt:5}).idleStoppedAt,undefined);
 // The production manager keeps the label.
 const c=bench(t,{Manager:NativeTerminalManager}),other=c.ready();c.clock.now+=31*MIN;
 assert.deepEqual(c.manager.sweepIdle(),[other.id]);assert.equal(taskStatus(taskSummary(c.manager.list().find(item=>item.id===other.id))),'Closed (idle)');
});

test('nothing that is busy, unfinished, unsaved, foreign or in flight is ever closed',t=>{
 const b=bench(t),m=b.manager;
 const working=m.start({selection:{provider:'codex',model:'gpt-6-astra'},prompt:'Still working.'});
 const unsaved=m.start({selection:{provider:'claude',model:'sonnet'},prompt:'No session yet.'});m.get(unsaved.id).state='ready';
 const approval=b.ready();m.get(approval.id).state='needs input';
 const stopping=b.ready();m.get(stopping.id).state='stopping';
 const editing=b.ready();m.get(editing.id).state='editing';
 const exited=b.ready();m.live.get(exited.id).exitObserved=true;
 const native=b.ready();m.live.get(native.id).native=true;
 const nativeRecord=b.ready();m.get(nativeRecord.id).execution='native';
 const script=b.ready();m.get(script.id).execution='script';
 const headless=b.ready();m.get(headless.id).execution='headless';
 const delivery=b.ready();m.live.get(delivery.id).pendingDelivery={key:'k'};
 const managedDraft=b.ready();m.live.get(managedDraft.id).draftRequestKey='k';
 const routingDraft=b.ready();m.live.get(routingDraft.id).inputBoundary.update('half a sentence');
 const pasting=b.ready();m.live.get(pasting.id).inputBoundary.update('\x1b[200~pasted');
 const arriving=b.ready();m.live.get(arriving.id).inputBoundary.update('\x1b[20');
 const noClock=b.ready();m.get(noClock.id).lastActivityAt=undefined;
 const idle=b.ready();
 b.clock.now+=45*MIN;
 assert.deepEqual(m.sweepIdle(),[idle.id],'only the genuinely idle one');
 for(const [name,task] of Object.entries({working,unsaved,approval,stopping,editing,exited,native,nativeRecord,script,headless,delivery,managedDraft,routingDraft,pasting,arriving,noClock})){
  assert.equal(m.live.has(task.id),true,name+' is still running');assert.equal(m.get(task.id).idleStoppedAt,undefined,name);
 }
});

test('what the input box holds is never guessed: once the user typed ANYTHING, the terminal is not closed for them',t=>{
 // Every one of these was, or could be, a way to leave unsent text that keystroke tracking would miss.
 const keys={text:'half a sentence',arrowRecall:'\x1b[A',tab:'\t',altEnter:'draft\x1b\r',yank:'\x19',plainEnter:'\r',aWholeTurn:'question\r',pasteWithNewline:'\x1b[200~line one\rline two\x1b[201~',submitThenMore:'A\rnew draft'};
 for(const [name,data] of Object.entries(keys)){
  const b=bench(t),task=b.ready(name==='aWholeTurn'?'claude':'codex'),m=b.manager;
  b.clock.now+=QUIET_BEFORE_CLOSE_MS;m.input(task.id,data);
  // Whatever the CLI reports afterwards (hooks, completions, late or not) changes nothing about that.
  m.accept(task.id,{type:'UserPromptSubmit',ts:b.clock.now+5,prompt:'question'});b.done(task,'after-'+name);
  assert.equal(m.live.get(task.id).userTyped,true,name);
  b.clock.now+=180*MIN;assert.deepEqual(m.sweepIdle(),[],name);assert.throws(()=>m.stopIfIdle(task.id),refused,name);assert.equal(m.live.has(task.id),true,name);
 }
 // Terminal reports are not typing, and the user confirming an empty input box makes it closable again.
 const b=bench(t),task=b.ready(),m=b.manager;m.input(task.id,'\x1b[I');assert.equal(m.live.get(task.id).userTyped,false,'a focus report is not a keystroke');
 m.input(task.id,'x');assert.equal(m.live.get(task.id).userTyped,true);m.markReady(task.id,{confirmedEmpty:true});assert.equal(m.live.get(task.id).userTyped,false);
 b.clock.now+=31*MIN;assert.deepEqual(m.sweepIdle(),[task.id]);
});

test('a follow-up the bridge pasted is unsent text until there is PROOF it was submitted (Codex: found in the session)',t=>{
 const b=bench(t),task=b.ready('codex'),m=b.manager,live=m.live.get(task.id);
 m.send(task.id,'a voice follow-up');assert.equal(live.unsentPaste,true);
 b.runDeferred();assert.equal(live.proc.writes.at(-1),'\r');assert.equal(live.unsentPaste,true,'pressing Enter is not proof');
 b.proof.submitted=true;m.collect(task.id);assert.equal(live.unsentPaste,false,'the delivery watcher found it');
 b.done(task,'follow-up');assert.equal(m.get(task.id).state,'ready');
 b.clock.now+=QUIET_BEFORE_CLOSE_MS;assert.equal(m.stopIfIdle(task.id).state,'stopped','a voice-driven terminal closes in one click');
 // No proof: a completion of ANOTHER turn ends the delivery and cancels the Enter. The text is still in the input box.
 const c=bench(t),other=c.ready('codex'),n=c.manager,otherLive=n.live.get(other.id);
 n.send(other.id,'follow-up C');c.done(other,'some-other-turn');c.runDeferred();
 assert.equal(otherLive.proc.writes.at(-1)==='\r',false,'no Enter was pressed for C');assert.equal(n.get(other.id).state,'ready','routing state is what it always was');
 assert.equal(otherLive.unsentPaste,true);
 c.clock.now+=180*MIN;assert.deepEqual(n.sweepIdle(),[]);assert.throws(()=>n.stopIfIdle(other.id),refused);assert.equal(n.live.has(other.id),true);
});

test('for Claude the proof is the prompt-submitted hook that matches the delivery; any other hook is not',t=>{
 const b=bench(t),task=b.ready('claude'),m=b.manager,live=m.live.get(task.id);
 m.send(task.id,'a voice follow-up');const pending=live.pendingDelivery;assert.ok(pending);
 m.accept(task.id,{type:'UserPromptSubmit',ts:b.clock.now+1,requestKey:'someone-else',prompt:'unrelated'});assert.equal(live.unsentPaste,true);
 m.accept(task.id,{type:'UserPromptSubmit',ts:b.clock.now+1,requestKey:pending.key,prompt:pending.text});assert.equal(live.unsentPaste,false);
 b.done(task,'follow-up');b.clock.now+=31*MIN;assert.deepEqual(m.sweepIdle(),[task.id]);
});

test('a terminal whose screen is still changing is not idle, whatever its state says',t=>{
 const b=bench(t),task=b.ready(),m=b.manager,live=m.live.get(task.id);
 // Work the state machine cannot see (a turn queued behind another): the screen keeps changing for 40 minutes.
 for(let i=0;i<40;i++){b.clock.now+=MIN;live.proc.data('working...');assert.throws(()=>m.stopIfIdle(task.id),refused);assert.deepEqual(m.sweepIdle(),[])}
 assert.equal(m.live.has(task.id),true);
 b.clock.now+=QUIET_BEFORE_CLOSE_MS-1;assert.throws(()=>m.stopIfIdle(task.id),refused);
 b.clock.now+=25*MIN;assert.deepEqual(m.sweepIdle(),[],'25 quiet minutes are not 30');
 b.clock.now+=6*MIN;assert.deepEqual(m.sweepIdle(),[task.id]);
});

test('a one-click close is decided by the bridge when the request arrives, with queued hooks consumed first',t=>{
 const b=bench(t),m=b.manager,idle=b.ready(),closed=b.ready(),late=b.ready();m.stop(closed.id);b.clock.now+=QUIET_BEFORE_CLOSE_MS;
 assert.equal(m.stopIfIdle(idle.id).state,'stopped');assert.equal(m.stopIfIdle(closed.id).state,'stopped','not running: a plain stop');
 const collect=m.collect.bind(m);m.collect=id=>{if(id===late.id)m.get(late.id).state='needs input';return collect(id)};
 assert.throws(()=>m.stopIfIdle(late.id),refused);assert.equal(m.live.has(late.id),true);
});

test('activity restarts the clock, and no terminal is closed while the bridge is handling a voice request',t=>{
 let voice=false;const b=bench(t,{voiceBusy:()=>voice}),task=b.ready();
 b.clock.now+=29*MIN;b.manager.markReady(task.id,{confirmedEmpty:true});
 b.clock.now+=29*MIN;assert.deepEqual(b.manager.sweepIdle(),[],'29 minutes after the last activity');
 b.clock.now+=2*MIN;voice=true;assert.deepEqual(b.manager.sweepIdle(),[],'a follow-up may be on its way');assert.equal(b.manager.live.has(task.id),true);
 voice=false;assert.deepEqual(b.manager.sweepIdle(),[task.id]);
 // A broken busy check fails safe: nothing is closed.
 const c=bench(t,{voiceBusy:()=>{throw new Error('broken')}}),other=c.ready();c.clock.now+=60*MIN;assert.deepEqual(c.manager.sweepIdle(),[]);assert.equal(c.manager.live.has(other.id),true);
});

test('queued hooks are consumed before deciding, and one failing terminal does not stop the sweep',t=>{
 const b=bench(t),first=b.ready(),second=b.ready(),third=b.ready();
 const collect=b.manager.collect.bind(b.manager),stop=b.manager.stop.bind(b.manager),collected=[];
 b.manager.collect=id=>{collected.push(id);if(id===first.id)b.manager.get(first.id).state='needs input';return collect(id)};
 b.manager.stop=(id,options)=>{if(id===second.id)throw new Error('cleanup failed');return stop(id,options)};
 b.clock.now+=31*MIN;
 assert.deepEqual(b.manager.sweepIdle(),[third.id]);assert.ok(collected.includes(first.id));
 assert.equal(b.manager.live.has(first.id),true);assert.equal(b.manager.get(first.id).idleStoppedAt,undefined);
 assert.equal(b.manager.live.has(second.id),true);assert.equal(b.manager.get(second.id).idleStoppedAt,undefined,'a failed close is not labelled idle');
});

test('routing state is untouched by this feature: an empty Enter before a completion is collected still ends in Ready',t=>{
 const b=bench(t),task=b.ready('codex'),m=b.manager;
 m.input(task.id,'question\r');assert.equal(m.get(task.id).state,'working');const finished=b.clock.now+2000;
 b.clock.now+=3000;m.input(task.id,'\r');
 m.accept(task.id,{type:'complete',sessionId:m.get(task.id).sessionId,turnId:'q',text:'Answer.',ts:finished});
 assert.equal(m.get(task.id).state,'ready','as before this feature');
 m.input(task.id,'\x1b[A');assert.equal(m.get(task.id).state,'ready','recall keys do not change routing state, as before');
});

test('the setting: 30 minutes by default, minutes from the environment, 0 or off disables it',t=>{
 assert.equal(terminalIdleStopMs({}),30*MIN);assert.equal(terminalIdleStopMs({AOS_V2_TERMINAL_IDLE_MINUTES:'45'}),45*MIN);assert.equal(terminalIdleStopMs({AOS_V2_TERMINAL_IDLE_MINUTES:'2.5'}),150000);
 for(const off of ['0','off','OFF',' off '])assert.equal(terminalIdleStopMs({AOS_V2_TERMINAL_IDLE_MINUTES:off}),0,off);
 for(const bad of ['soon','-5','NaN'])assert.equal(terminalIdleStopMs({AOS_V2_TERMINAL_IDLE_MINUTES:bad}),30*MIN,bad);
 const b=bench(t,{idleStopMs:0}),task=b.ready();b.clock.now+=600*MIN;
 assert.deepEqual(b.manager.sweepIdle(),[]);assert.equal(b.manager.live.has(task.id),true);assert.equal(b.timers.some(timer=>timer.ms===IDLE_SWEEP_MS),false,'no timer when it is off');
});

test('the idle timer runs every minute and is cancelled by close() in both managers; a closed manager sweeps nothing',t=>{
 for(const Manager of [TerminalManager,NativeTerminalManager]){
  const b=bench(t,{Manager}),timer=b.timers.find(item=>item.ms===IDLE_SWEEP_MS);
  assert.ok(timer,Manager.name+' registers the sweep');assert.equal(timer.cancelled,false);
  const task=b.ready();b.clock.now+=31*MIN;
  b.manager.close();assert.equal(timer.cancelled,true,Manager.name+' cancels it');
  assert.deepEqual(b.manager.sweepIdle(),[]);assert.equal(b.manager.get(task.id).idleStoppedAt,undefined);
 }
 const b=bench(t),task=b.ready();b.clock.now+=31*MIN;b.timers.find(item=>item.ms===IDLE_SWEEP_MS).fn();assert.equal(b.manager.get(task.id).state,'stopped');
});
