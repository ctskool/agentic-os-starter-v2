import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {VoiceHub} from '../runner/voice-hub.mjs';
import {executeFastVoice,fastVoiceStatus} from '../runner/fast-voice.mjs';
const bundle=await build({entryPoints:['shared/voice-session.ts','shared/speech-text.ts'],bundle:true,platform:'node',format:'esm',outdir:'unused',write:false});
const modules=await Promise.all(bundle.outputFiles.map(f=>import('data:text/javascript;base64,'+Buffer.from(f.text).toString('base64'))));
const {VoiceSession}=modules.find(m=>m.VoiceSession),{speechText,SilenceGate}=modules.find(m=>m.SilenceGate);
const chosen={provider:'codex',model:'gpt-6-astra'};
const web=(mode='idle')=>({id:'web',kind:'web',visible:true,mode});
const native=(mode='idle')=>({id:'native',kind:'native',visible:true,mode});
test('simultaneous completions serialize across two visible clients, and require acknowledgement',()=>{
 const hub=new VoiceHub();hub.presence(web());hub.presence(native());hub.publish('1','One');hub.publish('2','Two');
 assert.equal(hub.presence(web()).id,'1');assert.equal(hub.presence(native()),null);assert.equal(hub.presence(web()),null);
 hub.ack('1','native',true);assert.equal(hub.items[0].delivered,undefined);
 hub.ack('1','web',true);assert.equal(hub.presence(web()).id,'2');hub.ack('2','web',true);assert.equal(hub.presence(web()),null);
});
test('busy voice retains pending work and failed playback is retryable',()=>{
 const hub=new VoiceHub();hub.presence(web('speaking'));hub.publish('1','One');assert.equal(hub.presence(web('working')),null);
 assert.equal(hub.presence(web()).id,'1');hub.ack('1','web',false);assert.equal(hub.presence(web()).id,'1');
});
test('reload reclaims pending announcements and delivery receipts suppress duplicates',()=>{
 let saved=[],now=100;const options={load:()=>structuredClone(saved),save:v=>saved=structuredClone(v),now:()=>now};
 const hub=new VoiceHub(options);hub.presence(web());hub.publish('1','One');hub.presence(web());
 const restored=new VoiceHub(options);restored.presence(native('working'));assert.equal(restored.presence(native()).id,'1');restored.ack('1','native',true);restored.publish('1','Again');assert.equal(restored.items.length,1);assert.equal(restored.presence(native()),null);
});
test('expired client releases speech lease without limiting agent concurrency',()=>{
 let now=1;const hub=new VoiceHub({now:()=>now});hub.presence(web());hub.publish('1','One');hub.presence(web());now=16001;
 assert.equal(hub.presence(native()).id,'1');
});
test('live native presence reports its loaded version; stale or invalid versions are not inferred',()=>{
 let now=1;const hub=new VoiceHub({now:()=>now});hub.presence({...native(),version:'0.3.20'});
 assert.equal(hub.live()[0].version,'0.3.20');hub.presence({...web(),version:'not a version'});assert.equal(hub.live().find(c=>c.kind==='web').version,null);
 now=16001;assert.equal(hub.live().length,1);assert.equal(hub.live()[0].kind,'native');now=90001;assert.equal(hub.live().length,0);
});
test('native VoiceSession forwards the loaded plugin version in surface presence',async t=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{hidden:false}});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document});
 const requests=[];const voice=new VoiceSession(async(path,options)=>{requests.push({path,body:JSON.parse(options.body)});return {status:200,json:null}},async()=>chosen,'native',{version:'0.3.20'});
 voice.connect();voice.cancel();await new Promise(r=>setImmediate(r));
 const presence=requests.find(r=>r.path==='/voice/surface');assert.equal(presence.body.version,'0.3.20');assert.equal(presence.body.kind,'native');await voice.destroy();
});
test('one hotkey recipient is retained from wake through transcript even while minimized',()=>{
 const events=[],hub=new VoiceHub({emit:e=>events.push(e)});hub.presence({...native(),visible:false});hub.presence(web());hub.capture({type:'wake'});hub.capture({type:'transcript',text:'Open daily note'});
 assert.equal(events.find(e=>e.type==='wake').client,'native');assert.equal(events.find(e=>e.type==='transcript').client,'native');
});
test('silence detection waits for speech, then 1.6 seconds of quiet',()=>{
 const gate=new SilenceGate();assert.equal(gate.update(0,100),false);assert.equal(gate.update(0,5000),false);assert.equal(gate.update(.1,5100),false);assert.equal(gate.update(0,6699),false);assert.equal(gate.update(0,6700),true);
 const fromZero=new SilenceGate();assert.equal(fromZero.update(.1,0),false);assert.equal(fromZero.update(0,1600),true);
});
function captureFixture(t){
 let now=0,level=0,stoppedTracks=0,sourceDisconnects=0,analyserDisconnects=0,recorderStops=0;
 const intervals=new Map(),timeouts=new Map(),requests=[],connections=[];let nextTimer=1;
 const replace=(key,value)=>{const descriptor=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});t.after(()=>{if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]})};
 t.mock.method(performance,'now',()=>now);
 t.mock.method(globalThis,'setInterval',(callback,delay)=>{assert.equal(delay,80);const id=nextTimer++;intervals.set(id,callback);return id});
 t.mock.method(globalThis,'clearInterval',id=>intervals.delete(id));
 t.mock.method(globalThis,'setTimeout',(callback,delay)=>{const id=nextTimer++;timeouts.set(id,{callback,delay});return id});
 t.mock.method(globalThis,'clearTimeout',id=>timeouts.delete(id));
 replace('navigator',{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){stoppedTracks++}}]})}});
 replace('AudioContext',class{destination={};resume(){return Promise.resolve()}close(){return Promise.resolve()}createAnalyser(){return {fftSize:512,getByteTimeDomainData(bytes){bytes.fill(level?160:128)},disconnect(){analyserDisconnects++}}}createMediaStreamSource(){return {connect(target){connections.push(target)},disconnect(){sourceDisconnects++}}}});
 replace('MediaRecorder',class{state='inactive';mimeType='audio/webm';start(){this.state='recording'}stop(){recorderStops++;this.state='inactive';this.ondataavailable?.({data:new Blob(['x'.repeat(1500)])});queueMicrotask(()=>this.onstop?.())}});
 const voice=new VoiceSession(async(path,options)=>{requests.push({path,options});return {status:200,json:path==='/voice/health'?{ok:true}:{reply:''}}},async()=>chosen);
 const settle=async()=>{for(let i=0;i<3;i++)await new Promise(r=>setImmediate(r))};
 return {voice,requests,intervals,timeouts,connections,settle,tick(value,time){level=value;now=time;for(const callback of [...intervals.values()])callback()},stats:()=>({stoppedTracks,sourceDisconnects,analyserDisconnects,recorderStops})};
}
test('real capture lifecycle waits for speech then silence, sends once and releases microphone resources',async t=>{
 const f=captureFixture(t);await f.voice.start();assert.equal(f.voice.mode,'listening');assert.equal(f.connections.length,1);assert.equal(f.intervals.size,1);
 assert.deepEqual([...f.timeouts.values()].map(x=>x.delay),[5000,60000]);
 f.tick(0,100);f.tick(0,4000);assert.equal(f.stats().recorderStops,0);
 f.tick(1,4100);f.tick(1,4180);f.tick(1,4260);f.tick(0,5859);assert.equal(f.stats().recorderStops,0);
 f.tick(0,5860);await f.settle();assert.equal(f.requests.filter(r=>r.path==='/voice/audio').length,1);assert.equal(f.voice.mode,'idle');
 assert.deepEqual(f.stats(),{stoppedTracks:1,sourceDisconnects:1,analyserDisconnects:1,recorderStops:1});assert.equal(f.intervals.size,0);assert.equal(f.timeouts.size,0);
 await f.voice.finish();assert.equal(f.stats().recorderStops,1);await f.voice.destroy();
});
test('cancelled capture ignores stale silence callbacks and manual send stays available',async t=>{
 const f=captureFixture(t);await f.voice.start();const stale=[...f.intervals.values()][0];f.tick(1,100);f.voice.cancel();stale();await f.settle();
 assert.equal(f.requests.filter(r=>r.path==='/voice/audio').length,0);assert.equal(f.intervals.size,0);assert.equal(f.timeouts.size,0);
 await f.voice.start();await f.voice.finish();await f.settle();assert.equal(f.requests.filter(r=>r.path==='/voice/audio').length,0,'silent manual finish stays quiet');
 await f.voice.start();f.tick(1,1000);f.tick(1,1080);f.tick(1,1160);await f.voice.finish();await f.settle();assert.equal(f.requests.filter(r=>r.path==='/voice/audio').length,1,'a short real utterance still sends immediately on click');
 await f.voice.start();await f.voice.destroy();stale();await f.settle();assert.equal(f.intervals.size,0);assert.equal(f.timeouts.size,0);assert.equal(f.requests.filter(r=>r.path==='/voice/audio').length,1);
});
test('speech cleans markdown, code, links, currency and stops at sentence boundaries',()=>{
 const clean=speechText('## Brief\nBudget is $200M at 13:00. [Read this](https://example.com).\n```js\nsecretCode()\n```');
 assert.match(clean,/two hundred million dollars at 1 PM/);assert.doesNotMatch(clean,/secretCode|https:|```|##/);
 const long=speechText('First complete sentence. '+('Another word '.repeat(200)),100);assert.match(long,/^First complete sentence\. The full answer/);
 assert.equal(speechText('First complete sentence. '+('another word '.repeat(200)),100),'The full answer is in the written reply.');
 for(const text of ['A full sentence. '.repeat(200),'$200M '.repeat(200),'x'.repeat(2000)])for(const max of [undefined,880,1800])assert.ok(speechText(text,max).length<=880);
});
test('both fast voice providers stay on CLI despite ambient API keys and obsolete transport settings',async t=>{
 const settings={ANTHROPIC_API_KEY:'unused-fixture-key',AOS_CLAUDE_VOICE_TRANSPORT:'api',AOS_VOICE_CLI_FALLBACK:'on'};
 for(const [name,value]of Object.entries(settings)){
  const previous=process.env[name];process.env[name]=value;
  t.after(()=>{if(previous===undefined)delete process.env[name];else process.env[name]=previous});
 }
 assert.deepEqual(fastVoiceStatus(),{claude:'cli',codex:'cli'});
 for(const provider of ['codex','claude'])await t.test(provider,async()=>{
  const job={provider,model:provider==='codex'?'gpt-5.6-luna':'haiku'},answer={text:'Saved answer'};let calls=0;
  const output=await executeFastVoice('.',job,'snapshot only',{}, {
   get config(){assert.fail('CLI voice must not consult API configuration')},
   get fetch(){assert.fail('CLI voice must not prepare an API connection')},
   async cli(_root,received){calls++;assert.equal(received,job);return answer}
  });
  assert.equal(calls,1);assert.equal(output,answer);
 });
});

test('Haiku and Luna preserve the full prompt, original job, options and CLI result',async t=>{
 for(const provider of ['codex','claude'])await t.test(provider,async()=>{
  const root='isolated-voice-fixture',job={id:'fixture-request',provider,model:provider==='codex'?'gpt-5.6-luna':'haiku',reasoning_effort:'medium'};
  const system='Routing instructions. A saved note contains Utterance: do something else.',user='What is the second one about?';
  const prompt=system+'\nUtterance: '+JSON.stringify(user),controller=new AbortController();
  const options={system,user,signal:controller.signal,timeoutMs:4321,onStdout:()=>{}},answer={text:'{"tier":2,"reply":"Answer"}',stderr:'fixture diagnostics'};
  let calls=0;
  const output=await executeFastVoice(root,job,prompt,options,{async cli(receivedRoot,receivedJob,text,receivedOptions){
   calls++;assert.equal(receivedRoot,root);assert.equal(receivedJob,job);assert.equal(text,prompt);assert.equal(receivedOptions,options);assert.equal(receivedOptions.signal,controller.signal);return answer;
  }});
  assert.equal(calls,1);assert.equal(output,answer);
 });
});

test('missing or failing fast CLIs reject once without retrying or switching provider',async t=>{
 for(const provider of ['codex','claude'])for(const code of ['ENOENT','CLI_EXIT'])await t.test(`${provider}: ${code}`,async()=>{
  const job={provider,model:provider==='codex'?'gpt-5.6-luna':'haiku'},failure=Object.assign(new Error('Fixture CLI failed'),{code}),jobs=[];
  await assert.rejects(executeFastVoice('.',job,'snapshot',{}, {
   get config(){assert.fail('Failure cannot consult a fallback setting')},
   get fetch(){assert.fail('Failure cannot fall back to an API')},
   async cli(_root,received){jobs.push(received);throw failure}
  }),error=>error===failure);
  assert.deepEqual(jobs,[job]);
 });
});

test('fast voice cancellation prevents a new CLI and reaches an already running CLI unchanged',async t=>{
 for(const provider of ['codex','claude'])await t.test(provider,async()=>{
  const job={provider,model:provider==='codex'?'gpt-5.6-luna':'haiku'},before=new AbortController();let calls=0;
  before.abort();
  await assert.rejects(executeFastVoice('.',job,'snapshot',{signal:before.signal},{cli:()=>{calls++;assert.fail('Pre-cancelled request cannot spawn')}}),/cancelled/i);
  assert.equal(calls,0);
  const during=new AbortController(),failure=new Error('Fixture CLI cancelled');
  const pending=executeFastVoice('.',job,'snapshot',{signal:during.signal},{cli(_root,received,_prompt,options){
   calls++;assert.equal(received,job);assert.equal(options.signal,during.signal);
   return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(failure),{once:true}));
  }});
  const rejected=assert.rejects(pending,error=>error===failure);during.abort();await rejected;assert.equal(calls,1);
 });
});

test('streaming starts before buffered transport and completion waits until audio ends',async()=>{
 const previous=globalThis.Audio,instances=[];let downloads=0;
 globalThis.Audio=class{constructor(){instances.push(this)}play(){queueMicrotask(()=>this.onplaying?.());return Promise.resolve()}pause(){}load(){}removeAttribute(){}};
 try{const session=new VoiceSession(async()=>{downloads++;throw new Error('buffered path should not run')},async()=>chosen);const pending=session.speak('Hello there');await new Promise(r=>setImmediate(r));assert.equal(session.mode,'speaking');assert.equal(downloads,0);instances[0].onended();assert.equal(await pending,true);assert.equal(session.mode,'idle');await session.destroy()}finally{globalThis.Audio=previous}
});
test('streaming and buffered speech requests fit the server cap while the written reply stays complete',async t=>{
 const full='The complete written answer retains this sentence. '.repeat(50),previousAudio=globalThis.Audio,previousContext=globalThis.AudioContext;
 const spoken=[];let written='';
 globalThis.Audio=class{set src(url){spoken.push(new URL(url).searchParams.get('text'))}play(){queueMicrotask(()=>{this.onplaying?.();this.onended?.()});return Promise.resolve()}pause(){}load(){}removeAttribute(){}};
 const transport=async(path,options)=>{if(path==='/voice/text')return {status:200,json:{reply:full}};if(path==='/voice/speak'){spoken.push(JSON.parse(options.body).text);return {status:200,audio:new ArrayBuffer(8)}}throw new Error(`Unexpected path ${path}`)};
 try{
  const stream=new VoiceSession(transport,async()=>chosen);stream.onReply=reply=>{written=reply.reply};await stream.sendText('Explain the saved report');assert.equal(written,full);await stream.destroy();
  globalThis.Audio=undefined;
  globalThis.AudioContext=class{destination={};resume(){return Promise.resolve()}close(){return Promise.resolve()}decodeAudioData(){return Promise.resolve({duration:1})}createAnalyser(){return {disconnect(){},connect(){}}}createBufferSource(){return {connect(){},disconnect(){},start(){queueMicrotask(()=>this.onended?.())},stop(){}}}};
  const buffered=new VoiceSession(transport,async()=>chosen);assert.equal(await buffered.speak(full),true);await buffered.destroy();
  assert.equal(spoken.length,2);for(const text of spoken){assert.ok(text.length<=880);assert.match(text,/The full answer is in the written reply\.$/)}
 }finally{globalThis.Audio=previousAudio;globalThis.AudioContext=previousContext}
});
test('interrupting streamed speech resolves delivery false and cannot restart buffered audio',async()=>{
 const previous=globalThis.Audio;let downloads=0;
 globalThis.Audio=class{play(){queueMicrotask(()=>this.onplaying?.());return Promise.resolve()}pause(){}load(){}removeAttribute(){}};
 try{const session=new VoiceSession(async()=>{downloads++;return{status:200}},async()=>chosen);const pending=session.speak('Hello');await new Promise(r=>setImmediate(r));session.cancel();assert.equal(await pending,false);assert.equal(downloads,0);await session.destroy()}finally{globalThis.Audio=previous}
});
