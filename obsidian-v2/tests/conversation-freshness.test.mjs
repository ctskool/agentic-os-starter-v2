import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {CONVERSATION_IDLE_MS,reconcileCurrent,resolveVoiceTarget,renewConversation,readCurrentState,readConversationEpoch,readConversationReset,setCurrent} from '../runner/current-conversations.mjs';

const start=Date.UTC(2026,8,15,12),minute=60000;
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-freshness-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const records=new Map(),terminals={records,get(id){const task=records.get(id);if(!task)throw Error('Task not found');return task}};
 const file=path.join(root,'system/v2/current-conversations.json');
 function task(provider='codex',scope='web',overrides={}){
  const r={id:crypto.randomUUID(),provider,state:'ready',pid:42,created:start,lastActivityAt:start,turns:[],...(scope==='native'?{execution:'native'}:{}),...overrides};records.set(r.id,r);return r;
 }
 function select(r,scope='web',now=start){return setCurrent(root,terminals,{scope,provider:r.provider,id:r.id,now})}
 return {root,file,records,terminals,task,select,saved:()=>JSON.parse(fs.readFileSync(file,'utf8'))};
}

test('automatic selection expires at thirty idle minutes for both providers and apps, including ready live terminals',t=>{
 const f=fixture(t),tasks=[];
 for(const scope of ['web','native'])for(const provider of ['codex','claude']){const r=f.task(provider,scope);tasks.push(r);f.select(r,scope)}
 const before=structuredClone(tasks);
 for(const scope of ['web','native']){
  const initial=readCurrentState(f.root,scope);
  assert.deepEqual(reconcileCurrent(f.root,f.terminals,{scope,now:start+CONVERSATION_IDLE_MS-1}),initial);
  assert.deepEqual(reconcileCurrent(f.root,f.terminals,{scope,now:start+CONVERSATION_IDLE_MS}),{codex:null,claude:null,revision:initial.revision+1});
  for(const provider of ['codex','claude']){
   assert.equal(readConversationEpoch(f.root,provider,scope),1);
   assert.equal(readConversationReset(f.root,provider,scope).reason,'expired');
  }
 }
 assert.deepEqual(tasks,before,'Reconciliation never modifies, stops or deletes a task');
 assert.equal(f.records.size,4);
});

test('polls and native presence do not renew the selection or produce repeated state writes',t=>{
 const f=fixture(t),r=f.task('codex','native',{native:{lastSeen:start}});f.select(r,'native');
 const bytes=fs.readFileSync(f.file,'utf8');
 for(let i=1;i<=29;i++){
  r.native.lastSeen=start+i*minute;r.updatedAt=start+i*minute;
  assert.equal(reconcileCurrent(f.root,f.terminals,{scope:'native',now:start+i*minute}).codex,r.id);
  assert.equal(fs.readFileSync(f.file,'utf8'),bytes);
 }
 assert.equal(reconcileCurrent(f.root,f.terminals,{scope:'native',now:start+30*minute}).codex,null);
 const expired=fs.readFileSync(f.file,'utf8');
 reconcileCurrent(f.root,f.terminals,{scope:'native',now:start+31*minute});
 assert.equal(fs.readFileSync(f.file,'utf8'),expired);
});

test('accepted user activity or a completed answer renews the idle window',t=>{
 for(const field of ['lastActivityAt','conversationActivityAt','turns']){
  const f=fixture(t),r=f.task();f.select(r);
  if(field==='turns')r.turns.push({ts:start+20*minute,text:'Finished'});else r[field]=start+20*minute;
  assert.equal(reconcileCurrent(f.root,f.terminals,{now:start+49*minute}).codex,r.id);
  assert.equal(reconcileCurrent(f.root,f.terminals,{now:start+50*minute}).codex,null);
 }
});

test('dedicated conversational activity takes precedence over retention or restart bookkeeping',t=>{
 const f=fixture(t),r=f.task('codex','web',{conversationActivityAt:start,lastActivityAt:start+29*minute});f.select(r);
 assert.equal(reconcileCurrent(f.root,f.terminals,{now:start+30*minute}).codex,null);
});

test('choosing a saved conversation explicitly renews it without duplicating its task or changing a same-id revision',t=>{
 const f=fixture(t),r=f.task();const initial=f.select(r);
 const selectedAgain=f.select(r,'web',start+29*minute);assert.equal(selectedAgain.revision,initial.revision);
 assert.equal(reconcileCurrent(f.root,f.terminals,{now:start+58*minute}).codex,r.id);
 assert.equal(reconcileCurrent(f.root,f.terminals,{now:start+59*minute}).codex,null);
 assert.equal(readConversationReset(f.root,'codex').previousId,r.id);
 f.select(r,'web',start+60*minute);
 assert.equal(readConversationReset(f.root,'codex'),null);
 assert.equal(reconcileCurrent(f.root,f.terminals,{now:start+89*minute}).codex,r.id);
 assert.equal(f.records.size,1);
});

test('actively working, starting, approval, stopping and editing tasks survive idle expiry and cold app sessions',t=>{
 for(const state of ['starting','working','needs input','stopping','editing']){
  const f=fixture(t),r=f.task('codex','native',{state});f.select(r,'native');
  assert.equal(reconcileCurrent(f.root,f.terminals,{scope:'native',now:start+24*60*minute}).codex,r.id);
  assert.equal(reconcileCurrent(f.root,f.terminals,{scope:'native',now:start+24*60*minute,sessionId:crypto.randomUUID()}).codex,r.id);
  assert.equal(readConversationEpoch(f.root,'codex','native'),0);
  assert.equal(r.state,state);
 }
});

test('cold sessions clear idle selections and quick context once while preserving the other app and active provider',t=>{
 const f=fixture(t),nativeIdle=f.task('codex','native'),nativeActive=f.task('claude','native',{state:'working'}),web=f.task();
 f.select(nativeIdle,'native');f.select(nativeActive,'native');f.select(web);
 const originalWeb=structuredClone(f.saved().scopes.web),sessionId=crypto.randomUUID();
 const state=reconcileCurrent(f.root,f.terminals,{scope:'native',now:start+minute,sessionId});
 assert.equal(state.codex,null);assert.equal(state.claude,nativeActive.id);
 assert.deepEqual(readConversationReset(f.root,'codex','native'),{reason:'session',at:start+minute,previousId:nativeIdle.id});
 assert.equal(readConversationEpoch(f.root,'codex','native'),1);assert.equal(readConversationEpoch(f.root,'claude','native'),0);
 assert.deepEqual(f.saved().scopes.web,originalWeb);
 f.select(nativeIdle,'native',start+2*minute);
 const bytes=fs.readFileSync(f.file,'utf8');
 assert.equal(reconcileCurrent(f.root,f.terminals,{scope:'native',now:start+3*minute,sessionId}).codex,nativeIdle.id);
 assert.equal(fs.readFileSync(f.file,'utf8'),bytes,'A duplicate startup response cannot clear newly selected work');
});

test('a fresh app session clears quick-answer epochs even when no terminal was selected',t=>{
 const f=fixture(t),sessionId=crypto.randomUUID();
 assert.deepEqual(reconcileCurrent(f.root,f.terminals,{scope:'native',now:start,sessionId}),{codex:null,claude:null,revision:1});
 for(const provider of ['codex','claude'])assert.equal(readConversationEpoch(f.root,provider,'native'),1);
 const bytes=fs.readFileSync(f.file,'utf8');
 reconcileCurrent(f.root,f.terminals,{scope:'native',now:start+minute,sessionId});assert.equal(fs.readFileSync(f.file,'utf8'),bytes);
 assert.equal(readConversationEpoch(f.root,'codex','web'),0);
});

test('session retry protection stays bounded to sixteen app sessions',t=>{
 const f=fixture(t),ids=Array.from({length:20},()=>crypto.randomUUID());
 for(const [i,sessionId] of ids.entries())reconcileCurrent(f.root,f.terminals,{now:start+i*minute,sessionId});
 assert.deepEqual(f.saved().scopes.web.sessionIds,ids.slice(-16));
 const r=f.task();f.select(r,'web',start+20*minute);
 const bytes=fs.readFileSync(f.file,'utf8');
 for(const sessionId of ids.slice(-16))assert.equal(reconcileCurrent(f.root,f.terminals,{now:start+21*minute,sessionId}).codex,r.id);
 assert.equal(fs.readFileSync(f.file,'utf8'),bytes);
});

test('missing, foreign and noninteractive selected records clear without touching task files',t=>{
 for(const invalid of ['missing','provider','scope','script','headless','background']){
  const f=fixture(t),r=f.task();f.select(r);
  if(invalid==='missing')f.records.delete(r.id);
  else if(invalid==='provider')r.provider='claude';
  else if(invalid==='scope')r.execution='native';
  else if(invalid==='background')r.background=true;
  else r.execution=invalid;
  const records=structuredClone([...f.records]);
  assert.equal(reconcileCurrent(f.root,f.terminals,{now:start+minute}).codex,null);
  assert.equal(readConversationReset(f.root,'codex').reason,'unavailable');
  assert.deepEqual([...f.records],records);
 }
});

test('legacy settings age from stored task activity and never gain a fresh timestamp merely by migration',t=>{
 for(const version of [1,2])for(const withTimestamp of [true,false]){
  const f=fixture(t),r=f.task();if(!withTimestamp){delete r.created;delete r.lastActivityAt}
  const state={current:{codex:r.id,claude:null},revision:7,contextEpochs:{codex:3,claude:2}};
  fs.mkdirSync(path.dirname(f.file),{recursive:true});
  fs.writeFileSync(f.file,JSON.stringify(version===1?{version,...state}:{version,scopes:{web:state,native:{current:{codex:null,claude:null},revision:0}}}));
  assert.equal(reconcileCurrent(f.root,f.terminals,{now:start+CONVERSATION_IDLE_MS}).codex,null);
  assert.equal(readConversationEpoch(f.root,'codex'),4);assert.equal(readConversationEpoch(f.root,'claude'),2);
 }
});

test('an explicit new conversation clears reset metadata without deleting saved work',t=>{
 const f=fixture(t),r=f.task();f.select(r);reconcileCurrent(f.root,f.terminals,{now:start+30*minute});
 assert.equal(readConversationReset(f.root,'codex').reason,'expired');
 setCurrent(f.root,f.terminals,{provider:'codex',id:null,now:start+31*minute});
 assert.equal(readConversationReset(f.root,'codex'),null);assert.equal(f.records.get(r.id),r);
});

test('captured stale headers cannot restore an expired selection or silently adopt its replacement',t=>{
 const f=fixture(t),old=f.task();f.select(old);reconcileCurrent(f.root,f.terminals,{now:start+30*minute});
 const request={provider:'codex',id:old.id,now:start+31*minute};
 assert.equal(resolveVoiceTarget(f.root,f.terminals,request),null);
 const fresh=f.task('codex','web',{created:start+31*minute,lastActivityAt:start+31*minute});f.select(fresh,'web',start+31*minute);
 assert.equal(resolveVoiceTarget(f.root,f.terminals,request),null);
 assert.equal(readCurrentState(f.root).codex,fresh.id);
 f.select(old,'web',start+31*minute);
 assert.equal(resolveVoiceTarget(f.root,f.terminals,request),old.id,'An explicit History selection restores the saved conversation');
});

test('cold-start reset metadata drops a recently captured idle target and missing retired target',t=>{
 for(const missing of [false,true]){
  const f=fixture(t),r=f.task();f.select(r);if(missing)f.records.delete(r.id);
  reconcileCurrent(f.root,f.terminals,{now:start+minute,sessionId:crypto.randomUUID()});
  assert.equal(resolveVoiceTarget(f.root,f.terminals,{provider:'codex',id:r.id,now:start+minute}),null);
 }
});

test('captured foreign and unknown targets retain existing downstream ownership checks',t=>{
 const f=fixture(t);
 for(const r of [f.task('claude'),f.task('codex','native'),f.task('codex','web',{execution:'headless'}),{id:crypto.randomUUID()}]){
  assert.equal(resolveVoiceTarget(f.root,f.terminals,{provider:'codex',id:r.id,now:start+60*minute}),r.id);
 }
 const active=f.task('codex','web',{state:'working'});
 assert.equal(resolveVoiceTarget(f.root,f.terminals,{provider:'codex',id:active.id,now:start+60*minute}),active.id);
});

test('bad session IDs and activity timestamps fail without changing persisted state',t=>{
 const f=fixture(t),r=f.task();f.select(r);const bytes=fs.readFileSync(f.file,'utf8');
 for(const sessionId of ['../escape','',null,123])assert.throws(()=>reconcileCurrent(f.root,f.terminals,{now:start,sessionId}),/session/);
 for(const now of [-1,NaN,Infinity,'today']){
  assert.throws(()=>reconcileCurrent(f.root,f.terminals,{now}),/activity time/);
  assert.throws(()=>setCurrent(f.root,f.terminals,{provider:'codex',id:r.id,now}),/activity time/);
 }
 assert.equal(fs.readFileSync(f.file,'utf8'),bytes);
});

test('a meaningful quick voice request renews the same selection without changing revisions, epochs or the other app',t=>{
 const f=fixture(t),r=f.task('codex','native'),other=f.task('claude');f.select(r,'native');f.select(other);
 const before=f.saved();
 assert.equal(renewConversation(f.root,{scope:'native',provider:'codex',id:r.id,now:start+29*minute+59000}),true);
 const after=f.saved();
 assert.equal(after.scopes.native.selectionActivity.codex,start+29*minute+59000);
 assert.deepEqual(after.scopes.native.current,before.scopes.native.current);
 assert.equal(after.scopes.native.revision,before.scopes.native.revision);
 assert.deepEqual(after.scopes.native.contextEpochs,before.scopes.native.contextEpochs);
 assert.deepEqual(after.scopes.web,before.scopes.web);
 assert.equal(reconcileCurrent(f.root,f.terminals,{scope:'native',now:start+30*minute+1000}).codex,r.id);
 assert.equal(reconcileCurrent(f.root,f.terminals,{scope:'native',now:start+59*minute+59000}).codex,null);
});

test('late voice renewal never selects a different, cleared, missing or invalid conversation',t=>{
 const f=fixture(t),old=f.task(),current=f.task();f.select(old);f.select(current);
 const args={provider:'codex',now:start+29*minute},bytes=fs.readFileSync(f.file,'utf8');
 for(const id of [old.id,crypto.randomUUID(),null,undefined,'bad-id']){
  assert.equal(renewConversation(f.root,{...args,id}),false);
  assert.equal(fs.readFileSync(f.file,'utf8'),bytes);
 }
 assert.equal(renewConversation(f.root,{...args,provider:'claude',id:current.id}),false);
 assert.equal(renewConversation(f.root,{...args,scope:'native',id:current.id}),false);
 setCurrent(f.root,f.terminals,{provider:'codex',id:null,now:start+minute});const cleared=fs.readFileSync(f.file,'utf8');
 assert.equal(renewConversation(f.root,{...args,id:current.id}),false);
 assert.equal(fs.readFileSync(f.file,'utf8'),cleared);
});

test('a duplicate or older user activity renewal does not rewrite state or move time backwards',t=>{
 const f=fixture(t),r=f.task();f.select(r);
 assert.equal(renewConversation(f.root,{provider:'codex',id:r.id,now:start+minute}),true);
 const bytes=fs.readFileSync(f.file,'utf8');
 for(const now of [start,start+minute]){
  assert.equal(renewConversation(f.root,{provider:'codex',id:r.id,now}),true);
  assert.equal(fs.readFileSync(f.file,'utf8'),bytes);
 }
});

test('additional web tabs and reloads adopt recent selections without renewing their age or resetting epochs',t=>{
 const f=fixture(t),codex=f.task(),claude=f.task('claude'),native=f.task('codex','native');
 f.select(codex);f.select(claude);f.select(native,'native');const original=f.saved();
 for(let minuteOffset=1;minuteOffset<=3;minuteOffset++){
  assert.deepEqual(reconcileCurrent(f.root,f.terminals,{now:start+minuteOffset*minute,sessionId:crypto.randomUUID(),sessionMode:'adopt'}),{...original.scopes.web.current,revision:original.scopes.web.revision});
  const saved=f.saved();assert.deepEqual(saved.scopes.web.contextEpochs,original.scopes.web.contextEpochs);
  assert.deepEqual(saved.scopes.web.selectionActivity,original.scopes.web.selectionActivity);assert.deepEqual(saved.scopes.native,original.scopes.native);
 }
 assert.equal(f.saved().scopes.web.sessionIds.length,3);
});

test('web adoption still expires idle context and preserves active work at the thirty-minute boundary',t=>{
 const f=fixture(t),idle=f.task(),active=f.task('claude','web',{state:'working'});f.select(idle);f.select(active);
 const result=reconcileCurrent(f.root,f.terminals,{now:start+CONVERSATION_IDLE_MS,sessionId:crypto.randomUUID(),sessionMode:'adopt'});
 assert.equal(result.codex,null);assert.equal(result.claude,active.id);
 assert.equal(readConversationReset(f.root,'codex').reason,'expired');assert.equal(readConversationEpoch(f.root,'codex'),1);assert.equal(readConversationEpoch(f.root,'claude'),0);
 assert.equal(f.records.get(idle.id),idle);assert.equal(f.records.get(active.id),active);
});

test('web adoption preserves explicit new-conversation boundaries and does not revive history',t=>{
 const f=fixture(t),old=f.task();f.select(old);setCurrent(f.root,f.terminals,{provider:'codex',id:null,now:start+minute});
 const before=readCurrentState(f.root),epoch=readConversationEpoch(f.root,'codex');
 assert.deepEqual(reconcileCurrent(f.root,f.terminals,{now:start+2*minute,sessionId:crypto.randomUUID(),sessionMode:'adopt'}),before);
 assert.equal(readConversationEpoch(f.root,'codex'),epoch);assert.equal(f.records.get(old.id),old);
});

test('native sessions cannot opt into web adoption and invalid modes leave saved selections unchanged',t=>{
 const f=fixture(t),r=f.task('codex','native');f.select(r,'native');const bytes=fs.readFileSync(f.file,'utf8');
 for(const sessionMode of ['adopt','invalid',null])assert.throws(()=>reconcileCurrent(f.root,f.terminals,{scope:'native',now:start+minute,sessionId:crypto.randomUUID(),sessionMode}),/session mode/);
 assert.equal(fs.readFileSync(f.file,'utf8'),bytes);
 assert.equal(reconcileCurrent(f.root,f.terminals,{scope:'native',now:start+minute,sessionId:crypto.randomUUID()}).codex,null);
 assert.equal(readConversationEpoch(f.root,'codex','native'),1);
});
