import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceHub} from '../runner/voice-hub.mjs';
const web=(extra={})=>({id:'web',kind:'web',visible:true,mode:'idle',...extra});
const native=(extra={})=>({id:'native',kind:'native',visible:true,mode:'idle',...extra});
function fixture(options={}){
 let now=1,saved=[];const config={load:()=>structuredClone(saved),save:items=>saved=structuredClone(items),now:()=>now,...options};
 const hub=new VoiceHub(config);return {hub,advance:ms=>now+=ms,restore:()=>new VoiceHub(config),saved:()=>saved};
}
const complete=(hub,id,taskId=id,label='graphic')=>hub.publish(id,'The written work is ready.',{kind:'completion',taskId,label});

test('an individual completion gets a brief grounded context without changing its saved text',()=>{
 const {hub}=fixture();complete(hub,'a','task-a','morning brief');const voice=hub.presence(web());
 assert.equal(voice.text,'An update on morning brief: The written work is ready.');
 assert.equal(hub.items[0].text,'The written work is ready.');
});
test('completion backlog becomes one neutral announcement with exact member acknowledgments',()=>{
 const {hub}=fixture();complete(hub,'a','task-a','morning brief');complete(hub,'b','task-b','graphic');
 const batch=hub.presence(web());assert.match(batch.id,/^batch:/);assert.match(batch.text,/updates from 2 tasks/);assert.match(batch.text,/morning brief and graphic/);assert.doesNotMatch(batch.text,/finished|complete|success|ready/);
 assert.equal(hub.presence(native()),null);hub.ack(batch.id,'native',true);assert.ok(hub.items.every(item=>!item.delivered));
 hub.ack(batch.id,'web',true);assert.ok(hub.items.every(item=>item.delivered));assert.equal(hub.presence(web()),null);
 complete(hub,'a','task-a');assert.equal(hub.items.length,3);
});
test('a failed unstarted group is retried in its app as the same durable group after restart',()=>{
 const f=fixture();complete(f.hub,'a');complete(f.hub,'b');const first=f.hub.presence(web());f.hub.ack(first.id,'web',false);
 const restored=f.restore();assert.equal(restored.presence(native()),null);
 const second=restored.presence(web({id:'web-reconnected',focus:true}));assert.deepEqual(second,first);
 restored.ack(second.id,'web-reconnected',true);assert.ok(restored.items.every(item=>item.delivered));
});
test('a started group never replays on interruption, disconnect, or lease expiry',()=>{
 for(const ending of ['ack','disconnect','lease']){
  const f=fixture({leaseMs:100});complete(f.hub,'a');complete(f.hub,'b');const first=f.hub.presence(web());
  f.hub.presence(web({mode:'speaking',playbackId:first.id,playbackStarted:true}));
  if(ending==='ack')f.hub.ack(first.id,'web',false);else if(ending==='disconnect')f.hub.leave('web');else f.advance(101);
  assert.equal(f.hub.presence(native()),null,ending);assert.ok(f.hub.items.every(item=>item.delivered),ending);
 }
});
test('newer same-task completion supersedes only unleased audio and keeps duplicate receipts',()=>{
 const {hub}=fixture();complete(hub,'old','same');complete(hub,'new','same');
 assert.equal(hub.items[0].retiredReason,'superseded');assert.equal(hub.presence(web()).id,'new');
 complete(hub,'newer','same');assert.equal(hub.items.find(item=>item.id==='new').delivered,undefined,'leased audio cannot be replaced');
 hub.ack('new','web',true);assert.equal(hub.presence(web()).id,'newer');
 complete(hub,'old','same');assert.equal(hub.items.filter(item=>item.id==='old').length,1);
});
test('publishing into a failed group regroups the exact remaining set without replaying superseded audio',()=>{
 const {hub}=fixture();complete(hub,'a1','a');complete(hub,'b1','b');const group=hub.presence(web());hub.ack(group.id,'web',false);
 complete(hub,'a2','a');const next=hub.presence(web());assert.notEqual(next.id,group.id);
 assert.deepEqual(hub.items.find(item=>item.id===next.id).members,['b1','a2']);assert.equal(hub.items.find(item=>item.id==='a1').retiredReason,'superseded');
 hub.ack(next.id,'web',true);assert.equal(hub.presence(web()),null);
});
test('arrivals during an unstarted lease join its group only after the attempt releases it',()=>{
 const {hub}=fixture();complete(hub,'a');complete(hub,'b');const first=hub.presence(web());complete(hub,'c');
 assert.equal(hub.presence(web()),null);hub.ack(first.id,'web',false);const next=hub.presence(web());
 assert.deepEqual(hub.items.find(item=>item.id===next.id).members,['a','b','c']);hub.ack(next.id,'web',true);assert.equal(hub.presence(web()),null);
});
test('five-minute expiry retires only audio while raw legacy records remain readable and duplicate-safe',()=>{
 const f=fixture();f.hub.publish('old','Legacy written answer');complete(f.hub,'completion');f.advance(300000);
 assert.equal(f.hub.presence(web()),null);assert.deepEqual(f.hub.items.map(item=>item.text),['Legacy written answer','The written work is ready.']);
 assert.ok(f.hub.items.every(item=>item.retiredReason==='expired'));f.hub.publish('old','Again');assert.equal(f.hub.items.length,2);
});
test('expiry dissolves an unstarted group without throwing away a newer member',()=>{
 const f=fixture();complete(f.hub,'old');f.advance(250000);complete(f.hub,'fresh');const first=f.hub.presence(web());f.hub.ack(first.id,'web',false);f.advance(50000);
 const next=f.hub.presence(web());assert.equal(next.id,'fresh');assert.equal(f.hub.items.find(item=>item.id==='old').retiredReason,'expired');
});
test('error and approval alerts outrank completions, are never grouped, and resolved alerts retire',()=>{
 const f=fixture();complete(f.hub,'a');complete(f.hub,'b');f.hub.publish('approval','Codex needs your input.',{kind:'attention',taskId:'approve'});f.hub.publish('error','The save failed.',{kind:'error',taskId:'error'});
 f.advance(300001);assert.equal(f.hub.presence(web()).id,'error');f.hub.ack('error','web',true);
 assert.equal(f.hub.presence(web()).id,'approval');f.hub.resolveTaskAttention('approve');assert.equal(f.hub.items.find(item=>item.id==='approval').delivered,undefined,'do not revoke a lease');
 f.hub.ack('approval','web',false);f.hub.resolveTaskAttention('approve');assert.equal(f.hub.presence(web()),null);
});
test('unknown raw announcement records retain serial delivery rather than fabricated grouping',()=>{
 const {hub}=fixture();hub.publish('raw-a','First');hub.publish('raw-b','Second');assert.deepEqual(hub.presence(web()),{id:'raw-a',text:'First'});
 hub.ack('raw-a','web',true);assert.deepEqual(hub.presence(web()),{id:'raw-b',text:'Second'});
});
test('an update arriving during a failed same-task group replaces the superseded member after lease release',()=>{
 const {hub}=fixture();complete(hub,'a1','a');complete(hub,'b','b');const first=hub.presence(web());complete(hub,'a2','a');hub.ack(first.id,'web',false);
 const next=hub.presence(web()),group=hub.items.find(item=>item.id===next.id);assert.deepEqual(group.members,['b','a2']);assert.match(next.text,/2 tasks/);
 assert.equal(hub.items.find(item=>item.id==='a1').retiredReason,'superseded');
});
test('a failed save stays prominent after the worker returns to ready',()=>{
 const {hub}=fixture();complete(hub,'success','a');hub.publish('failure','The workflow did not complete. The save failed.',{kind:'completion-error',taskId:'a'});
 hub.resolveTaskAttention('a');assert.equal(hub.presence(web()).id,'failure');
});
test('old attention IDs keep their priority without changing legacy records on load',()=>{
 const saved=[{id:'raw',text:'A result',ts:1},{id:'input:task-a:reason',text:'Approval needed',ts:1}];
 const hub=new VoiceHub({now:()=>300001,load:()=>structuredClone(saved)});assert.deepEqual(hub.items,saved);
 assert.equal(hub.presence(web()).id,'input:task-a:reason');
});
test('a completion with no task identity cannot dissolve or duplicate an existing group',()=>{
 const {hub}=fixture();complete(hub,'a');complete(hub,'b');const first=hub.presence(web());hub.ack(first.id,'web',false);
 hub.publish('unknown','A result without task metadata',{kind:'completion'});assert.deepEqual(hub.presence(web()),first);
 assert.equal(hub.items.filter(item=>item.id===first.id).length,1);hub.ack(first.id,'web',true);assert.equal(hub.presence(web()).id,'unknown');
});
test('a grouped worker failure is an update, never converted into a success claim',()=>{
 const {hub}=fixture();complete(hub,'a');hub.publish('b','The upload failed; the document is only saved locally.',{kind:'completion',taskId:'b',label:'upload'});
 const first=hub.presence(web());assert.match(first.text,/updates from 2 tasks/);assert.doesNotMatch(first.text,/success|ready|complete|finished/);
 assert.match(hub.items.find(item=>item.id==='b').text,/upload failed/);
});
