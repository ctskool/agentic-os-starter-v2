// A follow-up spoken for a conversation that is in the middle of a turn waits in the bridge and is sent when the
// turn ends (Chase's call, 2026-11-23: "add a section on its history" while the page was still being written was
// refused). It is never typed into a working CLI, and it does not outlive the conversation.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {TerminalManager,MAX_QUEUED_FOLLOWUPS,QUEUED_FOLLOWUP_MAX_AGE_MS} from '../runner/terminals.mjs';

const session='01a09b1a-fb81-7433-a9d7-d8333de6cbe0';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-queued-'));let time=100000,turn=0;
 const timers=[],processes=[],manager=new TerminalManager(root,{directory:path.join(root,'work'),now:()=>time,schedule:()=>({unref(){}}),cancelSchedule(){},
  defer:(fn,delay)=>{const timer={fn,at:time+delay,canceled:false,unref(){}};timers.push(timer);return timer},cancelDeferred:timer=>timer.canceled=true,
  spawn:()=>{const proc={pid:700+processes.length,writes:[],write(text){this.writes.push(text)},onData(fn){this.data=fn},onExit(fn){this.exit=fn},resize(){},kill(){}};processes.push(proc);return proc},
 });
 const task=manager.start({selection:{provider:'claude',model:'sonnet'},prompt:'Write the explainer'});
 t.after(()=>{manager.close();fs.rmSync(root,{recursive:true,force:true})});
 const typed=()=>processes[0].writes.join('');
 return {manager,task,processes,typed,
  // The CLI reports that its turn is over; the deferred hand-over then runs.
  finishTurn(text='Done.'){manager.accept(task.id,{type:'Stop',sessionId:session,turnId:'turn-'+(++turn),text});for(const timer of timers.splice(0))if(!timer.canceled&&timer.at<=time)timer.fn()},
  advance(ms){time+=ms},
  waiting:()=>manager.list().find(item=>item.id===task.id).queuedFollowups,
 };
}

test('a follow-up for a working conversation waits, is not typed, and is sent when the turn ends',t=>{
 const f=fixture(t);
 assert.equal(f.task.state,'working');
 const before=f.typed();
 f.manager.sendWhenFree(f.task.id,'Add a section on its history',{liveCallId:'11111111-1111-4111-8111-111111111111'});
 assert.equal(f.waiting(),1);assert.equal(f.typed(),before,'nothing is typed into a working terminal');assert.equal(f.task.state,'working');
 f.finishTurn('The explainer is written.');
 assert.equal(f.waiting(),0);assert.equal(f.task.state,'working','the waiting request started the next turn');
 assert.match(f.typed(),/Add a section on its history/);
 assert.equal(f.task.activeLiveCallId,'11111111-1111-4111-8111-111111111111','its result is announced on the call that asked');
 // Nothing more is waiting, so the next turn end sends nothing.
 const after=f.typed();f.finishTurn('Section added.');assert.equal(f.typed(),after);assert.equal(f.task.state,'ready');
});

test('requests go one per turn in the order they were said, and a free conversation is sent to at once',t=>{
 const f=fixture(t);
 f.manager.sendWhenFree(f.task.id,'First addition');f.manager.sendWhenFree(f.task.id,'Second addition');
 assert.equal(f.waiting(),2);
 f.finishTurn();assert.match(f.typed(),/First addition/);assert.doesNotMatch(f.typed(),/Second addition/);assert.equal(f.waiting(),1);
 f.finishTurn();assert.match(f.typed(),/Second addition/);assert.equal(f.waiting(),0);
 f.finishTurn();assert.equal(f.task.state,'ready');
 f.manager.sendWhenFree(f.task.id,'Sent straight away');
 assert.equal(f.waiting(),0);assert.match(f.typed(),/Sent straight away/);assert.equal(f.task.state,'working');
});

test('at most three wait, a stale one is dropped, and a stopped conversation keeps none',t=>{
 const f=fixture(t);
 for(let index=0;index<MAX_QUEUED_FOLLOWUPS;index++)f.manager.sendWhenFree(f.task.id,'Request '+index);
 assert.throws(()=>f.manager.sendWhenFree(f.task.id,'One too many'),/already has 3 requests waiting/);
 f.advance(QUEUED_FOLLOWUP_MAX_AGE_MS+1);
 const before=f.typed();f.finishTurn();
 assert.equal(f.typed(),before,'a request older than half an hour is not sent out of the blue');assert.equal(f.waiting(),0);assert.equal(f.task.state,'ready');
 f.manager.send(f.task.id,'Keep going');f.manager.sendWhenFree(f.task.id,'Never delivered');assert.equal(f.waiting(),1);
 f.manager.stop(f.task.id);
 assert.equal(f.waiting(),0);
});

test('a conversation waiting for an approval takes no follow-up, queued or typed',t=>{
 const f=fixture(t);
 f.manager.accept(f.task.id,{type:'PermissionRequest',sessionId:session});
 assert.equal(f.task.state,'needs input');
 const before=f.typed();
 assert.throws(()=>f.manager.sendWhenFree(f.task.id,'Add a section'),/waiting for your approval/);
 assert.equal(f.typed(),before);assert.equal(f.waiting(),0);
});
