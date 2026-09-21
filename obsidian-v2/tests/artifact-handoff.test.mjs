import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ArtifactHandoff,artifactSpeech,ARTIFACT_CLAIM_LEASE_MS} from '../runner/artifact-handoff.mjs';
import {VoiceHub} from '../runner/voice-hub.mjs';
import {artifactOutcomeSpeech} from '../runner/artifact-speech.mjs';

const output={id:'image-one',taskId:'task',turnId:'turn',path:'system/v2/artifacts/image.png',label:'Diagram',mime:'image/png',bytes:500,open:true};
function fixture(){let state={},time=1000;const config={load:()=>structuredClone(state),save:value=>{state=structuredClone(value)},now:()=>time};const queue=new ArtifactHandoff(config);queue.bind('task',{client:'native-one',provider:'codex',kind:'native',epoch:2});return {queue,reload:()=>new ArtifactHandoff(config),advance:ms=>{time+=ms}}}
const publish=queue=>queue.publish({id:'task'},{id:'turn',artifacts:[output]});

test('an output opens only on the originating surface and only after the context accepts it',()=>{
 const {queue}=fixture();publish(queue);
 assert.equal(queue.claim('web-two'),null);assert.equal(queue.claim('native-one',()=>false),null);
 assert.equal(queue.claim('native-one',target=>target.provider==='codex'&&target.epoch===2).artifact.id,output.id);
 assert.equal(queue.claim('native-one'),null);
});
test('persisted claim survives a lost response or reload without reopening',()=>{
 const f=fixture();publish(f.queue);const claim=f.queue.claim('native-one');
 assert.equal(f.reload().claim('native-one'),null);assert.equal(f.reload().claim('native-reloaded'),null);
 assert.equal(f.reload().ack(claim.id,'native-one',true).fresh,true);
 assert.equal(f.reload().ack(claim.id,'native-one',true).fresh,false);
});
test('failure and duplicate completion retain references but never create another open',()=>{
 const f=fixture();publish(f.queue);const action=f.queue.claim('native-one');
 assert.throws(()=>f.queue.ack(action.id,'other',true),/Unknown/);
 const failure=f.queue.ack(action.id,'native-one',false,'Viewer failed');assert.equal(failure.item.state,'failed');
 assert.equal(publish(f.queue),0);assert.equal(f.reload().claim('native-one'),null);
 assert.equal(failure.item.artifact.path,output.path);
});
test('expired automatic reveal stays retired across reload',()=>{
 const f=fixture();publish(f.queue);f.advance(300001);assert.equal(f.queue.claim('native-one'),null);
 assert.equal(f.reload().items[0].state,'expired');assert.equal(f.reload().items[0].artifact.id,output.id);
});
test('each requested file gets its own confirmed delivery and nonvisual files do not open implicitly',()=>{
 const {queue}=fixture();queue.publish({id:'task'},{id:'turn',artifacts:[output,{...output,id:'second',path:'system/v2/artifacts/second.png'},{...output,id:'note',open:false}]});
 const first=queue.claim('native-one'),second=queue.claim('native-one');assert.notEqual(first.id,second.id);
 assert.equal(queue.claim('native-one'),null);queue.remove('task');assert.deepEqual(queue.items,[]);
});
test('speech distinguishes saved, displayed and failed without trusting worker prose',()=>{
 assert.equal(artifactSpeech([output],'ready'),'Your image is ready.');
 assert.equal(artifactSpeech([output],'opened','native'),'I opened the image in Obsidian.');
 assert.match(artifactSpeech([output],'failed'),/couldn't open/);
 assert.doesNotMatch(artifactSpeech([output],'ready'),/opened|displayed|open in/);
});

test('confirmed opening preserves its outcome and cannot be swallowed by ordinary task grouping',()=>{
 const hub=new VoiceHub(),{queue}=fixture();
 queue.publish({id:'task'},{id:'turn',artifacts:[output]},"The visual is ready, but the counts weren't independently verified.");
 const item=queue.claim('native-one');
 hub.publish(item.completionId,item.completionText,{kind:'completion',taskId:'task',appScope:'native'});
 hub.publish('other','Another job finished.',{kind:'completion',taskId:'other',appScope:'native'});
 assert.equal(hub.retireCompletion(item.completionId),true);
 hub.publish('confirmed',item.completionText+' '+artifactSpeech([output],'opened','native'),{kind:'artifact-confirmation',taskId:'task',appScope:'native'});
 hub.presence({id:'native-one',kind:'native',visible:true,mode:'idle',focus:true,claim:false});
 const first=hub.presence({id:'native-one',kind:'native',visible:true,mode:'idle'});hub.ack(first.id,'native-one',true);
 const second=hub.presence({id:'native-one',kind:'native',visible:true,mode:'idle'});
 const confirmation=[first,second].find(item=>item.id==='confirmed');assert.match(confirmation.text,/weren't independently verified/);assert.match(confirmation.text,/opened the image/);
});

test('dispatch without a live originating app clears a previous destination',()=>{
 const {queue}=fixture();queue.bind('task',null);assert.equal(publish(queue),0);assert.equal(queue.claim('native-one'),null);
});

test('a lost viewer acknowledgement fails at the exact claim lease boundary, retaining the saved file',()=>{
 const f=fixture();publish(f.queue);f.queue.claim('native-one');
 f.advance(ARTIFACT_CLAIM_LEASE_MS-1);f.queue.sweep();assert.equal(f.queue.items[0].state,'claimed');
 f.advance(1);f.queue.sweep();const item=f.reload().items[0];
 assert.equal(item.state,'failed');assert.equal(item.completedAt,61000);assert.equal(item.outcomePending,true);
 assert.equal(item.artifact.path,output.path);assert.match(item.error,/did not confirm/);
 assert.equal(f.reload().claim('native-one'),null);assert.equal(f.reload().claim('native-reloaded'),null);
});

test('restarting the bridge does not renew an existing viewer lease',()=>{
 const f=fixture();publish(f.queue);f.queue.claim('native-one');f.advance(59000);
 const restarted=f.reload();restarted.sweep();assert.equal(restarted.items[0].state,'claimed');
 f.advance(1000);restarted.sweep();assert.equal(f.reload().items[0].state,'failed');
});

test('late and duplicate acknowledgements cannot change a timed-out delivery or reopen it',()=>{
 const f=fixture();publish(f.queue);const claim=f.queue.claim('native-one');f.advance(ARTIFACT_CLAIM_LEASE_MS);
 for(const ok of [true,false,true]){const result=f.queue.ack(claim.id,'native-one',ok);assert.equal(result.fresh,false);assert.equal(result.item.state,'failed')}
 assert.equal(f.queue.claim('native-one'),null);assert.equal(publish(f.queue),0);
});

test('viewer acknowledgement just before expiry remains successful and emits no timeout',()=>{
 const f=fixture();publish(f.queue);const claim=f.queue.claim('native-one');f.advance(ARTIFACT_CLAIM_LEASE_MS-1);
 assert.equal(f.queue.ack(claim.id,'native-one',true).fresh,true);f.advance(100000);f.queue.sweep();
 assert.equal(f.reload().items[0].state,'opened');assert.equal(f.reload().items[0].outcomePending,undefined);
});

test('older claimed records without a claim timestamp use their original creation time',()=>{
 const f=fixture();publish(f.queue);f.queue.claim('native-one');delete f.queue.items[0].claimedAt;f.queue.persist();
 f.advance(ARTIFACT_CLAIM_LEASE_MS);const restarted=f.reload();restarted.sweep();assert.equal(restarted.items[0].state,'failed');
});

// Execute the real bridge wiring with a fake timer and durable in-memory stores.
// No ports, providers, speech service, file viewer or live vault are involved.
const bridgeSource=fs.readFileSync(new URL('../runner/bridge.mjs',import.meta.url),'utf8');
const bridgeHandoff=bridgeSource.slice(bridgeSource.indexOf('const artifacts=new ArtifactHandoff('),bridgeSource.indexOf('function artifactTarget('));
const createBridgeHandoff=new Function('deps',`const {ArtifactHandoff,readJson,writeJson,root,ROOT,hub,artifactSpeech,artifactOutcomeSpeech,setInterval,lifecycle}=deps;${bridgeHandoff};return {artifacts,artifactTimer}`);
function bridgeFixture(){
 let time=1000,state={},audio=[],tick,delay,writes=0,unrefs=0,failFinalSave=false;const events=[];
 const config={load:()=>structuredClone(state),save:value=>{writes++;if(failFinalSave&&value.items.some(item=>item.outcomePending===false)){failFinalSave=false;throw new Error('Simulated bridge crash before the receipt write')}state=structuredClone(value)},now:()=>time};
 const open=()=>{
  const hub=new VoiceHub({now:()=>time,load:()=>structuredClone(audio),save:value=>{audio=structuredClone(value)}});
  class FakeClockHandoff extends ArtifactHandoff{constructor(options){super({...options,...config})}}
  const {artifacts}=createBridgeHandoff({ArtifactHandoff:FakeClockHandoff,root:'fixture',ROOT:'fixture',readJson:()=>assert.fail('Replaced by fixture'),writeJson:()=>assert.fail('Replaced by fixture'),hub,artifactSpeech,artifactOutcomeSpeech,lifecycle:{mark:event=>events.push(event)},setInterval:(fn,ms)=>{tick=fn;delay=ms;return {unref(){unrefs++}}}});
  return {queue:artifacts,hub};
 };
 return {open,advance:ms=>{time+=ms},tick:()=>tick(),delay:()=>delay,writes:()=>writes,unrefs:()=>unrefs,events,failFinalSave:()=>{failFinalSave=true},state:()=>structuredClone(state)};
}
function publishClaimed({queue,hub}){
 queue.bind('task',{client:'native-one',provider:'codex',kind:'native',epoch:2});
 queue.publish({id:'task'},{id:'turn',artifacts:[output]},'The image is ready.');
 hub.publish('task:turn','The image is ready.',{appScope:'native',kind:'completion',taskId:'task'});
 return queue.claim('native-one');
}

test('persisted completion text from older releases cannot reintroduce display claims after a lost ack',()=>{
 const f=bridgeFixture(),bridge=f.open(),claim=publishClaimed(bridge);
 bridge.queue.items[0].completionText='The graphic is now open in the dashboard.';bridge.queue.persist();
 f.advance(ARTIFACT_CLAIM_LEASE_MS);f.tick();
 const spoken=bridge.hub.items.find(item=>item.id===`artifact:${claim.id}`).text;
 assert.match(spoken,/ready to view/);assert.match(spoken,/couldn't open/);assert.doesNotMatch(spoken,/open in the dashboard/);
});

test('the bridge sweep settles a lost ack without another client poll and publishes failure speech exactly once',()=>{
 const f=bridgeFixture(),bridge=f.open(),claim=publishClaimed(bridge);assert.equal(f.delay(),5000);assert.equal(f.unrefs(),1);
 f.advance(ARTIFACT_CLAIM_LEASE_MS);f.tick();f.tick();
 const outcome=bridge.hub.items.filter(item=>item.id===`artifact:${claim.id}`);
 assert.equal(outcome.length,1);assert.equal(outcome[0].kind,'completion-error');assert.equal(outcome[0].appScope,'native');
 assert.match(outcome[0].text,/couldn't open/);assert.doesNotMatch(outcome[0].text,/I opened/);
 assert.equal(bridge.queue.items[0].state,'failed');assert.equal(bridge.queue.items[0].outcomePending,false);
 assert.equal(bridge.hub.items.find(item=>item.id==='task:turn').retiredReason,'artifact-confirmed');
 assert.equal(bridge.queue.ack(claim.id,'native-one',true).fresh,false);assert.equal(bridge.hub.items.filter(item=>item.id===`artifact:${claim.id}`).length,1);
 const writes=f.writes();f.tick();assert.equal(f.writes(),writes,'Stable sweeps must not rewrite durable files');
});

test('pending failure speech survives restart after publication without duplicate speech or file delivery',()=>{
 const f=bridgeFixture(),bridge=f.open(),claim=publishClaimed(bridge);
 f.failFinalSave();f.advance(ARTIFACT_CLAIM_LEASE_MS);f.tick();
 assert.deepEqual(f.events,['artifact-sweep-failed']);assert.equal(f.state().items[0].outcomePending,true);
 const restarted=f.open();f.tick();f.tick();
 assert.equal(restarted.queue.items[0].outcomePending,false);assert.equal(restarted.hub.items.filter(item=>item.id===`artifact:${claim.id}`).length,1);
 assert.equal(restarted.queue.claim('native-one'),null);assert.equal(restarted.queue.ack(claim.id,'native-one',true).fresh,false);
});

test('a failed outcome callback is retried from its durable pending receipt',()=>{
 let state={},time=1000,attempts=0;const options={load:()=>structuredClone(state),save:value=>{state=structuredClone(value)},now:()=>time,onExpired:()=>{attempts++;if(attempts===1)throw new Error('Speech queue unavailable')}};
 const queue=new ArtifactHandoff(options);queue.bind('task',{client:'native-one',kind:'native'});publish(queue);queue.claim('native-one');
 time+=ARTIFACT_CLAIM_LEASE_MS;assert.throws(()=>queue.sweep(),/Speech queue unavailable/);assert.equal(state.items[0].outcomePending,true);
 const restarted=new ArtifactHandoff(options);restarted.sweep();restarted.sweep();assert.equal(attempts,2);assert.equal(state.items[0].outcomePending,false);
});
