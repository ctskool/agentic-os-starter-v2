import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {VoiceHub} from '../runner/voice-hub.mjs';
const built=await build({entryPoints:['shared/voice-session.ts','shared/voice-surface.ts'],bundle:true,platform:'node',format:'esm',outdir:'unused',write:false});
const modules=await Promise.all(built.outputFiles.map(file=>import('data:text/javascript;base64,'+Buffer.from(file.text).toString('base64'))));
const {VoiceSession}=modules.find(m=>m.VoiceSession),{VoiceSurface}=modules.find(m=>m.VoiceSurface);
const selection={provider:'codex',model:'gpt-5.6-luna'},uuid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function replace(t,key,value){const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});t.after(()=>old?Object.defineProperty(globalThis,key,old):delete globalThis[key])}

test('streamed audio configures CORS, source, and graph before play, and traces only stages for the latest request',async t=>{
 let now=0,graph=false;const setup=[];t.mock.method(performance,'now',()=>now);
 replace(t,'AudioContext',class{state='running';destination={};resume(){now+=1;return Promise.resolve()}close(){return Promise.resolve()}createAnalyser(){return {connect(){},disconnect(){}}}createMediaElementSource(){return {connect(){graph=true;setup.push('graph')},disconnect(){graph=false}}}});
 replace(t,'Audio',class{constructor(...args){assert.equal(args.length,0);setup.push('construct')}set src(value){assert.equal(this.crossOrigin,'anonymous');assert.equal(this.preload,'auto');assert.match(value,/^http:\/\/127\.0\.0\.1:3219\/voice\/speak\?text=/);setup.push('src')}play(){assert.equal(graph,true);setup.push('play');queueMicrotask(()=>{now+=5;this.onplaying?.();queueMicrotask(()=>this.onended?.())});return Promise.resolve()}pause(){}removeAttribute(){}load(){}});
 const voice=new VoiceSession(async(path)=>{assert.equal(path,'/voice/text');now+=10;return {status:200,json:{reply:'Private answer text'}}},async()=>{now+=3;return selection});
 await voice.sendText('Private request text');const first=voice.getTimingTrace();
 assert.deepEqual(setup,['construct','src','graph','play']);
 assert.deepEqual(first.points.map(v=>v.stage),['accepted','ownership-ready','selection-ready','request-start','reply','audio-resume','audio-ready','stream-start','stream-playing','idle']);
 assert.ok(first.points.every((v,i)=>v.ms>=0&&(i===0||v.ms>=first.points[i-1].ms)));assert.doesNotMatch(JSON.stringify(first),/Private|answer text|request text/);
 first.points[0].stage='tampered';assert.equal(voice.getTimingTrace().points[0].stage,'accepted');
 await voice.speak('An unrelated announcement');assert.deepEqual(voice.getTimingTrace().points.map(v=>v.stage),['accepted','ownership-ready','selection-ready','request-start','reply','audio-resume','audio-ready','stream-start','stream-playing','idle']);
 await voice.sendText('Second request');assert.notEqual(voice.getTimingTrace().requestId,first.requestId);assert.equal(voice.getTimingTrace().points.length,10);await voice.destroy();
});

test('cancelled request records cancellation and late transport results cannot append playback stages',async t=>{
 replace(t,'AudioContext',undefined);let complete;const route=new Promise(resolve=>complete=resolve);
 const voice=new VoiceSession(async path=>path==='/voice/text'?route:{status:200},async()=>selection);
 const pending=voice.sendText('Sensitive input');await new Promise(resolve=>setImmediate(resolve));voice.cancel();complete({status:200,json:{reply:'Late reply'}});await pending;
 const trace=voice.getTimingTrace();assert.equal(trace.points.at(-1).stage,'cancelled');assert.ok(!trace.points.some(v=>v.stage==='reply'));assert.doesNotMatch(JSON.stringify(trace),/Sensitive|Late/);await voice.destroy();
});

test('timing metadata rides existing surface presence without separate diagnostic requests',async()=>{
 const calls=[],trace={requestId:uuid,startedAt:100,points:[{stage:'accepted',ms:0}]};
 const surface=new VoiceSurface(async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});return {status:200,json:null}},'native',()=> 'working',async()=>true,()=>{},{},()=>true,()=>trace);
 await surface.focus();await surface.tick();assert.deepEqual(calls.map(v=>v.path),['/voice/surface','/voice/surface']);assert.ok(calls.every(v=>v.body.timingTrace.requestId===uuid));surface.destroy();
});

test('hub bounds and sanitizes trace metadata instead of retaining arbitrary caller content',()=>{
 const hub=new VoiceHub(),request={id:'native',kind:'native',visible:true,mode:'working'};
 hub.presence({...request,timingTrace:{requestId:uuid,startedAt:100,transcript:'secret',points:[{stage:'accepted',ms:0,text:'secret'},{stage:'private prompt',ms:1},{stage:'reply',ms:Infinity},{stage:'reply',ms:-1},{stage:'reply',ms:4},{stage:'audio-ready',ms:3},...Array.from({length:40},(_,i)=>({stage:'stream-start',ms:5+i}))]}});
 const trace=hub.live()[0].timingTrace;assert.ok(trace.points.length<=20);assert.deepEqual(Object.keys(trace),['requestId','startedAt','points']);assert.deepEqual(trace.points.slice(0,2),[{stage:'accepted',ms:0},{stage:'reply',ms:4}]);assert.doesNotMatch(JSON.stringify(trace),/secret|private prompt|Infinity/);
 hub.presence({...request,timingTrace:{requestId:'secret',startedAt:100,points:[]}});assert.equal(hub.live()[0].timingTrace,null);
 hub.presence({...request,timingTrace:{requestId:uuid,startedAt:NaN,points:[]}});assert.equal(hub.live()[0].timingTrace,null);
});

const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve))};
function remoteFixture(t){
 const window=new EventTarget(),document=new EventTarget();document.hidden=false;
 replace(t,'window',window);replace(t,'document',document);replace(t,'AudioContext',undefined);
 let events;replace(t,'EventSource',class{readyState=1;constructor(){events=this}close(){this.readyState=2}});
 const calls=[],voice=new VoiceSession(async(path,options)=>{calls.push({path,body:options?.body});return {status:200,json:path==='/voice/text'?{reply:''}:null}},async()=>selection,'native',{heartbeat:()=>()=>{}});
 voice.connect();t.after(()=>voice.destroy());
 const emit=event=>events.onmessage({data:JSON.stringify({client:voice.surface.id,...event})});
 return {voice,calls,emit,disconnect:()=>events.onerror(),stages:()=>voice.getTimingTrace().points.map(point=>point.stage)};
}

test('remote capture gets fresh metadata and distinguishes timeout, empty input and provider cancellation without dispatching',async t=>{
 const f=remoteFixture(t);await flush();
 f.emit({type:'wake'});const first=f.voice.getTimingTrace();assert.deepEqual(f.stages(),['remote-start']);assert.equal(f.voice.mode,'listening');
 f.emit({type:'wake_timeout'});assert.deepEqual(f.stages(),['remote-start','remote-timeout','cancelled']);assert.equal(f.voice.mode,'idle');
 f.emit({type:'wake'});assert.notEqual(f.voice.getTimingTrace().requestId,first.requestId);f.voice.cancel('provider-change');assert.deepEqual(f.stages(),['remote-start','provider-change']);
 f.emit({type:'wake'});f.emit({type:'transcript',text:'   '});assert.deepEqual(f.stages(),['remote-start','remote-empty','cancelled']);
 await flush();assert.ok(!f.calls.some(call=>['/voice/text','/voice/audio','/voice/cancel'].includes(call.path)),'metadata IDs must not become active request IDs or send cancellation requests');
 assert.deepEqual(Object.keys(f.voice.getTimingTrace()),['requestId','startedAt','points']);
});

test('remote capture records owner loss and connection loss separately, and late transcripts stay ignored',async t=>{
 const f=remoteFixture(t);await flush();
 f.emit({type:'wake'});f.emit({type:'owner',id:'a-different-surface'});assert.deepEqual(f.stages(),['remote-start','owner-change']);
 f.emit({type:'transcript',text:'Never dispatch this old private transcript'});await flush();assert.ok(!f.calls.some(call=>call.path==='/voice/text'));
 f.emit({type:'wake'});f.disconnect();assert.deepEqual(f.stages(),['remote-start','connection-lost']);assert.equal(f.voice.mode,'idle');
 f.emit({type:'transcript',text:'Never dispatch this other private transcript'});await flush();assert.ok(!f.calls.some(call=>call.path==='/voice/text'));
 assert.doesNotMatch(JSON.stringify(f.voice.getTimingTrace()),/private|transcript/);
});

test('remote trace metadata does not change valid transcript dispatch or store captured words',async t=>{
 const f=remoteFixture(t);await flush();f.emit({type:'wake'});const captureId=f.voice.getTimingTrace().requestId;
 f.emit({type:'transcript',text:'A private question for the selected provider'});await flush();
 assert.equal(f.calls.filter(call=>call.path==='/voice/text').length,1);assert.equal(JSON.parse(f.calls.find(call=>call.path==='/voice/text').body).transcript,'A private question for the selected provider');
 assert.notEqual(f.voice.getTimingTrace().requestId,captureId);assert.deepEqual(f.stages(),['accepted','ownership-ready','selection-ready','request-start','reply','idle']);
 assert.doesNotMatch(JSON.stringify(f.voice.getTimingTrace()),/private|selected provider/);assert.equal(f.voice.mode,'idle');
});

function captureFixture(t){
 let now=0,level=0,nextTimer=0,stopped=0;const intervals=new Map(),timers=new Map(),calls=[];
 t.mock.method(performance,'now',()=>now);
 t.mock.method(globalThis,'setInterval',(fn,delay)=>{assert.equal(delay,80);intervals.set(++nextTimer,fn);return nextTimer});
 t.mock.method(globalThis,'clearInterval',id=>intervals.delete(id));
 t.mock.method(globalThis,'setTimeout',(fn,delay)=>{timers.set(++nextTimer,{fn,delay});return nextTimer});
 t.mock.method(globalThis,'clearTimeout',id=>timers.delete(id));
 replace(t,'navigator',{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){stopped++}}]})}});
 replace(t,'AudioContext',class{state='running';destination={};resume(){return Promise.resolve()}close(){return Promise.resolve()}createAnalyser(){return {fftSize:512,getByteTimeDomainData(bytes){bytes.fill(level?160:128)},disconnect(){}}}createMediaStreamSource(){return {connect(){},disconnect(){}}}});
 replace(t,'MediaRecorder',class{state='inactive';start(){this.state='recording'}stop(){this.state='inactive';queueMicrotask(()=>this.onstop?.())}});
 const voice=new VoiceSession(async path=>{calls.push(path);return {status:200,json:{ok:true,reply:''}}},async()=>selection);t.after(()=>voice.destroy());
 return {voice,calls,timers,intervals,tick(at,value){now=at;level=value;for(const fn of intervals.values())fn()},stages:()=>voice.getTimingTrace().points.map(point=>point.stage),get stopped(){return stopped}};
}

test('local capture records the real recorder start and first qualified speech only once',async t=>{
 const f=captureFixture(t);await f.voice.start();assert.equal(f.voice.mode,'listening');assert.deepEqual(f.stages(),['capture-start','ownership-ready','selection-ready','recording-start']);
 f.tick(80,true);f.tick(160,true);assert.ok(!f.stages().includes('speech-detected'));
 f.tick(240,true);f.tick(320,true);assert.equal(f.stages().filter(stage=>stage==='speech-detected').length,1);
 f.voice.cancel('provider-change');assert.equal(f.stages().at(-1),'provider-change');assert.ok(!f.stages().includes('no-speech'));assert.equal(f.stopped,1);
 await flush();assert.ok(!f.calls.includes('/voice/audio'));assert.equal(f.intervals.size,0);
});

test('quiet local capture is distinguishable from provider cancellation without creating an audio request',async t=>{
 const f=captureFixture(t);await f.voice.start();f.tick(100,false);f.tick(5000,false);await flush();
 assert.deepEqual(f.stages(),['capture-start','ownership-ready','selection-ready','recording-start','no-speech','cancelled']);assert.equal(f.voice.mode,'idle');
 assert.deepEqual(f.calls,['/voice/health']);assert.equal(f.stopped,1);assert.equal(f.intervals.size,0);assert.equal(f.timers.size,0);
});
