import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkAttentionEpisodes} from '../runner/work-attention.mjs';
import {VoiceHub} from '../runner/voice-hub.mjs';

const task=(state,error='Approve this edit.',id='task-a')=>({id,provider:'codex',state,error});

test('each new attention episode is delivered even when its text matches an acknowledged earlier one',()=>{
 const episodes=new WorkAttentionEpisodes([],{epoch:'boot-a'}),hub=new VoiceHub({now:()=>1});
 const publish=record=>{const next=episodes.next(record);if(next)hub.publish(next.id,next.reason);return next};
 assert.equal(publish(task('working')),null);
 const first=publish(task('needs input'));assert.ok(first);
 for(let i=0;i<8;i++)assert.equal(publish(task('needs input')),null);
 assert.equal(hub.items.length,1);
 hub.presence({id:'native',kind:'native',visible:true,mode:'idle',canPlay:true,focus:true});hub.ack(first.id,'native',true);
 assert.equal(hub.items[0].delivered,1);
 assert.equal(publish(task('working')),null);
 const second=publish(task('needs input'));assert.notEqual(second.id,first.id);assert.equal(second.reason,first.reason);assert.equal(hub.items.length,2);assert.equal(hub.items[1].delivered,undefined);
});

test('a changed blocking reason or attention type announces once, without repeated-save spam',()=>{
 const episodes=new WorkAttentionEpisodes([],{epoch:'boot-a'});
 const first=episodes.next(task('needs input'));const changed=episodes.next(task('needs input','Sign in first.'));
 assert.ok(changed);assert.notEqual(first.id,changed.id);assert.equal(episodes.next(task('needs input','Sign in first.')),null);
 const error=episodes.next(task('error','The CLI exited.'));assert.equal(error.state,'error');assert.equal(episodes.next(task('error','The CLI exited.')),null);
 episodes.next(task('ready'));assert.notEqual(episodes.next(task('error','The CLI exited.')).id,error.id);
});

test('restart seeds current states and leaves queued old receipt IDs intact',()=>{
 const record=task('needs input'),oldId='input:task-a:Approve this edit.';
 const saved=[{id:oldId,text:record.error,ts:1}],hub=new VoiceHub({load:()=>structuredClone(saved)});
 const bootA=new WorkAttentionEpisodes([record],{epoch:'boot-a'});
 assert.equal(bootA.next(record),null);assert.deepEqual(hub.items,saved);
 bootA.next(task('working'));const next=bootA.next(record);hub.publish(next.id,next.reason);assert.equal(hub.items[0].id,oldId);
 const bootB=new WorkAttentionEpisodes([record],{epoch:'boot-b'});assert.equal(bootB.next(record),null);
 bootB.next(task('working'));assert.notEqual(bootB.next(record).id,next.id);
});

test('task state is isolated and removal reclaims tracking without touching delivery receipts',()=>{
 const episodes=new WorkAttentionEpisodes([],{epoch:'boot-a'}),a=episodes.next(task('needs input'));
 const b=episodes.next(task('needs input','Approve this edit.','task-b'));assert.notEqual(a.id,b.id);
 episodes.next(task('working'));assert.equal(episodes.next(task('needs input','Approve this edit.','task-b')),null);
 episodes.remove('task-a');assert.equal(episodes.records.has('task-a'),false);assert.equal(episodes.records.has('task-b'),true);
});
