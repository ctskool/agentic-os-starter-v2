import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {once,EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {LiveCalls} from '../runner/live/calls.mjs';
import {liveSnapshot} from '../runner/live/snapshot.mjs';
import {localDate} from '../runner/brief-voice.mjs';
import {createLiveBridge} from '../runner/live/routes.mjs';
import {clientStopReason} from '../runner/live/call-log.mjs';
import {LiveRecovery} from '../runner/live/recovery.mjs';
import {createLiveTransport} from '../runner/live/transport.mjs';
import {LiveUsage,liveEstimate} from '../runner/live/usage.mjs';
import {LiveUpdates} from '../runner/live/updates.mjs';
import {VoiceHub} from '../runner/voice-hub.mjs';
import {attachVoiceEvents} from '../runner/voice-events.mjs';
import {acceptsBridgeToken} from '../runner/bridge-auth.mjs';
import {voiceRequestId as uuid} from '../runner/voice-request.mjs';
import {LIVE_PREF_DEFAULTS} from '../shared/live-prefs.mjs';
import {ROOT} from '../shared/contract.mjs';
import {readJson} from '../runner/bridge-core.mjs';
import {writeJson} from '../runner/core.mjs';
import {voiceReceiptTransport} from '../runner/voice-receipts.mjs';
import {manualClock} from './live-test-clock.mjs';

const key=['sk','test','call_fixture_key_123456789'].join('-');
function temporary(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'live-calls-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
const flush=()=>new Promise(resolve=>setTimeout(resolve,20));
const until=async predicate=>{
 const deadline=performance.now()+10000;
 while(performance.now()<deadline){const result=predicate();if(result)return result;await delay(5)}
 throw new Error('Timed out waiting for the loopback fixture');
};
function emit(socket,event){
 const body=Buffer.from(JSON.stringify(event));
 const header=body.length<126?Buffer.from([0x81,body.length]):Buffer.from([0x81,126,body.length>>8,body.length&255]);
 if(!socket.destroyed)socket.write(Buffer.concat([header,body]));
}
// HTTP and the actual Node WebSocket client only connect to this test listener.
async function openAI(t,root,options={}){
 const requests=[],attaches=[],commands=[],sockets=new Set(),peer=new Map();
 let seq=0;
 const server=http.createServer(async(req,res)=>{
  if(req.url!=='/v1/live/sessions'||req.method!=='POST'||req.headers.authorization!=='Bearer '+key){res.writeHead(401).end();return}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks)),id='fixture-session-'+(requests.length+1);requests.push(body);
  if(options.onCreate&&!await options.onCreate({req,res,id}))return;
  res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({session:{id},transport:{sdp:'fixture answer'}}));
 });
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{})});
 server.on('upgrade',(req,socket)=>{
  const [,id]=/^\/v1\/live\/sessions\/([^/]+)\/attach$/.exec(req.url)||[];
  if(!id||req.headers.authorization!=='Bearer '+key){socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');return}
  let persisted=false;try{persisted=JSON.parse(fs.readFileSync(path.join(root,'live-call.json'),'utf8')).id===id}catch{}
  const attach={id,persisted,socket,accepted:false};attaches.push(attach);
  const accept=()=>{
   if(socket.destroyed)return;
   const proof=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
   socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: '+proof+'\r\n\r\n');
   attach.accepted=true;peer.set(id,socket);
  };
  if(options.onAttach)options.onAttach(attach,accept);else accept();
  let incoming=Buffer.alloc(0);
  socket.on('data',chunk=>{
   incoming=Buffer.concat([incoming,chunk]);
   while(incoming.length>=6){
    if(incoming.length<2)return;
    // 7-bit and 16-bit payload lengths (the Live switch note is longer than 125 bytes).
    const opcode=incoming[0]&15,masked=!!(incoming[1]&128),short=incoming[1]&127;
    if(short===127)return;
    const wide=short===126;if(wide&&incoming.length<4)return;
    const size=wide?incoming.readUInt16BE(2):short,head=wide?4:2,offset=head+(masked?4:0);
    if(incoming.length<offset+size)return;
    const content=Buffer.from(incoming.subarray(offset,offset+size));
    if(masked)for(let index=0;index<size;index++)content[index]^=incoming[head+index%4];
    incoming=incoming.subarray(offset+size);
    if(opcode===8){socket.end();return}
    if(opcode!==1)continue;
    let command;try{command=JSON.parse(content)}catch{continue}
    commands.push({id,command});
    if(command.type==='session.close'&&options.confirmClose!==false)emit(socket,{type:'session.closed',event_id:'closed-'+(++seq),usage:{seconds:60,active_seconds:30,paused_seconds:30}});
   }
  });
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve))});
 const httpOrigin='http://127.0.0.1:'+server.address().port;
 return {transport:createLiveTransport({httpOrigin}),requests,attaches,commands,
  event:(type,fields={},id='fixture-session-1')=>emit(peer.get(id),{type,event_id:'event-'+(++seq),...fields}),
  drop:id=>peer.get(id||'fixture-session-1').destroy()};
}
async function fixture(t,options={}){
 const root=temporary(t),api=await openAI(t,root,options),deadlines=manualClock(0);
 let time=Date.now(),owner=true,busy=false,provider='claude',authorized=true,hold=0,release=0;
 // The greeting has its own tests; other tests count exact sideband commands.
 const prefs={...LIVE_PREF_DEFAULTS,voiceMode:'live',liveGreeting:options.greeting??false};
 const deps={root,runtimeDir:root,transport:api.transport,ownerIsCurrent:()=>owner,prefs:()=>prefs,provider:()=>provider,localBusy:()=>busy,
  holdAudio:()=>{hold++},releaseAudio:()=>{release++},now:()=>time,snapshot:options.snapshot|| (async()=> 'Fixture snapshot'),history:()=> 'Fixture history',tasks:options.tasks,
  authorization:()=>({ready:authorized,reason:'Live consent required.'}),key:()=>key,schedule:deadlines.schedule,
  limits:{poll:20,backoff:25,...options.limits}};
 const calls=new LiveCalls(deps);
 t.after(()=>calls.shutdown());
 return {root,api,calls,deps,prefs,deadlines,now:()=>time,advance:ms=>{time+=ms},status:()=>({hold,release}),change:values=>{
  if('owner'in values)owner=values.owner;if('busy'in values)busy=values.busy;if('provider'in values)provider=values.provider;if('authorized'in values)authorized=values.authorized;
 },start:()=>calls.start({ownerSurface:'fixture-surface',appScope:'native',sdp:'fixture offer'})};
}

const callLog=root=>{try{return fs.readFileSync(path.join(root,'live-calls.jsonl'),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line))}catch{return []}};

test('every call logs its start and why it ended, naming the failed ownership check, with no secrets',async t=>{
 const f=await fixture(t);f.calls.ownerDetail=()=>({surfaceConnected:true,eventStream:true,checkedInSecondsAgo:3,isOwner:false,ownerIs:'native window',scope:'web'});
 await f.start();f.api.event('session.started');await until(()=>f.calls.call.ready);
 f.advance(42000);f.change({owner:false});f.calls.sweep();
 await until(()=>callLog(f.root).some(row=>row.event==='end'));
 const [start,end]=callLog(f.root);
 assert.equal(start.event,'start');assert.equal(start.appScope,'native');assert.equal(start.call,end.call);
 assert.equal(end.reason,'The call window disconnected.');assert.equal(end.secondsIn,42);assert.equal(end.ready,true);
 assert.deepEqual(end.owner,{surfaceConnected:true,eventStream:true,checkedInSecondsAgo:3,isOwner:false,ownerIs:'native window',scope:'web',voiceMode:'live'});
 assert.doesNotMatch(JSON.stringify(callLog(f.root)),/fixture-session|secret|sk-/i);
 assert.equal(clientStopReason(undefined),'hung up');assert.equal(clientStopReason('Live audio connection was lost.'),'Live audio connection was lost.');
 assert.equal(clientStopReason('x'.repeat(500)).length,120);assert.equal(clientStopReason('<script>"'),'script');
});

test('Live creation and refresh use the injected Work drawer and keep About me paragraphs',async t=>{
 const scopes=[];
 const f=await fixture(t,{snapshot:(root,options)=>liveSnapshot(root,{...options,usage:{}}),
  tasks:scope=>{scopes.push(scope);return [{title:'Fixture work title',provider:'codex',state:'working',lastActivityAt:f.now()}]}});
 const profile=path.join(f.root,'AGENTS.md'),first='First paragraph '+ 'context '.repeat(100).trim();
 fs.writeFileSync(profile,`## About me\n${first}\n\nNews (a phrase in the user profile)\nOriginal second paragraph`);
 await f.start();f.api.event('session.started');await until(()=>f.calls.call.ready);
 assert.match(f.api.requests[0].session.instructions,/Fixture work title \(Codex, working, 0 min\)/);
 assert.deepEqual(scopes,['native']);
 fs.writeFileSync(profile,`## About me\n${first}\n\nNews (a phrase in the user profile)\nChanged second paragraph`);
 f.prefs.liveShareWork=false;f.advance(10001);f.calls.refreshSnapshot(f.calls.call);
 await until(()=>f.api.commands.some(({command})=>command.content?.includes('Changed second paragraph')));
 const refresh=f.api.commands.find(({command})=>command.content?.includes('Changed second paragraph')).command.content;
 assert.match(refresh,/^Background refresh of the snapshot, for reference only\. Don't bring it up unless the user asks about it\.\nAbout the user \(/);
 const sent=f.api.commands.filter(({command})=>command.type==="session.thinking.append").map(({command})=>command.content);
 const about=sent.filter(content=>/\nAbout the user \(/.test(content)).join('\n');
 assert.match(about,/First paragraph/);assert.match(about,/News \(a phrase in the user profile\)\nChanged second paragraph/);
 assert.ok(sent.some(content=>/^Background refresh[^\n]*\nWork in progress is no longer in the vault snapshot/.test(content)));
 assert.ok(sent.every(content=>Buffer.byteLength(content)<=1000),"each update fits the append limit");
 assert.doesNotMatch(refresh,/Fixture work title|Original second paragraph/);
 assert.deepEqual(scopes,['native']);
});

test('a morning brief saved again during a call is reported, not resent',async t=>{
 const f=await fixture(t,{snapshot:(root,options)=>liveSnapshot(root,{...options,usage:{}})});
 f.prefs.liveShareBrief=true;
 const file=path.join(f.root,'inbox','research','morning-intel',localDate(new Date(f.now()))+'-intel.md'),note='This note changed during the call';
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'## Inbox\n- First sponsor pitch');
 await f.start();f.api.event('session.started');await until(()=>f.calls.call.ready);
 assert.match(f.api.requests[0].session.instructions,/Morning brief \(.*\)\n## Inbox\n- First sponsor pitch/);
 fs.writeFileSync(file,'## Inbox\n- First sponsor pitch\n- Second sponsor pitch');
 f.advance(10001);f.calls.refreshSnapshot(f.calls.call);
 await until(()=>f.api.commands.some(({command})=>command.content?.includes(note)));
 const refresh=f.api.commands.find(({command})=>command.content?.includes(note)).command.content;
 assert.match(refresh,/^Morning brief \(.*\)\nThis note changed during the call, so the copy from the start of the call may be out of date\.$/m);
 assert.doesNotMatch(refresh,/sponsor pitch/);
});

test('Live create persists the ID before bearer-authenticated attach and waits for that attach before answering',async t=>{
 let finishAttach;
 const f=await fixture(t,{onAttach:(_attach,accept)=>{finishAttach=accept}});f.prefs.liveVoice='cedar';f.prefs.liveCarryToday=true;
 let answered=false;
 const initial=f.start().then(answer=>{answered=true;return answer});
 await until(()=>finishAttach);assert.equal(answered,false);assert.equal(f.api.attaches[0].persisted,true);
 finishAttach();const answer=await initial;
 assert.equal(answer.answerSdp,'fixture answer');assert.equal(answer.callSecret.length,64);
 const payload=f.api.requests[0];assert.deepEqual(payload.transport,{type:'webrtc',sdp:'fixture offer'});
 assert.equal(payload.session.store,false);assert.deepEqual(payload.session.client.data_channel.allowed_client_events,[]);
 assert.deepEqual(payload.session.wake_policy,{type:'speech'});assert.equal(payload.session.idle_timeout_s,60);
 assert.equal(payload.session.delegation.acknowledgement_delay_ms,700);
 assert.equal(payload.session.audio.output.voice,'cedar');assert.match(payload.session.instructions,/Fixture snapshot/);assert.equal(payload.session.input,undefined);assert.match(payload.session.instructions,/Fixture history/);
 const call=f.calls.owner('fixture-surface','native',answer.callSecret);
 assert.equal(f.calls.status(call).ready,false);
 // A missing session.started is harmless if a positive replay event arrives.
 f.api.event('session.usage.updated',{usage:{seconds:30}});
 await until(()=>call.ready);
 assert.equal((await call.updates.poll(0)).events[0].type,'ready');
 assert.deepEqual(f.calls.status(null),{state:'in-progress',message:'Live call in Obsidian'});
 f.api.event('session.delegation.created',{event_id:'same-event',delegation:{id:'one'}});
 f.api.event('session.delegation.created',{event_id:'same-event',delegation:{id:'should-not-exist'}});
 f.api.event('session.usage.updated',{event_id:'dedupe-tail',usage:{seconds:30}});
 await until(()=>call.seen.has('dedupe-tail'));
 const disk=new LiveRecovery(f.root),requestId=disk.register('fixture-session-1','one');
 assert.equal(disk.delegations.size,1);assert.equal(uuid(requestId),true);
 assert.equal(new LiveRecovery(f.root).register('fixture-session-1','one'),requestId);
 await f.calls.invalidate('Finished');
 assert.equal(f.calls.usage.rows.get('fixture-session-1').state,'final');
 assert.equal(f.calls.recovery.delegations.size,0);
 assert.deepEqual(f.status(),{hold:1,release:1});
});

test('Live start refuses consent, mode, ownership, Local overlap, and unresolved calls',async t=>{
 const f=await fixture(t,{confirmClose:false});
 f.change({authorized:false});await assert.rejects(f.start(),/consent/i);
 f.change({authorized:true});f.prefs.voiceMode='local';await assert.rejects(f.start(),/Select Live/);
 f.prefs.voiceMode='live';f.change({owner:false});await assert.rejects(f.start(),/voice owner/);
 f.change({owner:true,busy:true});await assert.rejects(f.start(),/Local voice/);f.change({busy:false});
 assert.equal(f.api.requests.length,0);await f.start();
 await assert.rejects(f.start(),/Still closing/);
 const stopped=f.calls.invalidate('Stopped');
 await until(()=>f.api.commands.some(({command})=>command.type==='session.close'));
 f.deadlines.advance(f.calls.limits.close);await stopped;
 await assert.rejects(f.start(),/Still closing/);
 f.advance(7200000);await f.calls.sweep();
 assert.equal(f.calls.recovery.cleanup.length,0);assert.equal(f.calls.usage.rows.get('fixture-session-1').state,'unconfirmed');
});

test('a lost create uses the cooldown and the 15-second estimate without retrying the create',async t=>{
 const f=await fixture(t,{onCreate:async()=>false});
 const timedOut=assert.rejects(f.start(),/unconfirmed/);
 await until(()=>f.api.requests.length===1);f.deadlines.advance(f.calls.limits.create);
 await timedOut;await assert.rejects(f.start(),/cooling down/);
 assert.equal(f.api.requests.length,1);
 const [row]=f.calls.usage.rows.values();assert.equal(row.state,'unconfirmed');assert.equal(row.seconds,15);
 const restart=new LiveCalls(f.deps);await assert.rejects(restart.start({ownerSurface:'fixture',appScope:'native',sdp:'offer'}),/cooling down/);
});
test('an explicit create rejection releases the slot without starting a cooldown',async t=>{
 const f=await fixture(t,{onCreate:async({res})=>{res.writeHead(403).end();return false}});
 await assert.rejects(f.start(),/OpenAI rejected/);
 await assert.rejects(f.start(),/OpenAI rejected/);
 // The first call tries the tool hand-off, then the original one; once refused, later calls go straight to the original.
 assert.deepEqual(f.api.requests.map(body=>body.session.delegation.type),['responses','client','client']);
 assert.equal(f.calls.recovery.call,null);assert.equal(f.calls.usage.rows.size,0);
});

test('a refused tool set-up falls back to the original hand-off, for this call and later ones',async t=>{
 let api;
 const f=await fixture(t,{onCreate:async({res})=>{
  if(api.requests.at(-1).session.delegation.type!=='responses')return true;
  res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:{message:'This key cannot use that model.'}}));return false;
 }});
 api=f.api;
 await f.start();
 assert.deepEqual(f.api.requests.map(body=>body.session.delegation.type),['responses','client']);
 assert.equal(f.calls.call.toolMode,false);assert.equal(f.calls.toolsRefused,true);
});

test('a late create success after owner invalidation persists and closes without returning SDP',async t=>{
 let finishCreate;
 const f=await fixture(t,{onCreate:()=>new Promise(resolve=>{finishCreate=resolve})});
 const refused=assert.rejects(f.start(),/could not be completed/);
 await until(()=>finishCreate);await f.calls.invalidate('Owner changed.');
 assert.deepEqual(f.status(),{hold:1,release:1});
 finishCreate(true);await refused;
 assert.equal(f.api.attaches[0].persisted,true);assert.equal(f.api.commands[0].command.type,'session.close');
 assert.equal(f.calls.recovery.call,null);
});

test('attach timeout, readiness timeout, and closed as the first event all unwind',async t=>{
 await t.test('attach timeout',async t=>{
  const f=await fixture(t,{onAttach:(_attach,accept)=>{if(f.api.attaches.length>1)accept()}});
  const timedOut=assert.rejects(f.start(),/attach timed out/);
  await until(()=>f.api.attaches.length===1);f.deadlines.advance(f.calls.limits.attach);
  await timedOut;assert.equal(f.api.attaches.length,2);assert.equal(f.calls.recovery.call,null);
 });
 await t.test('readiness timeout',async t=>{
  const f=await fixture(t);await f.start();const call=f.calls.call;
  f.deadlines.advance(f.calls.limits.ready);
  await until(()=>!f.calls.call);
  assert.equal(call.ready,undefined);assert.equal(f.api.commands[0].command.type,'session.close');
 });
 await t.test('remote closed first',async t=>{
  const f=await fixture(t);await f.start();const call=f.calls.call;
  f.api.event('session.closed',{usage:{seconds:1}});
  await until(()=>!f.calls.call);
  assert.equal(call.ready,undefined);assert.deepEqual((await call.updates.poll(0)).events.map(event=>event.type),['teardown']);
 });
 await t.test('peer did not connect after readiness',async t=>{
  const f=await fixture(t);await f.start();const call=f.calls.call;
  f.api.event('session.resumed');await until(()=>call.ready);
  f.deadlines.advance(f.calls.limits.peer);
  await until(()=>!f.calls.call);
  assert.ok((await call.updates.poll(0)).events.some(event=>event.type==='teardown'&&/peer/.test(event.reason)));
 });
});

test('sideband loss tears down locally, reattaches to close, and a stale record recovers on boot',async t=>{
 const f=await fixture(t);await f.start();f.api.drop();
 await until(()=>!f.calls.call);assert.equal(f.api.attaches.length,2);assert.equal(f.calls.recovery.call,null);
 const stored={id:'stale-fixture-session',startedAt:f.now(),expiresAt:f.now()+600000};
 new LiveRecovery(f.root).record(stored);
 const restart=new LiveCalls(f.deps);await restart.sweep();assert.equal(restart.recovery.call,null);
 assert.equal(f.api.commands.at(-1).id,stored.id);
});

test('cleanup retries attach after backoff without freeing the slot early',async t=>{
 let rejectClose=true;
 const f=await fixture(t,{onAttach:(_attach,accept)=>{if(f.api.attaches.length===1||!rejectClose)accept()}});
 await f.start();f.api.drop();await until(()=>f.api.attaches.length===2);
 f.deadlines.advance(f.calls.limits.attach);await until(()=>!f.calls.call);
 assert.equal(f.api.attaches.length,2);
 assert.ok(f.calls.recovery.cleanup[0].retryAt>f.now());
 await f.calls.sweep();assert.equal(f.api.attaches.length,2);
 rejectClose=false;f.advance(25);await f.calls.sweep();
 assert.equal(f.api.attaches.length,3);assert.equal(f.calls.recovery.call,null);
 assert.equal(f.calls.usage.rows.get('fixture-session-1').state,'final');
});

test('idle hangup uses transcript activity and rollover signals only when idle',async t=>{
 const f=await fixture(t);
 await f.start();const call=f.calls.call;
 f.api.event('session.started',{expires_at:new Date(f.now()+16*60000).toISOString()});
 await until(()=>call.ready);f.prefs.liveIdleHangupMin=15;
 f.advance(14*60000);f.api.event('session.input_transcript.delta');await until(()=>call.lastTranscriptAt===f.now());
 f.advance(60*1000);f.calls.sweep();
 assert.ok((await call.updates.poll(0)).events.some(event=>event.type==='rollover'));assert.equal(f.calls.call,call);
 await f.calls.invalidate('Test ended.');
 const idle=await fixture(t);await idle.start();idle.api.event('session.paused');
 await until(()=>idle.calls.call?.ready);idle.prefs.liveIdleHangupMin=15;idle.advance(15*60000);idle.calls.sweep();
 assert.equal(idle.calls.audioHeld,false);
});

test('another window taking voice and the 2-hour renewal keep a call up; End call and the idle limit end it',async t=>{
 const f=await fixture(t);f.calls.surfaceAlive=()=>true;
 await f.start();const call=f.calls.call;
 f.api.event('session.started',{expires_at:new Date(f.now()+3*3600000).toISOString()});await until(()=>call.ready);
 assert.equal(f.prefs.liveIdleHangupMin,30,'30 minutes is the default');
 f.change({owner:false});
 for(let minute=0;minute<120;minute+=10){f.advance(600000);f.api.event('session.input_transcript.delta');await until(()=>call.lastTranscriptAt===f.now());f.calls.sweep()}
 assert.equal(f.calls.call,call);assert.equal(f.calls.audioHeld,true);
 // Mid-sentence near the expiry: renewal waits for a pause until the last 20 seconds, then renews anyway.
 f.advance(3600000-50000);f.api.event('session.input_transcript.delta');await until(()=>call.lastTranscriptAt===f.now());f.calls.sweep();
 assert.ok(!(await call.updates.poll(0)).events.some(event=>event.type==='rollover'));
 f.advance(31000);f.api.event('session.input_transcript.delta');await until(()=>call.lastTranscriptAt===f.now());f.calls.sweep();
 assert.ok((await call.updates.poll(0)).events.some(event=>event.type==='rollover'));assert.equal(f.calls.call,call);
 await f.calls.invalidate('Window: hung up');
 assert.equal(callLog(f.root).filter(row=>row.event==='end').at(-1).reason,'Window: hung up');
});

test('owner changes and voice-mode changes bump generation and release audio',async t=>{
 for(const change of [f=>f.change({owner:false}),f=>{f.prefs.voiceMode='local'}]){
  const f=await fixture(t);const answer=await f.start();change(f);f.calls.sweep();
  assert.ok(f.calls.gen>answer.gen);assert.equal(f.calls.audioHeld,false);
  await until(()=>!f.calls.call);
 }
});

test('a provider switch keeps the Live call, moves new hand-offs and tells Live quietly',async t=>{
 const f=await fixture(t);const answer=await f.start();const call=f.calls.call;
 f.change({provider:'codex'});f.calls.sweep();
 assert.equal(f.calls.gen,answer.gen);assert.equal(f.calls.call,call);assert.equal(f.calls.current(call),true);
 const before=f.api.commands.length;
 f.calls.switchProvider(call,'codex');
 assert.equal(call.provider,'codex');
 await until(()=>f.api.commands.length>before);
 const note=f.api.commands.at(-1).command;
 assert.equal(note.type,'session.thinking.append');assert.equal(note.delegation_id,null);assert.match(note.content,/switched hand-offs to Codex/);
 f.calls.switchProvider(call,'codex');assert.equal(f.api.commands.length,before+1,'a repeat switch stays quiet');
 assert.ok(!f.api.commands.some(entry=>entry.command.type==='session.close'));
});

test('a started call greets the user once, by voice, after the session and the audio are both up',async t=>{
 const f=await fixture(t,{greeting:true});await f.start();const call=f.calls.call;
 f.api.event('session.started');await until(()=>call.ready);
 const greetings=()=>f.api.commands.filter(({command})=>command.type==='session.commentary.append'&&command.delegation_id===null);
 assert.equal(greetings().length,0,'no greeting before the audio is connected');
 f.calls.peerConnected(call);
 await until(()=>greetings().length===1);
 assert.match(greetings()[0].command.content,/what|ready|help|need/i);
 // A bare line made GPT-Live invent a user turn and answer it; the cue says the line, then waits.
 assert.match(greetings()[0].command.content,/^The call just connected and the user has not spoken yet\. Greet them by saying exactly "[^"]+" Then stop talking and wait for them\./);
 f.calls.peerConnected(call);f.api.event('session.resumed');f.calls.sweep();
 await flush();assert.equal(greetings().length,1,'never twice in one call');
});

test('the greeting stays silent when the user turned it off',async t=>{
 const f=await fixture(t,{greeting:false});await f.start();const call=f.calls.call;
 f.api.event('session.started');await until(()=>call.ready);f.calls.peerConnected(call);
 await flush();
 assert.ok(!f.api.commands.some(({command})=>command.type==='session.commentary.append'));
});

test('a rollover replacement does not greet again',async t=>{
 const f=await fixture(t,{greeting:true});await f.start();const old=f.calls.call;
 f.api.event('session.started',{expires_at:new Date(f.now()+50000).toISOString()});
 await until(()=>old.ready);f.calls.peerConnected(old);
 const greetings=()=>f.api.commands.filter(({command})=>command.type==='session.commentary.append'&&command.delegation_id===null);
 await until(()=>greetings().length===1);
 f.api.event('session.paused');await until(()=>old.paused);f.calls.sweep();
 await f.calls.rollover(old,'replacement offer');const next=f.calls.replacement;
 f.api.event('session.resumed',{},next.sessionId);await until(()=>next.ready);f.calls.peerConnected(next);
 await until(()=>f.calls.call===next);await flush();
 assert.equal(greetings().length,1);
});

test('a failed rollover closes only the candidate and keeps the existing lease active',async t=>{
 const f=await fixture(t);await f.start();
 const old=f.calls.call;
 f.api.event('session.started',{expires_at:new Date(f.now()+50000).toISOString()});
 f.api.event('session.paused');
 await until(()=>old.ready&&old.paused);f.calls.peerConnected(old);f.calls.sweep();
 await f.calls.rollover(old,'replacement offer');
 const candidate=f.calls.replacement;
 assert.equal(f.calls.recovery.call.id,old.sessionId);
 assert.ok(f.calls.recovery.cleanup.some(row=>row.id===candidate.sessionId));
 f.api.event('session.closed',{},candidate.sessionId);
 await until(()=>!f.calls.replacement);
 assert.equal(f.calls.call,old);assert.deepEqual(f.status(),{hold:1,release:0});
 assert.ok((await old.updates.poll(0)).events.some(event=>event.type==='rollover-failed'));
 assert.ok(!f.api.commands.some(call=>call.id===old.sessionId));
 await f.calls.invalidate('Finished test.');
});

test('Live updates time out, allow one poll, and replay until the cursor acknowledges',async()=>{
 const updates=new LiveUpdates(20),wait=updates.poll(0);
 assert.throws(()=>updates.poll(0),/already open/);
 assert.deepEqual(await wait,{cursor:0,events:[]});
 const next=updates.poll(0);updates.push({type:'ready'});
 const first=await next;assert.deepEqual(first,await updates.poll(0));
 const another=updates.poll(first.cursor);updates.push({type:'paused'});
 assert.deepEqual(await another,{cursor:2,events:[{type:'paused',seq:2}]});
 assert.throws(()=>updates.poll(100),/Invalid/);
});

test('usage is cumulative, final is immutable, and the month estimate reports unconfirmed calls',t=>{
 const root=temporary(t),ledger=new LiveUsage(root),now=Date.now();
 ledger.update('one',now,{seconds:60,active_seconds:30,paused_seconds:30});
 ledger.update('one',now,{seconds:10});assert.equal(ledger.rows.get('one').seconds,60);
 const final=ledger.update('one',now,{seconds:60,active_seconds:30,paused_seconds:30},'final');
 assert.equal(ledger.update('one',now,{seconds:120},'final'),final);
 assert.equal(liveEstimate(final),.035);
 ledger.update('two',now,{seconds:15},'unconfirmed');
 assert.equal(new LiveUsage(root).month(now).unconfirmed,1);
 assert.equal(new LiveUsage(root).month(now).usd,.0475);
});

test('the hub refuses new leases and preserves announcement expiry during a call',()=>{
 let now=10000;const broadcast=[],hub=new VoiceHub({now:()=>now,emit:event=>broadcast.push(event)});
 const presence={id:'viewer',kind:'native',visible:true,mode:'idle',focus:true};
 hub.publish('first','Already queued');hub.holdLiveAudio();now+=600000;
 hub.publish('second','Queued during the call');
 assert.equal(hub.presence(presence),null);assert.equal(hub.hasPlaybackLease(),false);
 assert.ok(broadcast.some(event=>event.type==='stop-audio'));
 hub.releaseLiveAudio();assert.equal(hub.presence(presence).id,'first');
 hub.ack('first','viewer',true);assert.equal(hub.presence(presence).id,'second');
});

test('registered surfaces protect presence, focus, leave, artifacts, announcements and Live routes',async t=>{
 const f=await fixture(t),hub=new VoiceHub({onPublish:item=>liveBridge.calls.completion(item)}),listeners=new Map(),active=new Map();
 const liveBridge=createLiveBridge({...f.deps,hub,listeners,active,readEpoch:(provider,scope)=>provider==='claude'&&scope==='web'?3:0});
 t.after(()=>liveBridge.calls.shutdown());
 const token='a'.repeat(64),bridgeAuth={accepts:(method,headers)=>acceptsBridgeToken(method,headers,token)};
 const touched=[],artifacts={claim:()=>{touched.push('claim');return null},ack:()=>{touched.push('ack');return {fresh:false,item:{}}}};
 const bridgeSource=fs.readFileSync(new URL('../runner/bridge.mjs',import.meta.url),'utf8').replace(/\r\n/g,'\n');
 const marker="server.on('request',async(req,res)=>{",start=bridgeSource.indexOf(marker);
 const end=bridgeSource.indexOf('\n});\n{\n // Mint',start);
 const list=dir=>fs.readdirSync(path.join(f.root,ROOT,dir)).map(name=>readJson(f.root,`${ROOT}/${dir}/${name}`,null));
 const handler=new Function('deps',`const {root,origins,bridgeAuth,liveBridge,uuid,body,attachVoiceEvents,listeners,hub,artifacts,readCurrentState,readConversationEpoch,selection,readJson,ROOT,list,voiceReceiptTransport,terminals,speechText}=deps;return async(req,res)=>{${bridgeSource.slice(start+marker.length,end)}\n};`)({
  root:f.root,origins:new Set(),bridgeAuth,liveBridge,uuid,body:async req=>Buffer.from(JSON.stringify(req.payload)),attachVoiceEvents,listeners,hub,artifacts,
  readCurrentState:()=>({}),readConversationEpoch:()=>0,selection:()=>({provider:'claude'}),readJson,ROOT,list,voiceReceiptTransport,terminals:{records:new Map()},speechText:text=>text
 });
 const request=async(route,{payload={},headers={},method='POST'}={})=>{
  const res=Object.assign(new EventEmitter(),{headersSent:false,writableEnded:false,destroyed:false,status:null,value:null,
   setHeader(){},writeHead(status){this.status=status;this.headersSent=true},write(){},end(value){this.writableEnded=true;if(value)this.value=JSON.parse(value)}});
  await handler({url:route,method,payload,headers:{host:'127.0.0.1:3219','x-v2-app':'web','x-v2-token':token,...headers}},res);return res;
 };
 const first=(await request('/voice/surface/register')).value,second=(await request('/voice/surface/register')).value;
 const firstSecret={'x-v2-surface-secret':first.surfaceSecret},secondSecret={'x-v2-surface-secret':second.surfaceSecret};
 const events=client=>'/voice/events?client='+client;
 assert.equal((await request(events(first.surfaceId),{method:'GET',headers:secondSecret})).status,400);
 const sse=await request(events(first.surfaceId),{method:'GET',headers:firstSecret});assert.equal(sse.status,200);
 const presence={id:first.surfaceId,kind:'web',visible:true,mode:'idle',focus:true};
 await request('/voice/surface',{payload:presence,headers:firstSecret});
 const lastHeartbeat=hub.clients.get(first.surfaceId);
 for(const [route,payload] of [
  ['/voice/surface',presence],['/voice/surface',{...presence,focus:false}],
  ['/voice/leave',{id:first.surfaceId}],['/voice/ack',{id:'announcement',client:first.surfaceId,ok:true}],
  ['/artifacts/claim',{client:first.surfaceId,visible:true,mode:'idle'}],['/artifacts/ack',{id:'artifact',client:first.surfaceId,ok:true}],
  ['/voice/live/start',{surfaceId:first.surfaceId,sdp:'offer'}]
 ])assert.ok((await request(route,{payload,headers:secondSecret})).status>=400,route);
 assert.equal(hub.clients.get(first.surfaceId),lastHeartbeat);assert.deepEqual(touched,[]);assert.equal(f.api.requests.length,0);
 await request('/artifacts/claim',{payload:{client:first.surfaceId,visible:true,mode:'idle'},headers:firstSecret});
 await request('/artifacts/ack',{payload:{id:'artifact',client:first.surfaceId,ok:true},headers:firstSecret});
 assert.deepEqual(touched,['claim','ack']);
 const started=(await request('/voice/live/start',{payload:{surfaceId:first.surfaceId,surfaceSecret:first.surfaceSecret,sdp:'offer'}})).value;
 const callHeaders={'x-v2-surface':first.surfaceId,'x-v2-call':started.callSecret};
 assert.equal((await request('/voice/live/status',{method:'GET',headers:{'x-v2-token':undefined}})).status,401);
 assert.deepEqual((await request('/voice/live/status',{method:'GET',headers:secondSecret})).value,{state:'in-progress',message:'Live call in HUD'});
 assert.equal((await request('/voice/live/stop',{headers:secondSecret})).status,403);
 assert.equal((await request('/voice/live/context',{method:'GET',headers:callHeaders})).value.conversationEpoch,3);
 assert.equal((await request('/voice/live/context',{headers:callHeaders,payload:{selection:{provider:'claude',model:'sonnet'},workTarget:null,appScope:'web',conversationEpoch:3,peerConnected:true}})).status,200);
 assert.equal(liveBridge.calls.call.context.conversationEpoch,3);
 for(const route of ['/voice/live/confirm','/voice/live/cancel']){
  const actionId='00000000-0000-4000-8000-000000000004';
  assert.equal((await request(route,{headers:secondSecret,payload:{actionId}})).status,403);
  assert.equal((await request(route,{headers:callHeaders,payload:{actionId}})).status,409);
 }
 assert.equal((await request('/voice/live/mute',{headers:secondSecret,payload:{muted:true}})).status,403);
 assert.equal((await request('/voice/live/mute',{headers:callHeaders,payload:{muted:'on'}})).status,400);
 for(const muted of [true,false,true]){
  assert.equal((await request('/voice/live/mute',{headers:callHeaders,payload:{muted}})).status,200);
 }
 await until(()=>f.api.commands.length===3);
 assert.deepEqual(f.api.commands.map(call=>call.command.type),['session.input_audio.mute','session.input_audio.unmute','session.input_audio.mute']);
 const old=liveBridge.calls.call;
 f.api.event('session.started',{expires_at:new Date(f.now()+50000).toISOString()});
 f.api.event('session.paused');await until(()=>old.ready&&old.paused);liveBridge.sweep();
 assert.equal((await request('/voice/live/rollover',{headers:secondSecret,payload:{sdp:'new offer'}})).status,403);
 const rollover=await request('/voice/live/rollover',{headers:callHeaders,payload:{sdp:'new offer'}});
 assert.equal(rollover.status,200);assert.equal(rollover.value.gen,started.gen+1);assert.equal(rollover.value.callSecret,started.callSecret);
 const next=liveBridge.calls.replacement;
 assert.equal(liveBridge.calls.recovery.call.id,old.sessionId);assert.equal(liveBridge.calls.call,old);
 assert.deepEqual(f.api.requests[1].transport,{type:'webrtc',sdp:'new offer'});
 f.advance(1000);
 f.api.event('session.resumed',{},next.sessionId);await until(()=>next.ready);
 assert.equal(liveBridge.calls.call,old);assert.ok(!f.api.commands.some(call=>call.command.type==='session.close'));
 assert.equal((await request('/voice/live/context',{headers:callHeaders,payload:{selection:{provider:'claude',model:'sonnet'},workTarget:null,appScope:'web',conversationEpoch:3,peerConnected:true,gen:rollover.value.gen}})).status,200);
 assert.equal(liveBridge.calls.call,next);assert.equal(liveBridge.calls.audioHeld,true);
 assert.equal(next.lastTranscriptAt,old.lastTranscriptAt);
 await until(()=>f.api.commands.some(call=>call.id===old.sessionId&&call.command.type==='session.close'));
 assert.ok(f.api.commands.some(call=>call.id===next.sessionId&&call.command.type==='session.input_audio.mute'));
 assert.equal(liveBridge.calls.recovery.call.id,next.sessionId);
 const updated=(await request('/voice/live/updates',{method:'GET',headers:callHeaders})).value;
 assert.ok(updated.events.some(event=>event.type==='ready'&&event.gen===next.gen));
 const runId='00000000-0000-4000-8000-000000000005';
 assert.equal((await request('/voice/announce',{payload:{id:'run:'+runId,text:'Legacy run completion'}})).status,200);
 const notices=(await request('/voice/live/updates?cursor='+updated.cursor,{method:'GET',headers:callHeaders})).value;
 assert.ok(notices.events.some(event=>event.type==='completion'&&event.taskId===runId));
 assert.equal(f.api.commands.some(event=>event.command.type.endsWith('.append')),false);
 writeJson(f.root,`${ROOT}/voice-results/local.json`,{ts:1,transcript:'public Local transcript',reply:'public Local reply',provider:'claude'});
 writeJson(f.root,`${ROOT}/voice-results/live.json`,{ts:2,transcript:'private Live transcript',reply:'private Live reply',provider:'claude',transport:'live'});
 const transcript=await request('/voice/transcript',{method:'GET'});
 assert.match(transcript.value.content,/public Local transcript/);
 assert.doesNotMatch(transcript.value.content,/private Live/);
 sse.emit('close');
 assert.equal((await request('/voice/surface',{payload:presence,headers:firstSecret})).status,400);
 assert.equal(liveBridge.calls.audioHeld,false);
 const ends=callLog(f.root).filter(row=>row.event==='end');
 assert.equal(ends.at(-1).reason,'Voice surface disconnected.');assert.equal(ends.at(-1).appScope,'web');
 const teardown=(await request('/voice/live/updates?cursor='+notices.cursor,{method:'GET',headers:callHeaders})).value;
 assert.ok(teardown.events.some(event=>event.type==='teardown'));
 const legacy='00000000-0000-4000-8000-000000000003';
 const legacyStream=await request(events(legacy),{method:'GET'});assert.equal(legacyStream.status,200);
 assert.equal((await request('/voice/surface',{payload:{...presence,id:legacy}})).status,200);
 assert.ok((await request('/voice/live/start',{payload:{surfaceId:legacy,sdp:'offer'}})).status>=400);
 legacyStream.emit('close');
});

// Chase, 2026-11-26: task news that lands in standby is said in Live's own voice. Only the caller's voice wakes a
// paused session, so the call is renewed and the fresh, awake session says the held news.
test('task news in standby renews the call, the fresh session says it, and a renewal that never comes falls back',async t=>{
 const f=await fixture(t);await f.start();const old=f.calls.call;
 f.api.event('session.started',{expires_at:new Date(f.now()+3*3600000).toISOString()});
 await until(()=>old.ready);f.calls.peerConnected(old);
 f.api.event('session.paused');await until(()=>old.paused);
 assert.equal(old.requestWake(),true);
 assert.ok((await old.updates.poll(0)).events.some(event=>event.type==='rollover'));
 old.answers.speak(null,'Research is done.');assert.equal(old.answers.held.length,1);
 assert.equal(old.requestWake(),false,'one renewal at a time');
 await f.calls.rollover(old,'replacement offer');const next=f.calls.replacement;
 assert.equal(old.requestWake(),true,'a renewal on its way will carry the news');
 f.api.event('session.resumed',{},next.sessionId);await until(()=>next.ready);f.calls.peerConnected(next);
 await until(()=>f.calls.call===next);
 assert.deepEqual(next.answers.held.map(event=>event.content),['Research is done.']);
 f.calls.sweep();
 await until(()=>f.api.commands.some(({id,command})=>id===next.sessionId&&command.type==='session.commentary.append'&&command.content==='Research is done.'));
 await f.calls.invalidate('Finished test.');
 // The window never answered the renewal: after 15 seconds the screen says the news.
 const g=await fixture(t);await g.start();const call=g.calls.call;
 g.api.event('session.started',{expires_at:new Date(g.now()+3*3600000).toISOString()});
 await until(()=>call.ready);g.calls.peerConnected(call);g.api.event('session.paused');await until(()=>call.paused);
 assert.equal(call.requestWake(),true);call.answers.speak(null,'Report is done.');
 g.advance(15000);g.calls.sweep();
 const events=(await call.updates.poll(0)).events;
 assert.ok(events.some(event=>event.type==='announce'));assert.equal(call.answers.held.length,0);
 assert.equal(call.rolloverSent,false,'the 2-hour renewal can still run later');
 await g.calls.invalidate('Finished test.');
});

test('a rate limit or an OpenAI outage does not switch Live to the original hand-off', async t => {
 const f=await fixture(t,{onCreate:async({res})=>{res.writeHead(429,{'Content-Type':'application/json'}).end(JSON.stringify({error:{code:'rate_limit_exceeded',message:'Slow down.'}}));return false}});
 await assert.rejects(f.start(),/OpenAI rejected/);
 assert.deepEqual(f.api.requests.map(body=>body.session.delegation.type),['responses']);
 assert.notEqual(f.calls.toolsRefused,true);
});
