import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const built=await build({entryPoints:['shared/voice-session.ts'],bundle:true,platform:'node',format:'esm',write:false});
let moduleId=0;
const fresh=async()=>import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text+'\n// isolated runtime '+(++moduleId)).toString('base64'));
const selections=[{provider:'codex',model:'gpt-5.6-luna'},{provider:'claude',model:'haiku'}];
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const flush=async()=>{for(let n=0;n<6;n++)await new Promise(resolve=>setImmediate(resolve))};
function fixture(t){
 let now=0,next=0;const timers=new Map(),intervals=new Map(),sources=[],events=[],contexts=[];
 const replace=(key,value)=>{const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});t.after(()=>old?Object.defineProperty(globalThis,key,old):delete globalThis[key])};
 replace('Audio',undefined);replace('window',undefined);
 t.mock.method(globalThis,'setTimeout',(fn,delay)=>{timers.set(++next,{fn,at:now+delay});return next});
 t.mock.method(globalThis,'clearTimeout',id=>timers.delete(id));
 t.mock.method(globalThis,'setInterval',fn=>{intervals.set(++next,fn);return next});
 t.mock.method(globalThis,'clearInterval',id=>intervals.delete(id));
 class Context{
  state='running';destination={};currentTime=0;decodes=0;
  constructor(){contexts.push(this)}
  resume(){return Promise.resolve()}
  close(){this.state='closed';return Promise.resolve()}
  decodeAudioData(){this.decodes++;return Promise.resolve({duration:.7,name:'answer'})}
  createBufferSource(){const source={buffer:null,stopped:false,connect(){},disconnect(){},start(){events.push('start:answer')},stop(){this.stopped=true;events.push('stop:answer')}};sources.push(source);return source}
  createOscillator(){return {frequency:{},connect(){},disconnect(){},start(){events.push('cue')},stop(){}}}
  createGain(){return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}}}
  createAnalyser(){return {fftSize:512,connect(){},disconnect(){},getByteTimeDomainData(bytes){bytes.fill(128)}}}
  createMediaStreamSource(){return {connect(){},disconnect(){events.push('disconnect-mic')}}}
 }
 replace('AudioContext',Context);
 const advance=async milliseconds=>{now+=milliseconds;for(let pass=0;pass<30;pass++){const due=[...timers].filter(([,v])=>v.at<=now);if(!due.length)break;for(const [id,v] of due){timers.delete(id);v.fn()}await flush()}};
 return {replace,advance,timers,intervals,sources,events,contexts};
}
const audio=()=>({status:200,audio:new Uint8Array([99]).buffer});
const decodes=f=>f.contexts.reduce((sum,context)=>sum+context.decodes,0);

test('both providers accept requests silently and show only one delayed visual progress message',async t=>{
 const f=fixture(t),{VoiceSession}=await fresh();
 for(const selection of selections){
  const pick=deferred(),route=deferred(),calls=[],messages=[];
  const voice=new VoiceSession(async(path,options)=>{calls.push({path,options});return path==='/voice/text'?route.promise:{status:200}},()=>pick.promise);
  voice.onMessage=text=>messages.push(text);const pending=voice.sendText('Explain that headline');
  assert.equal(voice.mode,'working');assert.deepEqual(messages,[]);assert.equal(calls.length,0);assert.deepEqual(f.events,[]);
  pick.resolve(selection);await flush();assert.deepEqual(calls.map(call=>call.path),['/voice/text']);assert.equal(JSON.parse(calls[0].options.headers['X-V2-Selection']).provider,selection.provider);
  await f.advance(3999);assert.deepEqual(messages,[]);await f.advance(1);assert.deepEqual(messages,['Still working on your request…']);await f.advance(4000);assert.equal(messages.length,1);
  assert.equal(f.sources.length,0);assert.equal(decodes(f),0);assert.deepEqual(f.events,[]);assert.ok(!calls.some(call=>call.path==='/voice/speak'));
  route.resolve({status:200,json:{reply:''}});await pending;assert.equal(voice.mode,'idle');await voice.destroy();assert.equal(f.timers.size,0);
 }
});

test('connecting idle sessions never synthesizes, decodes or plays receipt clips',async t=>{
 const f=fixture(t),{VoiceSession}=await fresh(),calls=[];
 const sessions=selections.map(selection=>new VoiceSession(async(path,options)=>{calls.push({path,options});return audio()},async()=>selection));
 for(const voice of sessions){voice.connect();voice.connect()}
 await f.advance(30000);assert.equal(calls.length,0);assert.equal(decodes(f),0);assert.equal(f.sources.length,0);assert.deepEqual(f.events,[]);assert.equal(f.timers.size,0);
 for(const voice of sessions)await voice.destroy();assert.equal(f.timers.size,0);
});

test('a quick reply plays exactly one actual answer with no acceptance audio or late progress',async t=>{
 const f=fixture(t),{VoiceSession}=await fresh(),calls=[],messages=[];
 const answer='The saved headline is available.';
 const voice=new VoiceSession(async(path,options)=>{calls.push({path,options});return path==='/voice/speak'?audio():{status:200,json:{reply:answer}}},async()=>selections[0]);
 voice.onMessage=text=>messages.push(text);voice.connect();const pending=voice.sendText('Read the headline');await flush();
 assert.equal(voice.mode,'speaking');assert.deepEqual(messages,[answer]);assert.deepEqual(f.events,['start:answer']);assert.equal(decodes(f),1);
 assert.deepEqual(calls.filter(call=>call.path==='/voice/speak').map(call=>JSON.parse(call.options.body).text),[answer]);
 await f.advance(4000);assert.deepEqual(messages,[answer]);f.sources[0].onended();await pending;assert.equal(voice.mode,'idle');
 await f.advance(10000);assert.equal(calls.filter(call=>call.path==='/voice/speak').length,1);assert.equal(f.sources.length,1);await voice.destroy();assert.equal(f.timers.size,0);
});

test('finishing microphone capture releases it once and starts routing without receipt audio',async t=>{
 const f=fixture(t),{VoiceSession}=await fresh(),route=deferred(),calls=[],messages=[];
 let captureClock=0;t.mock.method(performance,'now',()=>captureClock);
 f.replace('navigator',{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){f.events.push('stop-mic')}}]})}});
 f.replace('MediaRecorder',class{state='inactive';mimeType='audio/webm';start(){this.state='recording'}stop(){this.state='inactive';f.events.push('stop-recorder');this.ondataavailable?.({data:new Blob(['x'.repeat(1500)])});queueMicrotask(()=>this.onstop?.())}});
 const voice=new VoiceSession(async(path)=>{calls.push(path);if(path==='/voice/audio'){f.events.push('route-audio');return route.promise}return {status:200,json:{ok:true}}},async()=>selections[1]);
 voice.onMessage=text=>messages.push(text);voice.connect();f.contexts[0].createAnalyser=()=>({fftSize:512,disconnect(){},getByteTimeDomainData(bytes){bytes.fill(144)}});await voice.start();assert.equal(voice.mode,'listening');assert.ok(messages.includes('Preparing voice…'));
 for(const time of [100,180,260]){captureClock=time;for(const callback of f.intervals.values())callback()}
 f.events.length=0;messages.length=0;await voice.finish();await voice.finish();await flush();assert.equal(voice.mode,'working');assert.deepEqual(messages,[]);
 assert.equal(f.events.filter(event=>event==='stop-recorder').length,1);assert.equal(f.events.filter(event=>event==='stop-mic').length,1);
 assert.ok(f.events.indexOf('stop-recorder')<f.events.indexOf('route-audio'));assert.ok(f.events.indexOf('stop-mic')<f.events.indexOf('route-audio'));
 assert.ok(!f.events.some(event=>event==='cue'||event.startsWith('start:')));assert.equal(f.sources.length,0);assert.ok(!calls.includes('/voice/speak'));assert.equal(f.intervals.size,0);
 voice.cancel();route.resolve({status:200,json:{reply:''}});await flush();await voice.destroy();assert.equal(f.timers.size,0);
});

test('cancelled and preempted requests cannot leave delayed feedback or speak stale replies',async t=>{
 const f=fixture(t),{VoiceSession}=await fresh(),firstRoute=deferred(),secondRoute=deferred(),calls=[],messages=[];let requests=0;
 const voice=new VoiceSession(async(path,options)=>{calls.push({path,options});return path==='/voice/text'?(++requests===1?firstRoute.promise:secondRoute.promise):{status:200}},async()=>selections[0]);
 voice.onMessage=text=>messages.push(text);const first=voice.sendText('Old question');await flush();await f.advance(3990);
 const second=voice.sendText('Replacement question');await flush();assert.equal(calls.find(call=>call.path==='/voice/text').options.signal.aborted,true);
 firstRoute.resolve({status:200,json:{reply:'A stale answer'}});await first;await f.advance(50);assert.deepEqual(messages,[]);
 voice.cancel();secondRoute.resolve({status:200,json:{reply:'Another stale answer'}});await second;await f.advance(10000);
 assert.deepEqual(messages,[]);assert.equal(voice.mode,'idle');assert.equal(f.sources.length,0);assert.deepEqual(f.events,[]);assert.ok(!calls.some(call=>call.path==='/voice/speak'));
 await voice.destroy();assert.equal(f.timers.size,0);
});

test('received answers clear request feedback before slow rendering and cancelled playback preparation',async t=>{
 const f=fixture(t),{VoiceSession}=await fresh(),render=deferred(),synthesis=deferred(),calls=[],messages=[];
 const voice=new VoiceSession(async(path,options)=>{calls.push({path,options});return path==='/voice/speak'?synthesis.promise:{status:200,json:{reply:'An actual answer'}}},async()=>selections[0]);
 voice.onReply=()=>render.promise;voice.onMessage=text=>messages.push(text);const pending=voice.sendText('Question');await flush();await f.advance(5000);
 assert.deepEqual(messages,[]);assert.ok(!calls.some(call=>call.path==='/voice/speak'));render.resolve();await flush();assert.deepEqual(messages,['An actual answer']);
 await f.advance(4000);assert.deepEqual(messages,['An actual answer']);assert.equal(calls.filter(call=>call.path==='/voice/speak').length,1);
 await voice.destroy();synthesis.resolve(audio());await pending;await f.advance(10000);assert.equal(f.sources.length,0);assert.equal(decodes(f),0);assert.equal(f.timers.size,0);
});
