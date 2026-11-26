import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';

const jiti=createJiti(import.meta.url,{fsCache:false});
const {LiveSession}=jiti('../shared/live-session.ts');
const {VOICE_MIC_CONSTRAINTS}=jiti('../shared/voice-turn-taking.ts');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}};
const flush=()=>new Promise(setImmediate);
async function until(condition){
 for(let attempt=0;attempt<300;attempt++){const value=condition();if(value)return value;await flush()}
 assert.fail('Timed out waiting for the renderer fixture');
}
class Track {
 enabled=true;stopped=false;
 stop(){this.stopped=true}
 clone(){return new Track()}
}
class Stream {
 constructor(tracks=[]){this.tracks=tracks}
 getAudioTracks(){return this.tracks}
 getTracks(){return this.tracks}
}
class Peer extends EventTarget {
 iceGatheringState='gathering';connectionState='new';closed=false;channel={close(){}};offerGeneration;
 constructor(generation){super();this.offerGeneration=generation}
 addTrack(track){this.track=track;assert.equal(track.enabled,false)}
 createDataChannel(name){assert.equal(name,'oai-events');return this.channel}
 async createOffer(){return {type:'offer',sdp:'incomplete'}}
 async setLocalDescription(offer){this.localDescription=offer}
 gather(){
  this.iceGatheringState='complete';this.localDescription={type:'offer',sdp:`final offer ${this.offerGeneration}`};
  this.dispatchEvent(new Event('icegatheringstatechange'));
 }
 async setRemoteDescription(answer){this.answer=answer;this.connectionState='connected';this.onconnectionstatechange?.()}
 data(type){this.channel.onmessage?.({data:JSON.stringify({type})})}
 close(){this.closed=true}
}
function renderer(t,{prefs={},rejectFirstStream=false,pollFailure=false,denyMic=false,blockAudio=false,context=null}={}){
 const mediaStream=Object.getOwnPropertyDescriptor(globalThis,'MediaStream');
 Object.defineProperty(globalThis,'MediaStream',{configurable:true,value:Stream});
 t.after(()=>{if(mediaStream)Object.defineProperty(globalThis,'MediaStream',mediaStream);else delete globalThis.MediaStream});
 const commands=[],peers=[],streams=[],effects=[],errors=[],updates=[],cursors=[],order=[];
 const track=new Track(),wake=new Set();
 let registrations=0,seq=0,closedAudio=false,tick=()=>{},visible=true,started=false,selection={provider:'claude',model:'sonnet',targetId:null},pending=Promise.resolve(),failPoll=pollFailure;
 const json=(value,status=200)=>Response.json(value,{status});
 const emit=(type,data={})=>{updates.push({type,seq:++seq,...data});for(const ready of wake)ready()};
 const fetch=async(path,request={})=>{
  const body=request.body&&JSON.parse(request.body),headers=new Headers(request.headers);
  commands.push({path,body,headers});if(path==='/voice/live/stop')order.push('stop sent');
  if(path==='/voice/live/status')return json({state:started&&headers.has('X-V2-Call')?'active':'idle',authorization:{ready:true}});
  if(path==='/voice/surface/register'){registrations++;return json({surfaceId:'surface-'+registrations,surfaceSecret:'lease-'+registrations})}
  if(path.startsWith('/voice/events?')){
   assert.equal(headers.get('X-V2-Surface-Secret'),'lease-'+registrations);
   if(rejectFirstStream&&registrations===1)return json({},401);
   return new Response(new ReadableStream({start:controller=>streams.push(controller),cancel:()=>{order.push('stream closed')}}));
  }
  if(path==='/voice/surface')assert.equal(body.mode,'live');
  if(path==='/voice/live/start'||path==='/voice/live/rollover'){
   started=true;
   const gen=path.endsWith('start')?1:2;
   assert.equal(body.sdp,`final offer ${gen}`);assert.equal(body.surfaceSecret,'lease-'+registrations);
   assert.equal(peers[gen-1].track.enabled,false);
   return json({answerSdp:'answer-'+gen,callSecret:'private-call',gen});
  }
  if(path==='/voice/live/context'&&!body)return json({conversationEpoch:7});
  if(path==='/voice/live/say')return new Response(new Uint8Array([82,73,70,70]),{headers:{'Content-Type':'audio/wav'}});
  if(path.startsWith('/voice/live/updates?')){
   assert.equal(headers.get('X-V2-Call'),'private-call');
   const cursor=Number(path.split('=')[1]);cursors.push(cursor);
   if(failPoll&&cursor===1){failPoll=false;throw new Error('Selected update response lost')}
   const slice=()=>updates.filter(update=>update.seq>=(pollFailure?cursor:cursor+1));
   // Do not wake just to replay the same event. A response may replay the
   // previous event with the next one if a retry crossed the cursor.
   if(!updates.some(update=>update.seq>cursor))await new Promise(resolve=>{
    const done=()=>{wake.delete(done);request.signal?.removeEventListener('abort',done);resolve()};
    wake.add(done);request.signal?.addEventListener('abort',done,{once:true});if(request.signal?.aborted)done();
   });
   return json({cursor:seq,events:slice()});
  }
  return json({ok:true});
 };
 const session=new LiveSession({
  scope:'web',fetch,media:async constraints=>{
   assert.deepEqual(constraints,VOICE_MIC_CONSTRAINTS);
   if(denyMic)throw new DOMException('Forbidden','NotAllowedError');
   return new Stream([track]);
  },
  peer:()=>{const peer=new Peer(peers.length+1);peers.push(peer);return peer},
  audio:()=>({autoplay:false,srcObject:null,setAttribute(){},pause(){},play:async()=>{if(blockAudio)throw new DOMException('Forbidden','NotAllowedError')}}),
  audioContext:()=>context??{resume:async()=>{},close:async()=>{closedAudio=true}},
  heartbeat:callback=>{tick=callback;return ()=>{}},visible:()=>visible,wait:flush,
  getSelection:async()=>{await pending;return selection}
 });
 session.onEffect=reply=>{effects.push(reply)};session.onError=error=>errors.push(error);
 session.configure({voiceMode:'live',...prefs});t.after(()=>session.destroy());
 const get=route=>commands.filter(entry=>entry.path===route);
 const start=async()=>{
  const answer=session.start();const peer=await until(()=>peers[0]?.localDescription&&peers[0]);
  assert.equal(peer.track.enabled,false);assert.equal(get('/voice/live/start').length,0);
  peer.gather();await answer;return peer;
 };
 const ready=async()=>{emit('ready');await until(()=>session.getSnapshot().ready)};
 return {session,emit,get,peers,streams,effects,errors,cursors,commands,order,start,ready,tick:()=>tick(),hide:()=>{visible=false},
  setSelection:(next,after)=>{pending=after.then(()=>{selection={...selection,...next}})},
  audioClosed:()=>closedAudio};
}

test('Live waits for ICE and bridge readiness before enabling the microphone; teardown releases the peer',async t=>{
 const f=renderer(t),peer=await f.start();
 assert.deepEqual(peer.answer,{type:'answer',sdp:'answer-1'});assert.equal(peer.track.enabled,false);
 await until(()=>f.get('/voice/live/context').some(call=>call.body?.peerConnected));
 assert.equal(peer.track.enabled,false);await f.ready();assert.equal(peer.track.enabled,true);
 f.emit('teardown',{reason:'Owner changed'});
 await until(()=>f.session.getSnapshot().state==='idle');
 assert.equal(peer.closed,true);assert.equal(peer.track.stopped,true);assert.equal(peer.track.enabled,false);assert.equal(f.audioClosed(),true);
});

test('Live retries a registered fetch stream on 401 with a new secret and keeps cursor retries idempotent',async t=>{
 const f=renderer(t,{rejectFirstStream:true,pollFailure:true});await f.start();
 assert.equal(f.get('/voice/surface/register').length,2);
 assert.equal(f.get('/voice/surface')[0].headers.get('X-V2-Surface-Secret'),'lease-2');
 f.emit('effect',{panels:['vitals']});await until(()=>f.cursors.filter(cursor=>cursor===1).length===2);
 f.emit('reply',{reply:{workIds:['task-1']}});await until(()=>f.effects.length===2);
 assert.deepEqual(f.effects.map(reply=>reply.panels??reply.workIds),[['vitals'],['task-1']]);
 assert.deepEqual(f.cursors.slice(0,4),[0,1,1,2]);
});

test('Live renegotiates rollover with the same lease and disables the new microphone until replacement ready',async t=>{
 const f=renderer(t),old=await f.start();await f.ready();
 f.emit('rollover');const next=await until(()=>f.peers[1]?.localDescription&&f.peers[1]);
 assert.equal(f.get('/voice/live/rollover').length,0);assert.equal(next.track.enabled,false);assert.equal(old.track.enabled,true);
 next.gather();await until(()=>f.get('/voice/live/context').some(call=>call.body?.gen===2&&call.body.peerConnected));
 assert.equal(next.track.enabled,false);assert.equal(old.closed,false);
 const [request]=f.get('/voice/live/rollover');
 assert.equal(request.headers.get('X-V2-Call'),'private-call');assert.equal(request.body.surfaceId,'surface-1');
 f.emit('ready',{gen:2});await until(()=>next.track.enabled);
 assert.equal(old.closed,true);assert.equal(old.track.stopped,true);assert.equal(f.get('/voice/surface/register').length,1);
});

test('Live mute posts to the bridge and muted standby wakes from the orb and a surface capture request',async t=>{
 const f=renderer(t,{prefs:{liveIdleMic:'muted'}}),peer=await f.start();await f.ready();
 await f.session.setMuted(true);assert.equal(peer.track.enabled,false);
 peer.data('session.paused');assert.equal(f.session.getSnapshot().state,'muted');
 f.streams[0].enqueue(new TextEncoder().encode('data: {"type":"capture-request","client":"surface-1"}\n\n'));
 await flush();assert.equal(peer.track.enabled,false);
 peer.data('session.resumed');
 await f.session.setMuted(false);assert.equal(peer.track.enabled,true);
 peer.data('session.paused');await until(()=>f.session.getSnapshot().state==='standby');
 assert.equal(peer.track.enabled,false);await f.session.toggle();assert.equal(peer.track.enabled,true);
 peer.data('session.resumed');peer.data('session.paused');await until(()=>f.session.getSnapshot().state==='standby');
 f.streams[0].enqueue(new TextEncoder().encode('data: {"type":"capture-request","client":"surface-1"}\n\n'));
 await until(()=>peer.track.enabled);
 assert.deepEqual(f.get('/voice/live/mute').map(call=>call.body.muted),[true,false,true,false,true,false]);
});

test('Live posts context only after the pending selection write, with the bridge epoch and scope',async t=>{
 const f=renderer(t);await f.start();await f.ready();
 const before=f.get('/voice/live/context').filter(call=>call.body).length,change=deferred();
 f.setSelection({model:'opus',targetId:'new-task'},change.promise);f.session.pushContext();
 await flush();assert.equal(f.get('/voice/live/context').filter(call=>call.body).length,before);
 change.resolve();
 await until(()=>f.get('/voice/live/context').find(call=>call.body?.workTarget==='new-task'));
 assert.deepEqual(f.get('/voice/live/context').at(-1).body,{selection:{provider:'claude',model:'opus'},workTarget:'new-task',appScope:'web',conversationEpoch:7,gen:1,peerConnected:true});
});

test('owner hotkey wakes only a standby-muted microphone and cards use the authenticated action routes',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 const f=renderer(t,{prefs:{liveIdleMic:'muted'}}),peer=await f.start();await f.ready();
 peer.data('session.paused');await until(()=>!peer.track.enabled);
 f.emit('hotkey');await until(()=>peer.track.enabled);
 assert.deepEqual(f.get('/voice/live/mute').map(call=>call.body.muted),[true,false]);
 const staged={actionId:'candidate',description:'Stop the selected task',mode:'click',expiresAt:Date.now()+10000};
 f.emit('staged',staged);await until(()=>f.session.getSnapshot().staged);
 await f.session.action(true);assert.equal(f.get('/voice/live/confirm').at(-1).body.actionId,'candidate');
 f.emit('staged',staged);await until(()=>f.session.getSnapshot().staged);
 await f.session.action(false);assert.equal(f.get('/voice/live/cancel').at(-1).headers.get('X-V2-Call'),'private-call');
 f.emit('staged',{...staged,actionId:'automatic',mode:'auto',expiresAt:Date.now()+2500});
 await until(()=>f.session.getSnapshot().staged?.mode==='auto');
 await f.session.action(true);assert.equal(f.get('/voice/live/confirm').length,1);
 await f.session.action(false);assert.equal(f.get('/voice/live/cancel').at(-1).body.actionId,'automatic');
 f.emit('staged',staged);await until(()=>f.session.getSnapshot().staged);
 t.mock.timers.tick(9999);assert.ok(f.session.getSnapshot().staged);
 t.mock.timers.tick(1);assert.equal(f.session.getSnapshot().staged,null);
 f.emit('completion',{taskId:'one',label:'Task update',text:'Done.'});f.emit('completion',{taskId:'two',label:'Task update',text:'Saved.'});
 await until(()=>f.session.getSnapshot().completions?.length===2);
 const [first]=f.session.getSnapshot().completions;f.session.dismissCompletion(first.seq);
 assert.deepEqual(f.session.getSnapshot().completions.map(card=>card.text),['Saved.']);
 await f.session.report('notes/example.md');
 assert.equal(f.get('/voice/live/report?path=notes%2Fexample.md').at(-1).headers.get('X-V2-Call'),'private-call');
});

test('a hidden tab sends honest presence and keeps the call through a late check-in; only End call ends it',async t=>{
 for(const property of ['window','document']){
  const original=Object.getOwnPropertyDescriptor(globalThis,property);
  Object.defineProperty(globalThis,property,{configurable:true,value:new EventTarget()});
  t.after(()=>{if(original)Object.defineProperty(globalThis,property,original);else delete globalThis[property]});
 }
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 const f=renderer(t);f.session.connect();const peer=await f.start();await f.ready();
 now+=4000;f.hide();f.tick();
 await until(()=>f.get('/voice/surface').some(call=>call.body.visible===false));
 await flush();
 const count=f.get('/voice/surface').length;now+=15001;f.tick();
 await until(()=>f.get('/voice/surface').length>count);
 assert.notEqual(f.session.getSnapshot().state,'idle');assert.equal(peer.closed,false);
 assert.equal(f.get('/voice/live/stop').length,0);
 // The orb or the voice hotkey never hangs up either.
 await f.session.toggle();assert.notEqual(f.session.getSnapshot().state,'idle');assert.equal(f.get('/voice/live/stop').length,0);
 f.session.stop();assert.equal(f.session.getSnapshot().state,'idle');assert.equal(peer.closed,true);
 assert.deepEqual(f.get('/voice/live/stop')[0].body,{});
});

test('losing the registered stream ends the call without redialing',async t=>{
 const f=renderer(t),peer=await f.start();await f.ready();
 f.streams[0].close();await until(()=>peer.closed);
 assert.equal(f.session.getSnapshot().state,'idle');assert.equal(f.get('/voice/live/stop').length,1);
 assert.equal(f.get('/voice/surface/register').length,1);
});

test('Live reports microphone permission denial and blocked autoplay, and releases media',async t=>{
 await t.test('permission denied',async t=>{
  const f=renderer(t,{denyMic:true});await f.session.start();
  assert.match(f.errors[0],/Microphone access was denied/);
  assert.equal(f.get('/voice/surface/register').length,0);assert.equal(f.audioClosed(),true);
 });
 await t.test('autoplay blocked',async t=>{
  const f=renderer(t,{blockAudio:true}),peer=await f.start();
  peer.ontrack({streams:[new Stream()]});await until(()=>f.errors.length);
  assert.match(f.errors[0],/Live audio playback was blocked/);
  assert.equal(peer.closed,true);assert.equal(peer.track.stopped,true);
 });
});

test('hanging up tells the bridge first, then closes the event stream, so the call log keeps the real reason',async t=>{
 const f=renderer(t);await f.start();await f.ready();
 f.session.stop();
 await until(()=>f.order.includes('stream closed'));
 assert.deepEqual(f.order,['stop sent','stream closed']);
 assert.deepEqual(f.get('/voice/live/stop')[0].body,{});
});

test('a task update in standby is played by this screen in the local voice, with the microphone off while it plays',async t=>{
 const sources=[];
 const context={state:'running',destination:{},resume:async()=>{},close:async()=>{},
  decodeAudioData:async bytes=>{assert.equal(bytes.byteLength,4);return {duration:1.5}},
  createBufferSource:()=>{const source={connect(){},disconnect(){},start(){source.started=true},stop(){source.onended?.()}};sources.push(source);return source}};
 const f=renderer(t,{context}),peer=await f.start();await f.ready();
 peer.data('session.paused');await until(()=>f.session.getSnapshot().state==='standby');
 assert.equal(peer.track.enabled,true,'the standby microphone stays open to wake on speech');
 f.emit('announce',{say:4});
 await until(()=>sources[0]?.started);
 const [request]=f.get('/voice/live/say');
 assert.deepEqual(request.body,{seq:4});assert.equal(request.headers.get('X-V2-Call'),'private-call');
 await until(()=>!peer.track.enabled);
 sources[0].onended();await until(()=>peer.track.enabled);
});
