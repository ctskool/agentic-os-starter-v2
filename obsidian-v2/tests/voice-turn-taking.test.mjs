import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const built=await build({entryPoints:['shared/voice-turn-taking.ts','shared/voice-session.ts'],bundle:true,platform:'node',format:'esm',outdir:'unused',write:false});
const modules=await Promise.all(built.outputFiles.map(file=>import('data:text/javascript;base64,'+Buffer.from(file.text).toString('base64'))));
const {VoiceCaptureGate,PlaybackSpeechGate,VoicePcmWindow,voiceWav,PlaybackCapture}=modules.find(m=>m.PlaybackCapture),{VoiceSession}=modules.find(m=>m.VoiceSession);
const chosen={provider:'codex',model:'gpt-6-astra',targetId:'retained-conversation',terminalMode:true};
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve))};
function replace(t,key,value){const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});t.after(()=>old?Object.defineProperty(globalThis,key,old):delete globalThis[key])}

test('silence, breaths and isolated clicks expire quietly; a short spoken yes keeps the 1.6-second pause',()=>{
 const gate=new VoiceCaptureGate(0);
 for(let now=0;now<5000;now+=80)assert.equal(gate.update(now===400||now===1920?0.15:0,now),null);
 assert.equal(gate.heardSpeech,false);assert.equal(gate.update(0,5000),'quiet');
 const speech=new VoiceCaptureGate(0);for(const now of [100,180,260])assert.equal(speech.update(.08,now),null);
 assert.equal(speech.heardSpeech,true);assert.equal(speech.update(0,1859),null);assert.equal(speech.update(0,1860),'finish');
});

function signal(time,frequency,amplitude=.1,length=4096,rate=48000){return Float32Array.from({length},(_,i)=>amplitude*Math.sin((time*rate/1000+i)*frequency*2*Math.PI/rate))}
const utterance=time=>signal(time,311,.15*(1+.3*Math.sin(time/115)));
test('echo detection rejects loud and delayed playback, but accepts sustained independent speech',()=>{
 for(const delay of [0,32,84,160]){
  const echo=new PlaybackSpeechGate();
  for(let now=0;now<5000;now+=80){
   const output=signal(now,137,.15),mic=signal(now-delay,137,.07);
   assert.equal(echo.update(mic,output,48000,now),false,`echo delay ${delay}, at ${now}`);
  }
 }
 const gate=new PlaybackSpeechGate();let started=null;
 for(let now=0;now<1800;now+=80){
  const output=signal(now,137,.15),input=now<800?new Float32Array(4096):utterance(now);
  if(gate.update(input,output,48000,now)){started=now;break}
 }
 assert.equal(started,1120);assert.equal(gate.onset,800);
 const clicks=new PlaybackSpeechGate();for(let now=0;now<5000;now+=80)assert.equal(clicks.update(now%800===0?signal(now,311,.8):new Float32Array(4096),signal(now,137,.1),48000,now),false);
});

test('pre-roll has a fixed bound and WAV preserves the actual beginning and all captured samples',async()=>{
 const ring=new VoicePcmWindow(10,1.2);ring.add(Float32Array.from([1,2,3,4,5,6,7,8]));ring.add(Float32Array.from([9,10,11,12,13,14,15,16]));
 assert.deepEqual([...ring.tail()],[5,6,7,8,9,10,11,12,13,14,15,16]);assert.deepEqual([...ring.tail(.4)],[13,14,15,16]);ring.clear();assert.equal(ring.tail().length,0);
 const buffer=await voiceWav([Float32Array.from([-.5,0,.25]),Float32Array.from([1,-1])]).arrayBuffer(),view=new DataView(buffer);
 assert.equal(new TextDecoder().decode(buffer.slice(0,4)),'RIFF');assert.equal(view.getUint32(24,true),16000);assert.equal(view.getUint32(40,true),10);assert.deepEqual(Array.from({length:5},(_,i)=>view.getInt16(44+i*2,true)),[-16384,0,8192,32767,-32768]);
});

function audioFixture(t,{buffered=false,denied=false,pendingMic=false}={}){
 let now=0,next=1,context,streamResolve;const timers=new Map(),intervals=new Map(),processors=[],tracks=[],media=[],sources=[],nodes=[],requests=[],constraints=[];
 replace(t,'window',undefined);t.mock.method(performance,'now',()=>now);
 t.mock.method(globalThis,'setTimeout',(fn,delay)=>{const id=next++;timers.set(id,{fn,at:now+delay});return id});t.mock.method(globalThis,'clearTimeout',id=>timers.delete(id));
 t.mock.method(globalThis,'setInterval',(fn,delay)=>{const id=next++;intervals.set(id,{fn,delay});return id});t.mock.method(globalThis,'clearInterval',id=>intervals.delete(id));
 const makeStream=()=>{const track={stops:0,stop(){this.stops++}};tracks.push(track);return {getTracks:()=>[track]}};
 replace(t,'navigator',{mediaDevices:{getUserMedia:async config=>{constraints.push(config);if(denied)throw new Error('Permission denied');if(pendingMic)return await new Promise(resolve=>streamResolve=()=>resolve(makeStream()));return makeStream()}}});
 const node=(extra={})=>{const value={connections:[],disconnects:0,connect(...args){this.connections.push(args)},disconnect(){this.disconnects++},...extra};nodes.push(value);return value};
 replace(t,'AudioContext',class{
  state='running';sampleRate=48000;destination={};currentTime=0;
  constructor(){context=this}resume(){return Promise.resolve()}close(){return Promise.resolve()}
  createAnalyser(){return node({fftSize:512,getByteTimeDomainData(array){array.fill(128)}})}
  createMediaElementSource(){return node()}createMediaStreamSource(){return node()}createChannelMerger(){return node()}
  createScriptProcessor(){const value=node({onaudioprocess:null});processors.push(value);return value}
  createGain(){return node({gain:{value:1}})}decodeAudioData(){return Promise.resolve({duration:30})}
  createBufferSource(){const value=node({stops:0,start(){},stop(){this.stops++}});sources.push(value);return value}
 });
 replace(t,'Audio',buffered?undefined:class{constructor(){media.push(this)}play(){queueMicrotask(()=>this.onplaying?.());return Promise.resolve()}pause(){this.paused=true}removeAttribute(){}load(){}});
 const voice=new VoiceSession(async(path,options)=>{requests.push({path,options});if(path==='/voice/speak')return {status:200,audio:new ArrayBuffer(2)};return {status:200,json:path==='/voice/health'?{ok:true}:{reply:''}}},async()=>chosen);
 const tick=async(time,input=new Float32Array(4096),output=new Float32Array(4096))=>{now=time;for(const p of processors)p.onaudioprocess?.({inputBuffer:{getChannelData:channel=>channel===0?input:output}});await flush()};
 const advance=async(milliseconds)=>{now+=milliseconds;for(let pass=0;pass<10;pass++){const due=[...timers].filter(([,timer])=>timer.at<=now);if(!due.length)break;for(const [id,timer]of due){timers.delete(id);timer.fn()}await flush()}};
 return {voice,timers,intervals,processors,tracks,media,sources,nodes,requests,constraints,tick,advance,getContext:()=>context,resolveMic:()=>streamResolve?.()};
}

for(const buffered of [false,true])test(`${buffered?'buffered':'streaming'} playback yields to real speech, retains its onset and selected conversation, then submits once`,async t=>{
 const f=audioFixture(t,{buffered}),attempt={started:false},spoken=f.voice.speak('A long written answer',undefined,[],attempt);await flush();assert.equal(f.voice.mode,'speaking');assert.equal(attempt.started,true);assert.equal(f.processors.length,1);
 for(let time=0;time<800;time+=80)await f.tick(time,new Float32Array(4096),signal(time,137));
 for(let time=800;time<=1120;time+=80)await f.tick(time,utterance(time),signal(time,137));
 assert.equal(f.voice.mode,'listening');assert.equal(await spoken,false);assert.equal(f.tracks[0].stops,0);assert.ok(attempt.started,'started delivery is still acknowledged once after interruption');
 for(let time=1200;time<=1440;time+=80)await f.tick(time,utterance(time));
 await f.tick(3039);assert.equal(f.requests.filter(r=>r.path==='/voice/audio').length,0);await f.tick(3040);await flush();
 const audio=f.requests.filter(r=>r.path==='/voice/audio');assert.equal(audio.length,1);assert.equal(audio[0].options.headers['Content-Type'],'audio/wav');assert.deepEqual(JSON.parse(audio[0].options.headers['X-V2-Selection']),chosen);assert.deepEqual(JSON.parse(audio[0].options.headers['X-V2-Work']),{targetId:chosen.targetId});
 const data=new DataView(audio[0].options.body);assert.equal(data.getUint32(24,true),16000);assert.ok(data.byteLength>20000);let audible=0;for(let at=44;at<Math.min(data.byteLength,16000);at+=2)audible+=Math.abs(data.getInt16(at,true));assert.ok(audible>10000,'pre-roll contains the beginning, not just silence after the interruption');
 assert.equal(f.voice.mode,'idle');assert.equal(f.tracks[0].stops,1);assert.equal(f.processors[0].onaudioprocess,null);assert.equal(f.timers.size,0);await f.voice.destroy();
});

test('denied optional microphone leaves playback intact and produces no voice error',async t=>{
 const f=audioFixture(t,{denied:true}),errors=[];f.voice.onMessage=(message,error)=>{if(error)errors.push(message)};const pending=f.voice.speak('The answer remains audible');await flush();assert.equal(f.voice.mode,'speaking');f.media[0].onended();assert.equal(await pending,true);assert.deepEqual(errors,[]);assert.equal(f.timers.size,0);await f.voice.destroy();
});

for(const end of ['cancel','destroy','ended'])test(`late microphone permission after ${end} closes its track without reviving capture`,async t=>{
 const f=audioFixture(t,{pendingMic:true}),pending=f.voice.speak('A response');await flush();if(end==='ended')f.media[0].onended();else if(end==='destroy')await f.voice.destroy();else f.voice.cancel();await pending;f.resolveMic();await flush();assert.equal(f.tracks[0].stops,1);assert.equal(f.processors.length,0);assert.equal(f.voice.mode,'idle');assert.equal(f.timers.size,0);if(end!=='destroy')await f.voice.destroy();
});

test('normal playback ends with every microphone graph node released and no idle capture',async t=>{
 const f=audioFixture(t),pending=f.voice.speak('A response');await flush();f.media[0].onended();assert.equal(await pending,true);assert.equal(f.tracks[0].stops,1);assert.equal(f.processors[0].onaudioprocess,null);assert.ok(f.processors[0].disconnects>0);assert.equal(f.timers.size,0);assert.equal(f.voice.mode,'idle');await f.advance(100000);assert.equal(f.constraints.length,1);await f.voice.destroy();
});

test('microphone constraints request echo cancellation and keep playback monitoring local',async t=>{
 const f=audioFixture(t),pending=f.voice.speak('A response');await flush();assert.deepEqual(f.constraints,[{audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}}]);for(let time=0;time<6000;time+=80)await f.tick(time,signal(time,137,.05),signal(time,137,.1));assert.equal(f.voice.mode,'speaking');assert.equal(f.requests.length,0);f.voice.cancel();assert.equal(await pending,false);await f.voice.destroy();
});

test('silent click activation expires at five seconds with no submission, error state or lingering resources',async t=>{
 const f=audioFixture(t),messages=[],states=[];let stopped=0;
 replace(t,'MediaRecorder',class{state='inactive';mimeType='audio/webm';start(){this.state='recording'}stop(){stopped++;this.state='inactive';this.ondataavailable?.({data:new Blob(['x'.repeat(1500)])});queueMicrotask(()=>this.onstop?.())}});
 f.voice.onMessage=(text,error)=>messages.push({text,error});f.voice.onState=mode=>states.push(mode);
 await f.voice.start();assert.equal(f.voice.mode,'listening');await f.advance(4999);assert.equal(f.voice.mode,'listening');await f.advance(1);
 assert.equal(f.voice.mode,'idle');assert.equal(stopped,1);assert.equal(f.tracks[0].stops,1);assert.deepEqual(f.requests.map(r=>r.path),['/voice/health']);assert.ok(messages.every(m=>!m.error));assert.equal(messages.at(-1).text,'');assert.ok(!states.includes('error'));assert.equal(f.timers.size,0);assert.equal(f.intervals.size,0);await f.voice.destroy();
});

test('replacing playback releases the old monitor and stale callbacks cannot cancel the new answer',async t=>{
 const f=audioFixture(t),first=f.voice.speak('Old response');await flush();const stale=f.processors[0].onaudioprocess;
 const second=f.voice.speak('New response');await flush();assert.equal(await first,false);assert.equal(f.voice.mode,'speaking');assert.equal(f.tracks[0].stops,1);assert.equal(f.tracks[1].stops,0);
 stale({inputBuffer:{getChannelData:()=>signal(1000,311)}});await flush();assert.equal(f.voice.mode,'speaking');f.media[1].onended();assert.equal(await second,true);assert.equal(f.tracks[1].stops,1);assert.equal(f.timers.size,0);await f.voice.destroy();
});

test('an interruption late in playback gets its own full capture window instead of inheriting playback expiry',async t=>{
 const f=audioFixture(t),pending=f.voice.speak('Long response');await flush();
 await f.tick(78000,new Float32Array(4096),signal(78000,137));await f.tick(78500,new Float32Array(4096),signal(78500,137));
 for(let time=79000;time<=79400;time+=80)await f.tick(time,utterance(time),signal(time,137));
 assert.equal(f.voice.mode,'listening');assert.equal(await pending,false);
 await f.advance(18000);assert.equal(f.voice.mode,'listening');assert.equal(f.tracks[0].stops,0,'original 95-second monitor timeout must have been cleared');
 await f.voice.finish();await flush();assert.equal(f.requests.filter(r=>r.path==='/voice/audio').length,1);assert.equal(f.voice.mode,'idle');assert.equal(f.tracks[0].stops,1);assert.equal(f.timers.size,0);await f.voice.destroy();
});

test('capture stops at a hard sample limit even if timers and the wall clock are stalled',async t=>{
 const f=audioFixture(t),pending=f.voice.speak('Response');await flush();
 for(let time=0;time<800;time+=80)await f.tick(time,new Float32Array(4096),signal(time,137));
 for(let time=800;time<=1120;time+=80)await f.tick(time,utterance(time),signal(time,137));assert.equal(await pending,false);
 const pcm=signal(1120,311,.15),event={inputBuffer:{getChannelData:channel=>channel===0?pcm:new Float32Array(4096)}};
 for(let i=0;i<1000&&f.processors[0].onaudioprocess;i++)f.processors[0].onaudioprocess(event);
 await flush();const requests=f.requests.filter(r=>r.path==='/voice/audio');assert.equal(requests.length,1);assert.equal(new DataView(requests[0].options.body).getUint32(40,true),16000*60*2);assert.equal(f.tracks[0].stops,1);assert.equal(f.processors[0].onaudioprocess,null);assert.equal(f.timers.size,0);await f.voice.destroy();
});

test('cancel after speech interruption closes its microphone without submitting captured audio',async t=>{
 const f=audioFixture(t),pending=f.voice.speak('Response');await flush();for(let time=0;time<800;time+=80)await f.tick(time,new Float32Array(4096),signal(time,137));for(let time=800;time<=1120;time+=80)await f.tick(time,utterance(time),signal(time,137));assert.equal(await pending,false);assert.equal(f.voice.mode,'listening');const stale=f.processors[0].onaudioprocess;
 f.voice.cancel();stale({inputBuffer:{getChannelData:()=>signal(1500,311)}});await flush();await f.advance(60000);assert.equal(f.voice.mode,'idle');assert.equal(f.requests.filter(r=>r.path==='/voice/audio').length,0);assert.equal(f.tracks[0].stops,1);assert.equal(f.timers.size,0);await f.voice.destroy();
});

test('remote hotkey silence returns quietly idle rather than producing an error beep',async t=>{
 const f=audioFixture(t),events=[];let source;
 replace(t,'window',new EventTarget());replace(t,'document',Object.assign(new EventTarget(),{hidden:false}));
 replace(t,'EventSource',class{constructor(url){source=this;this.client=new URL(url).searchParams.get('client')}close(){}});
 const voice=new VoiceSession(async()=>({status:200,json:null}),async()=>chosen,'native');voice.onMessage=(text,error)=>events.push({text,error});voice.connect();await flush();source.onmessage({data:JSON.stringify({type:'wake',client:source.client})});assert.equal(voice.mode,'listening');source.onmessage({data:JSON.stringify({type:'wake_timeout',client:source.client})});assert.equal(voice.mode,'idle');assert.ok(events.every(e=>!e.error));assert.equal(events.at(-1).text,'');await voice.destroy();assert.equal(f.intervals.size,0);assert.equal(f.timers.size,0);
});

test('a failed streaming graph never starts microphone monitoring without a confirmed output reference',async t=>{
 const f=audioFixture(t),pending=f.voice.speak('Still available through normal playback');f.getContext().createMediaElementSource=()=>{throw new Error('Unsupported media graph')};await flush();assert.equal(f.voice.mode,'speaking');assert.equal(f.constraints.length,0);assert.equal(f.processors.length,0);f.media[0].onended();assert.equal(await pending,true);assert.equal(f.timers.size,0);await f.voice.destroy();
});

test('stationary fan, hum, broadband noise and late noise onset never interrupt playback',()=>{
 let seed=1234;const noise=()=>Float32Array.from({length:4096},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return (seed/4294967296-.5)*.104});
 for(const kind of ['hum','tone','broadband'])for(const onset of [0,1600]){
  const gate=new PlaybackSpeechGate();for(let now=0;now<8000;now+=80){
   const input=now<onset?new Float32Array(4096):kind==='broadband'?noise():signal(now,kind==='hum'?60:311,.06);
   assert.equal(gate.update(input,signal(now,137,.1),48000,now),false,`${kind}, onset${onset}, now${now}`);
  }
 }
});

test('an input device ending capture cannot submit silent audio or leave the recording graph alive',async t=>{
 const f=audioFixture(t);let recorder;
 replace(t,'MediaRecorder',class{state='inactive';mimeType='audio/webm';constructor(){recorder=this}start(){this.state='recording'}stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['x'.repeat(1500)])});queueMicrotask(()=>this.onstop?.())}});
 await f.voice.start();recorder.stop();await flush();assert.equal(f.voice.mode,'error');assert.equal(f.requests.filter(r=>r.path==='/voice/audio').length,0);assert.equal(f.tracks[0].stops,1);assert.equal(f.intervals.size,0);await f.voice.destroy();assert.equal(f.timers.size,0);
});

test('cancel while ordinary microphone permission is pending stops the late stream without recording',async t=>{
 const f=audioFixture(t,{pendingMic:true});let recorders=0;replace(t,'MediaRecorder',class{constructor(){recorders++}});
 const pending=f.voice.start();await flush();f.voice.cancel();f.resolveMic();await pending;assert.equal(f.tracks[0].stops,1);assert.equal(recorders,0);assert.equal(f.voice.mode,'idle');assert.equal(f.requests.filter(r=>r.path==='/voice/audio').length,0);assert.equal(f.timers.size,0);await f.voice.destroy();
});
