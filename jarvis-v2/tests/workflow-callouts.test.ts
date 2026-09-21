import test from 'node:test';
import assert from 'node:assert/strict';
import {queueWorkflowCallout,reconcileWorkflowCallouts} from '../lib/workflow-callouts';
import type {RunEntry} from '../lib/vault';

const run=(id:string,status:string,extra:Partial<RunEntry>={}):RunEntry=>({id,skill:'morning-report',label:'Morning Intel',status,summary:'',link:null,ts_started:'2026-09-14T12:00:00Z',ts_completed:null,duration_s:null,deliverable_path:null,...extra});

test('queued workflow becomes a report card in place even when completion precedes the first poll',()=>{
  let seq=0;
  const queued=queueWorkflowCallout([],'quick-report','Morning Intel',()=>++seq);
  assert.equal(queued[0].phase,'queued');
  const done=reconcileWorkflowCallouts(queued,[run('quick-report','ok',{deliverable_path:'inbox/reports/morning.md'})],{},()=>++seq);
  assert.deepEqual(done.map(card=>[card.id,card.slot,card.kind,card.target]),[[queued[0].id,queued[0].slot,'doc','inbox/reports/morning.md']]);
  assert.equal(done[0].phase,undefined);
});

test('workflow failures remain visible with the actual error and never become report links',()=>{
  const queued=queueWorkflowCallout([],'failed','Deep Research',()=>1);
  const failed=reconcileWorkflowCallouts(queued,[run('failed','error',{summary:'Provider sign-in expired.',deliverable_path:'stale.md'})],{},()=>2);
  assert.equal(failed[0].kind,'task');assert.equal(failed[0].phase,'failed');assert.equal(failed[0].detail,'Provider sign-in expired.');
  assert.equal(failed[0].target,'run:failed');
});

test('running polls preserve the card and successful scripts without a report finish cleanly',()=>{
  let seq=0;
  const first=reconcileWorkflowCallouts([],[run('refresh','running')],{'morning-report':30},()=>++seq);
  assert.equal(first[0].phase,'working');assert.equal(first[0].etaS,30);
  assert.strictEqual(reconcileWorkflowCallouts(first,[run('refresh','running')],{},()=>++seq),first);
  const completed=reconcileWorkflowCallouts(first,[run('refresh','ok')],{},()=>++seq);
  assert.equal(completed[0].phase,'done');assert.equal(seq,1);
});

test('queue receipt deduplication and fresh-page snapshots do not replay old reports',()=>{
  const queued=queueWorkflowCallout([],'same','Morning Intel',()=>1);
  assert.strictEqual(queueWorkflowCallout(queued,'same','Morning Intel',()=>2),queued);
  assert.deepEqual(reconcileWorkflowCallouts([],[run('historical','ok',{deliverable_path:'old.md'})],{},()=>3),[]);
});
