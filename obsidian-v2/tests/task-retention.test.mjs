import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {TerminalManager} from '../runner/terminals.mjs';
import {TASK_RETENTION_MS,TASK_SWEEP_MS} from '../runner/task-retention.mjs';
import {taskSummary} from '../shared/work-feed.mjs';
const selection={provider:'codex',model:'gpt-6-astra'};
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-retention-')),directory=path.join(root,'sessions');
 let clock=Date.UTC(2026,8,12);const timers=[],managers=[],processes=[];
 const options={directory,now:()=>clock,stopTree:false,schedule:(fn,ms)=>{const timer={fn,ms,unref(){},cancelled:false};timers.push(timer);return timer},cancelSchedule:timer=>{timer.cancelled=true},spawn:()=>{const proc={pid:100+processes.length,onData(fn){this.data=fn},onExit(fn){this.exit=fn},write(){},resize(){},kill(){}};processes.push(proc);return proc}};
 const open=()=>{const manager=new TerminalManager(root,options);managers.push(manager);return manager};
 const seed=(fields={},mtime=clock)=>{const id=fields.id||crypto.randomUUID(),folder=path.join(directory,id);fs.mkdirSync(path.join(folder,'events'),{recursive:true});const record={id,vault:root,...selection,prompt:'Original',title:'Saved task',created:clock,state:'stopped',pid:null,sessionId:crypto.randomUUID(),turns:[],...fields};const file=path.join(folder,'session.json');fs.writeFileSync(file,JSON.stringify(record));fs.utimesSync(file,new Date(mtime),new Date(mtime));return record};
 t.after(()=>{for(const manager of managers)manager.close();fs.rmSync(root,{recursive:true,force:true})});
 return {root,directory,open,seed,timers,processes,now:()=>clock,setNow:value=>{clock=value},advance:ms=>{clock+=ms}};
}
test('stopped tasks expire exactly at seven days; reads and resize do not extend activity',t=>{
 const f=fixture(t),m=f.open(),r=m.start({selection,prompt:'Keep my request'});m.stop(r.id);const activity=r.lastActivityAt,removed=[];m.onRemove=r=>removed.push(r.id);
 f.advance(TASK_RETENTION_MS-1);m.list();m.get(r.id);m.originalRequest(r.id);m.output(r.id);m.resize(r.id,80,20);m.prune();
 assert.equal(m.get(r.id).lastActivityAt,activity);assert.equal(m.list()[0].expiresAt,activity+TASK_RETENTION_MS);
 f.advance(1);m.prune();assert.equal(m.records.size,0);assert.deepEqual(removed,[r.id]);assert.equal(fs.existsSync(m.folder(r.id)),false);
 assert.throws(()=>m.start({id:r.id,selection,prompt:'Keep my request'}),/expired/);
 m.accept(r.id,{type:'complete',text:'Late event',turnId:'late'});m.save(r);assert.equal(fs.existsSync(m.folder(r.id)),false);
 m.close();const reopened=f.open();assert.throws(()=>reopened.start({id:r.id,selection,prompt:'Retry'}),/expired/);
 assert.throws(()=>reopened.startWorkflow({id:r.id,selection,skill:'metrics-pull'}),/expired/);
});
test('Keep persists across restart and unkeep starts a fresh seven days',t=>{
 const f=fixture(t),m=f.open(),r=m.start({selection,prompt:'Important'});m.stop(r.id);m.setKeep(r.id,true);const original=r.lastActivityAt;
 f.advance(TASK_RETENTION_MS*2);m.prune();assert.equal(m.list()[0].expiresAt,null);m.close();
 const reopened=f.open();assert.equal(reopened.get(r.id).keep,true);assert.equal(reopened.get(r.id).lastActivityAt,original);
 const changed=reopened.setKeep(r.id,false);assert.equal(changed.lastActivityAt,f.now());assert.equal(changed.expiresAt,f.now()+TASK_RETENTION_MS);
 assert.throws(()=>reopened.setKeep(r.id,'false'),/true or false/);
 assert.deepEqual(Object.fromEntries(Object.entries(taskSummary(reopened.list()[0])).filter(([key])=>['keep','lastActivityAt','expiresAt'].includes(key))),{keep:false,lastActivityAt:f.now(),expiresAt:f.now()+TASK_RETENTION_MS});
 f.advance(TASK_RETENTION_MS-1);reopened.prune();assert.equal(reopened.records.size,1);f.advance(1);reopened.prune();assert.equal(reopened.records.size,0);
});
test('every non-stopped state, kept record, PID and live guard is excluded',t=>{
 const f=fixture(t),m=f.open();
 for(const state of ['starting','working','ready','editing','needs input','stopping','error']){const r=m.start({selection,prompt:state});m.live.delete(r.id);r.pid=null;r.state=state}
 const live=m.start({selection,prompt:'live guard'});live.state='stopped';live.pid=null;
 const pid=m.start({selection,prompt:'PID guard'});m.live.delete(pid.id);pid.state='stopped';
 const kept=m.start({selection,prompt:'Kept'});m.stop(kept.id);m.setKeep(kept.id,true);
 const count=m.records.size;f.advance(TASK_RETENTION_MS*2);m.prune();assert.equal(m.records.size,count);assert.ok(m.list().every(r=>r.expiresAt===null));
});
test('start, resume, typed input, send, completion and stop advance meaningful activity',t=>{
 const f=fixture(t),m=f.open(),r=m.start({selection,prompt:'Activity'});assert.equal(r.lastActivityAt,f.now());
 for(const act of [()=>m.accept(r.id,{type:'complete',sessionId:crypto.randomUUID(),turnId:'one',text:'Answer'}),()=>m.input(r.id,'draft'),()=>m.markReady(r.id,{confirmedEmpty:true}),()=>m.send(r.id,'Next'),()=>m.stop(r.id),()=>m.resume(r.id)]){
  f.advance(1000);act();assert.equal(r.lastActivityAt,f.now());
 }
 f.advance(1000);m.stop(r.id);const stoppedAt=r.lastActivityAt;f.advance(1000);m.stop(r.id);assert.equal(r.lastActivityAt,stoppedAt,'duplicate stop is not meaningful activity');
});
test('legacy migration uses newest recorded activity or file mtime and does not reset on every restart',t=>{
 const f=fixture(t),old=f.now()-TASK_RETENTION_MS*2,recent=f.now()-2000;
 const recentFile=f.seed({created:old},recent),recentTurn=f.seed({created:old,turns:[{id:'last',text:'Answer',ts:recent+1000}]},old),expired=f.seed({created:old},old);
 const m=f.open();assert.equal(m.get(recentFile.id).lastActivityAt,recent);assert.equal(m.get(recentTurn.id).lastActivityAt,recent+1000);assert.equal(m.records.has(expired.id),false);m.close();
 f.advance(1000);const reopened=f.open();assert.equal(reopened.get(recentFile.id).lastActivityAt,recent);assert.equal(reopened.get(recentTurn.id).lastActivityAt,recent+1000);
});
test('previously live records get a fresh stopped clock on restart; error records remain excluded',t=>{
 const f=fixture(t),old=f.now()-TASK_RETENTION_MS*3;
 const interrupted=f.seed({created:old,lastActivityAt:old,state:'working',pid:9876},old),error=f.seed({created:old,lastActivityAt:old,state:'error'},old);
 const m=f.open();assert.equal(m.get(interrupted.id).state,'stopped');assert.equal(m.get(interrupted.id).lastActivityAt,f.now());assert.equal(m.get(interrupted.id).pid,null);assert.equal(m.live.size,0);assert.equal(f.processes.length,0);
 assert.equal(m.get(error.id).state,'error');assert.equal(m.list().find(r=>r.id===error.id).expiresAt,null);
});
test('wrong vault, mismatched ID and task junctions cannot be loaded, deleted or overwritten',t=>{
 const f=fixture(t),old=f.now()-TASK_RETENTION_MS*3,other=f.seed({vault:path.join(f.root,'other-vault'),created:old},old),mismatch=f.seed({created:old},old);
 const mismatchFile=path.join(f.directory,mismatch.id,'session.json');fs.writeFileSync(mismatchFile,JSON.stringify({...mismatch,id:crypto.randomUUID()}));
 const outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'sentinel.txt'),'Untouched');const linkId=crypto.randomUUID();fs.symlinkSync(outside,path.join(f.directory,linkId),'junction');
 const m=f.open();f.advance(TASK_RETENTION_MS*2);m.prune();assert.equal(m.records.size,0);
 assert.equal(fs.existsSync(path.join(f.directory,other.id,'session.json')),true);assert.equal(fs.existsSync(mismatchFile),true);assert.equal(fs.readFileSync(path.join(outside,'sentinel.txt'),'utf8'),'Untouched');
 for(const id of [other.id,mismatch.id,linkId])assert.throws(()=>m.start({id,selection,prompt:'Do not overwrite'}),/exists/);
});
test('linked child content blocks deletion and generated reports, vault notes and provider history are untouched',t=>{
 const f=fixture(t),m=f.open(),r=m.start({selection,prompt:'Safe cleanup'});m.stop(r.id);
 const artifacts=['reports/result.md','daily-notes/today.md','.provider/history.json'];for(const file of artifacts){const absolute=path.join(f.root,file);fs.mkdirSync(path.dirname(absolute),{recursive:true});fs.writeFileSync(absolute,'Retained '+file)}
 const linked=path.join(m.folder(r.id),'linked-report');fs.symlinkSync(path.join(f.root,'reports'),linked,'junction');
 f.advance(TASK_RETENTION_MS);m.prune();assert.equal(m.records.has(r.id),true);assert.equal(m.retention.retired.has(r.id),false);
 fs.unlinkSync(linked);m.prune();assert.equal(m.records.has(r.id),false);
 for(const file of artifacts)assert.equal(fs.readFileSync(path.join(f.root,file),'utf8'),'Retained '+file);
});
test('failed tombstone writes retain the task; partial cleanup retries without resurrection',t=>{
 const f=fixture(t),m=f.open(),r=m.start({selection,prompt:'Deletion failure'});m.stop(r.id);f.advance(TASK_RETENTION_MS);
 const remember=m.retention.remember;m.retention.remember=()=>{throw new Error('Disk full')};m.prune();assert.equal(m.records.has(r.id),true);assert.equal(fs.existsSync(m.folder(r.id)),true);
 m.retention.remember=remember;const remove=m.retention.removeRetired;m.retention.removeRetired=()=>{throw new Error('File busy')};m.prune();assert.equal(m.records.has(r.id),false);assert.equal(fs.existsSync(path.join(f.directory,`.retired-${r.id}`,'session.json')),true);
 m.retention.removeRetired=remove;m.close();const reopened=f.open();assert.equal(reopened.records.has(r.id),false);assert.equal(fs.existsSync(path.join(f.directory,`.retired-${r.id}`)),false);assert.throws(()=>reopened.start({id:r.id,selection,prompt:'Retry'}),/expired/);
});
test('cleanup is scheduled hourly, the idle sweep every minute, and every timer is disposed; closed manager cannot prune',t=>{
 const f=fixture(t),m=f.open(),r=m.start({selection,prompt:'Timer'});m.stop(r.id);
 assert.deepEqual(f.timers.map(t=>t.ms),[700,TASK_SWEEP_MS,60000]);f.advance(TASK_RETENTION_MS);m.close();assert.ok(f.timers.every(t=>t.cancelled));f.timers.find(t=>t.ms===TASK_SWEEP_MS).fn();assert.equal(m.records.has(r.id),true);
});
test('an empty retired directory left by final rmdir failure is cleaned; unowned content is retained',t=>{
 const f=fixture(t),m=f.open(),empty=crypto.randomUUID(),unknown=crypto.randomUUID();
 for(const id of [empty,unknown]){m.retention.remember(id);fs.mkdirSync(path.join(f.directory,`.retired-${id}`))}
 fs.writeFileSync(path.join(f.directory,`.retired-${unknown}`,'unowned.txt'),'Keep');m.prune();
 assert.equal(fs.existsSync(path.join(f.directory,`.retired-${empty}`)),false);assert.equal(fs.readFileSync(path.join(f.directory,`.retired-${unknown}`,'unowned.txt'),'utf8'),'Keep');
});

test('conversation activity survives restart normalization and never inherits a newer retention clock or file mtime',t=>{
 const f=fixture(t),old=f.now()-600000,recent=f.now()-1000;
 const explicit=f.seed({created:old,lastActivityAt:recent,conversationActivityAt:old,state:'working'});
 const legacy=f.seed({created:old,lastActivityAt:old,state:'working',turns:[{id:'latest',text:'Answer',ts:old+1000}]}),mtimeOnly=f.seed({created:old});
 const unknown=f.seed({created:undefined});
 const m=f.open();
 assert.equal(m.get(explicit.id).lastActivityAt,f.now(),'Retention starts its separate stopped clock');
 assert.equal(m.get(explicit.id).conversationActivityAt,old);
 assert.equal(m.get(legacy.id).conversationActivityAt,old+1000);
 assert.equal(m.get(mtimeOnly.id).lastActivityAt,f.now());
 assert.equal(m.get(mtimeOnly.id).conversationActivityAt,old,'Reading or copying session.json is not a conversation');
 assert.equal(m.get(unknown.id).conversationActivityAt,0,'Unknown legacy interaction time remains stale');
 m.close();f.advance(1000);const reopened=f.open();
 for(const r of [explicit,legacy,mtimeOnly,unknown])assert.equal(reopened.get(r.id).conversationActivityAt,m.get(r.id).conversationActivityAt);
});

test('screen output, terminal reports, reads, resize, keep and stop do not renew automatic conversation activity',async t=>{
 const f=fixture(t),m=f.open(),r=m.start({selection,prompt:'Meaningful activity only'}),activity=r.conversationActivityAt;
 for(const act of [()=>f.processes[0].data('Progress update\r\n'),()=>m.input(r.id,'\x1b[1;1R'),()=>m.list(),()=>m.output(r.id),()=>m.resize(r.id,80,24),()=>m.setKeep(r.id,true),()=>m.setKeep(r.id,false),()=>m.prune(),()=>m.stop(r.id)]){
  f.advance(1000);act();assert.equal(r.conversationActivityAt,activity);
 }
 assert.ok(r.lastActivityAt>activity,'Retention bookkeeping can advance independently');
 const exited=m.start({selection,prompt:'Natural exit'}),beforeExit=exited.conversationActivityAt;
 f.advance(1000);await f.processes.at(-1).exit({exitCode:0});
 assert.equal(exited.conversationActivityAt,beforeExit);assert.equal(exited.state,'stopped');
});

test('launch, typed input, explicit readiness, send, completion and resume renew conversation activity, but duplicate answers do not',t=>{
 const f=fixture(t),m=f.open(),r=m.start({selection,prompt:'Continue this conversation'}),sessionId=crypto.randomUUID();
 assert.equal(r.conversationActivityAt,f.now());
 const answer={type:'complete',sessionId,turnId:'answer-one',text:'Ready for the follow-up'};
 for(const act of [()=>m.accept(r.id,{...answer,ts:f.now()}),()=>m.input(r.id,'draft'),()=>m.markReady(r.id,{confirmedEmpty:true}),()=>m.send(r.id,'Follow-up'),()=>m.accept(r.id,{...answer,turnId:'answer-two',ts:f.now()})]){
  f.advance(1000);act();assert.equal(r.conversationActivityAt,f.now());
 }
 const completed=r.conversationActivityAt;f.advance(1000);m.accept(r.id,{...answer,turnId:'answer-two',ts:f.now()});assert.equal(r.conversationActivityAt,completed);
 f.advance(1000);m.stop(r.id);assert.equal(r.conversationActivityAt,completed);
 f.advance(1000);m.resume(r.id);assert.equal(r.conversationActivityAt,f.now());
});
