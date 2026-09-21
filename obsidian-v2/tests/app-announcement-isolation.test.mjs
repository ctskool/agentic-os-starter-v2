import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceHub} from '../runner/voice-hub.mjs';
const presence=(kind,extra={})=>({id:kind,kind,visible:true,mode:'idle',focus:true,...extra});
const publish=(hub,id,appScope,kind='completion')=>hub.publish(id,`${appScope} saved result ${id}`,{kind,taskId:id,appScope});

test('task completions, errors and artifact confirmations are spoken only by their originating app',()=>{
 for(const kind of ['completion','completion-error','attention','error','artifact-confirmation']){
  const hub=new VoiceHub();publish(hub,'web-'+kind,'web',kind);publish(hub,'native-'+kind,'native',kind);
  const native=hub.presence(presence('native'));assert.equal(native.id,'native-'+kind);
  hub.ack(native.id,'native',true);assert.equal(hub.presence(presence('native')),null);
  const web=hub.presence(presence('web'));assert.equal(web.id,'web-'+kind);hub.ack(web.id,'web',true);
  assert.ok(hub.items.every(item=>item.delivered));
 }
});

test('one physical playback lease is shared while completion groups stay app-specific',()=>{
 const hub=new VoiceHub();for(const appScope of ['web','native'])for(const suffix of ['a','b'])publish(hub,appScope+'-'+suffix,appScope);
 const native=hub.presence(presence('native')),nativeGroup=hub.items.find(item=>item.id===native.id);
 assert.deepEqual(nativeGroup.members,['native-a','native-b']);assert.equal(nativeGroup.appScope,'native');
 assert.equal(hub.presence(presence('web')),null,'The other app cannot overlap an active audio lease');
 hub.ack(native.id,'native',true);
 const web=hub.presence(presence('web')),webGroup=hub.items.find(item=>item.id===web.id);
 assert.deepEqual(webGroup.members,['web-a','web-b']);assert.equal(webGroup.appScope,'web');
 assert.ok(!webGroup.delivered);assert.ok(nativeGroup.delivered);
});

test('another app publishing cannot dissolve an unstarted durable group',()=>{
 const hub=new VoiceHub();publish(hub,'native-a','native');publish(hub,'native-b','native');
 const initial=hub.presence(presence('native'));hub.ack(initial.id,'native',false);
 publish(hub,'web-result','web');assert.deepEqual(hub.presence(presence('native')),initial);
 assert.equal(hub.items.filter(item=>item.id===initial.id).length,1);
});

test('legacy task backlog belongs to web while raw system notices retain shared playback',()=>{
 const saved=[
  {id:'legacy-task',taskId:'legacy-task',kind:'completion',text:'Saved legacy task',ts:1},
  {id:'system',text:'Shared system notice',ts:1},
 ];
 const hub=new VoiceHub({load:()=>structuredClone(saved),now:()=>2});assert.deepEqual(hub.items,saved,'Loading does not rewrite old receipts');
 const native=hub.presence(presence('native'));assert.equal(native.id,'system');hub.ack(native.id,'native',true);
 assert.equal(hub.presence(presence('native')),null);
 assert.equal(hub.presence(presence('web')).id,'legacy-task');
});

test('legacy grouped completions cannot be claimed by a newly connected native surface',()=>{
 const saved=[
  {id:'a',taskId:'a',kind:'completion',text:'A',ts:1,groupedInto:'batch:legacy'},
  {id:'b',taskId:'b',kind:'completion',text:'B',ts:1,groupedInto:'batch:legacy'},
  {id:'batch:legacy',kind:'completion-group',members:['a','b'],text:'Two updates',ts:1},
 ];
 const hub=new VoiceHub({load:()=>structuredClone(saved),now:()=>2});assert.equal(hub.presence(presence('native')),null);
 assert.equal(hub.presence(presence('web')).id,'batch:legacy');
});

test('an explicitly scoped generic notice waits for its app',()=>{
 const hub=new VoiceHub();hub.publish('manual','Opened the native result.',{appScope:'native'});
 assert.equal(hub.presence(presence('web')),null);assert.equal(hub.presence(presence('native')).id,'manual');
});
