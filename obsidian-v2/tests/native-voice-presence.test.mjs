import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once,EventEmitter} from 'node:events';
import {setTimeout as nodeTimeout} from 'node:timers/promises';
import {build} from 'esbuild';
import {VoiceHub} from '../runner/voice-hub.mjs';
import {attachVoiceEvents} from '../runner/voice-events.mjs';
const output=await build({entryPoints:['shared/voice-session.ts','src/lib/native-voice-heartbeat.ts'],bundle:true,platform:'node',format:'esm',write:false,outdir:'unused'});
const modules=await Promise.all(output.outputFiles.map(f=>import('data:text/javascript;base64,'+Buffer.from(f.text).toString('base64'))));
const {VoiceSession}=modules.find(m=>m.VoiceSession),{nativeVoiceHeartbeat}=modules.find(m=>m.nativeVoiceHeartbeat);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const native={id:'native',kind:'native',visible:false,mode:'idle',version:'0.3.22'},web={id:'web',kind:'web',visible:true,mode:'idle'};
test('event stream exposes heartbeats to clients and stops them on disconnect',t=>{
 let pulse,cleared=false;const timer={unref(){}};
 t.mock.method(globalThis,'setInterval',(callback,ms)=>{assert.equal(ms,10000);pulse=callback;return timer});
 t.mock.method(globalThis,'clearInterval',value=>{assert.equal(value,timer);cleared=true});
 class Response extends EventEmitter {frames=[];writeHead(status){this.status=status}write(frame){this.frames.push(frame)}}
 const response=new Response(),listeners=new Map(),hub=new VoiceHub();attachVoiceEvents('client',response,listeners,hub);
 assert.equal(response.status,200);pulse();assert.equal(response.frames.length,2);
 for(const frame of response.frames)assert.deepEqual(JSON.parse(frame.slice(6).trim()),{type:'heartbeat'});
 response.emit('close');assert.equal(cleared,true);assert.equal(listeners.size,0);
});
function replace(t,key,value){const previous=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});t.after(()=>previous?Object.defineProperty(globalThis,key,previous):delete globalThis[key])}

test('native heartbeats run through Node timers when renderer intervals cannot run, and dispose',async t=>{
 t.mock.method(globalThis,'setInterval',()=>{throw new Error('Renderer interval must not own native presence')});
 let ticks=0,done;const first=new Promise(resolve=>done=resolve),stop=nativeVoiceHeartbeat(()=>{ticks++;done()});t.after(stop);
 await Promise.race([first,nodeTimeout(6000).then(()=>{throw new Error('Native heartbeat did not run')})]);
 assert.equal(ticks,1);stop();
});

test('native VoiceSession forwards its host heartbeat and refreshes immediately on reconnect and visibility changes',async t=>{
 const window=new EventTarget(),document=new EventTarget();document.hidden=true;
 replace(t,'window',window);replace(t,'document',document);let eventStream;
 replace(t,'EventSource',class {constructor(){eventStream=this}close(){this.closed=true}});
 t.mock.method(globalThis,'setInterval',()=>{throw new Error('Unexpected renderer interval')});
 let heartbeat,stops=0;const requests=[],voice=new VoiceSession(async(path,options)=>{requests.push({path,body:JSON.parse(options.body)});return {status:200,json:null}},async()=>({provider:'codex',model:'gpt-6-astra'}),'native',{version:'0.3.22',heartbeat:tick=>{heartbeat=tick;return()=>stops++}});
 voice.connect();await flush();assert.equal(typeof heartbeat,'function');assert.equal(requests[0].body.visible,false);assert.equal(requests[0].body.version,'0.3.22');
 let before=requests.length;heartbeat();await flush();assert.equal(requests.length,before+1);
 before=requests.length;eventStream.onopen();await flush();assert.equal(requests.length,before+1);
 document.hidden=false;document.dispatchEvent(new Event('visibilitychange'));await flush();assert.equal(requests.at(-1).body.visible,true);
 await voice.destroy();assert.equal(stops,1);assert.equal(eventStream.closed,true);before=requests.length;
 heartbeat();eventStream.onopen();document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));await flush();assert.equal(requests.length,before);
});

test('background native hotkey target survives a throttled tick, but expires or leaves without swallowing capture',()=>{
 let now=1;const events=[],hub=new VoiceHub({now:()=>now,emit:event=>events.push(event)});hub.presence(native);hub.presence(web);
 now=60001;hub.presence(web);assert.equal(hub.live().length,2);hub.capture({type:'wake'});assert.equal(events.at(-1).client,'native');
 hub.leave('native');assert.equal(hub.captureOwner,null);const before=events.length;hub.capture({type:'transcript',text:'Do not deliver to a disconnected native surface'});assert.equal(events.length,before);
 hub.capture({type:'wake'});assert.equal(events.at(-1).client,'web');hub.capture({type:'wake_timeout'});
 hub.presence(native);now=150002;hub.presence(web);assert.deepEqual(hub.live().map(c=>c.id),['web']);hub.capture({type:'wake'});assert.equal(events.at(-1).client,'web');
});

test('native liveness grace does not allow a hung speaking surface to retain a completion forever',()=>{
 let now=1;const hub=new VoiceHub({now:()=>now,leaseMs:100});hub.presence({...native,focus:true});hub.publish('first','First');assert.equal(hub.presence(native).id,'first');
 hub.presence({...native,mode:'speaking',playbackId:'first',playbackStarted:true});hub.publish('second','Second');now=102;assert.equal(hub.presence(web).id,'second');assert.ok(hub.items[0].delivered);
});

test('real event-stream disconnection removes native presence immediately on its own loopback server',async t=>{
 const listeners=new Map(),hub=new VoiceHub();let closed;
 const disconnect=new Promise(resolve=>closed=resolve),originalLeave=hub.leave.bind(hub);hub.leave=id=>{originalLeave(id);closed()};
 const server=http.createServer((_req,res)=>attachVoiceEvents('native',res,listeners,hub));server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{for(const res of listeners.values())res.end();server.closeAllConnections();server.close()});
 const request=http.get(`http://127.0.0.1:${server.address().port}`);t.after(()=>request.destroy());const [response]=await once(request,'response');response.resume();
 hub.presence(native);hub.capture({type:'wake'});assert.equal(hub.captureOwner,'native');request.destroy();
 await Promise.race([disconnect,nodeTimeout(2000).then(()=>{throw new Error('Disconnect not observed')})]);assert.equal(hub.live().length,0);assert.equal(hub.captureOwner,null);assert.equal(listeners.size,0);
});

test('a duplicate event stream cannot evict the active surface by knowing its ID',()=>{
 class Response extends EventEmitter {writeHead(status){this.status=status}write(){}end(){this.emit('close')}}
 const listeners=new Map(),hub=new VoiceHub(),old=new Response(),next=new Response();
 attachVoiceEvents('native',old,listeners,hub);hub.presence(native);attachVoiceEvents('native',next,listeners,hub);
 assert.equal(next.status,409);assert.equal(listeners.get('native'),old);assert.equal(hub.live().length,1);old.end();assert.equal(hub.live().length,0);assert.equal(listeners.size,0);
});

test('event disconnect cancels remote capture and ignores its late transcript after reconnect',async t=>{
 replace(t,'window',new EventTarget());const doc=new EventTarget();doc.hidden=true;replace(t,'document',doc);replace(t,'AudioContext',undefined);
 let stream;replace(t,'EventSource',class {constructor(url){stream=this;this.id=new URL(url).searchParams.get('client')}close(){}});
 const requests=[],voice=new VoiceSession(async(path,options)=>{requests.push(path);return {status:200,json:null}},async()=>({provider:'codex',model:'gpt-6-astra'}),'native',{heartbeat:()=>()=>{}});let message='';voice.onMessage=text=>message=text;
 voice.connect();await flush();stream.onmessage({data:JSON.stringify({type:'wake',client:stream.id})});assert.equal(voice.mode,'listening');
 stream.onerror();await flush();assert.equal(voice.mode,'idle');assert.match(message,/connection interrupted/);stream.onopen();
 stream.onmessage({data:JSON.stringify({type:'transcript',client:stream.id,text:'A late request must not run'})});await flush();assert.equal(requests.includes('/voice/text'),false);assert.equal(voice.mode,'idle');
 await voice.destroy();
});

test('focus rejected during an event reconnect never dispatches a request',async t=>{
 replace(t,'window',new EventTarget());const doc=new EventTarget();doc.hidden=false;replace(t,'document',doc);replace(t,'AudioContext',undefined);replace(t,'EventSource',class{close(){}});
 const requests=[],voice=new VoiceSession(async(path,options)=>{requests.push(path);return JSON.parse(options.body)?.focus?{status:503,json:{error:'Voice connection is reconnecting. Try again.'}}:{status:200,json:null}},async()=>({provider:'codex',model:'gpt-6-astra'}),'native',{heartbeat:()=>()=>{}});let message='';voice.onMessage=text=>message=text;
 voice.connect();await flush();await voice.sendText('Do not dispatch without ownership');assert.equal(requests.includes('/voice/text'),false);assert.match(message,/reconnecting/);assert.equal(voice.mode,'error');await voice.destroy();
});
