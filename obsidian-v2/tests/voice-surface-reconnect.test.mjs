import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const built=await build({entryPoints:['shared/voice-surface.ts','shared/voice-session.ts'],bundle:true,platform:'node',format:'esm',outdir:'unused',write:false});
const modules=await Promise.all(built.outputFiles.map(file=>import('data:text/javascript;base64,'+Buffer.from(file.text).toString('base64'))));
const {VoiceSurface}=modules.find(module=>module.VoiceSurface),{VoiceSession}=modules.find(module=>module.VoiceSession);
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve))};

function fixture(t){
 let now=0,timerId=0,heartbeat,stops=0,failConstructors=0,constructors=0;
 const timers=new Map(),intervals=new Map(),streams=[],requests=[],events=[];
 const replace=(key,value)=>{const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});t.after(()=>old?Object.defineProperty(globalThis,key,old):delete globalThis[key])};
 const window=new EventTarget(),document=new EventTarget();document.hidden=true;
 replace('window',window);replace('document',document);replace('AudioContext',undefined);replace('Audio',undefined);
 replace('EventSource',class {
  readyState=0;closes=0;
  constructor(url){constructors++;if(failConstructors>0){failConstructors--;throw new Error('Event source could not start')}this.url=url;streams.push(this)}
  close(){this.closes++;this.readyState=2}
  open(){this.readyState=1;this.onopen?.()}
  fail(state=2){this.readyState=state;this.onerror?.()}
  message(data){this.onmessage?.({data:JSON.stringify(data)})}
 });
 t.mock.method(Date,'now',()=>now);
 t.mock.method(globalThis,'setTimeout',(fn,delay)=>{timers.set(++timerId,{fn,at:now+delay,delay});return timerId});
 t.mock.method(globalThis,'clearTimeout',id=>timers.delete(id));
 t.mock.method(globalThis,'setInterval',(fn,delay)=>{intervals.set(++timerId,{fn,delay});return timerId});
 t.mock.method(globalThis,'clearInterval',id=>intervals.delete(id));
 const advance=async(ms,runTimers=true)=>{now+=ms;if(runTimers){for(const [id,timer] of [...timers])if(timer.at<=now&&timers.delete(id))timer.fn()}await flush()};
 const transport=async(path,options)=>{requests.push({path,body:JSON.parse(options.body)});return {status:200,json:null}};
 const info={version:'test',heartbeat:tick=>{heartbeat=tick;return()=>stops++}};
 const create=(kind='native')=>{const surface=new VoiceSurface(transport,kind,()=> 'idle',async()=>true,event=>events.push(event),info);t.after(()=>surface.destroy());return surface};
 return {create,streams,requests,events,timers,intervals,window,document,advance,transport,info,heartbeat:()=>heartbeat?.(),failConstructors:count=>failConstructors=count,get constructors(){return constructors},get stops(){return stops},get now(){return now}};
}

test('a fatal EventSource startup response is recreated once and immediately restores presence on open',async t=>{
 const f=fixture(t),surface=f.create('web');await flush();const first=f.streams[0];
 // HTTP 503/non-SSE startup responses leave EventSource CLOSED rather than auto-reconnecting.
 first.fail();first.fail();f.window.dispatchEvent(new Event('focus'));await flush();
 assert.equal(f.streams.length,1);assert.equal(f.timers.size,1);
 await f.advance(999);assert.equal(f.streams.length,1);
 await f.advance(1);assert.equal(f.streams.length,2);assert.equal(first.closes,1);
 const next=f.streams[1];assert.equal(next.url,first.url);assert.equal(new URL(next.url).searchParams.get('client'),surface.id);
 const before=f.requests.length;next.open();await flush();assert.equal(f.requests.length,before+1);
 assert.equal(f.requests.at(-1).path,'/voice/surface');assert.equal(f.requests.at(-1).body.id,surface.id);
 assert.deepEqual([...new Set(f.requests.map(request=>request.path))],['/voice/surface']);
});

test('ordinary browser CONNECTING retries are retained instead of creating competing streams',async t=>{
 const f=fixture(t);f.create('web');await flush();const stream=f.streams[0];stream.open();await flush();stream.fail(0);
 for(let i=0;i<30;i++){for(const interval of f.intervals.values())interval.fn();await f.advance(4000)}
 assert.equal(f.streams.length,1);assert.equal(stream.closes,0);assert.equal(f.timers.size,0);
 const before=f.requests.length;stream.open();await flush();assert.equal(f.requests.length,before+1);
});

test('repeated fatal failures back off to thirty seconds and a successful open resets the delay',async t=>{
 const f=fixture(t);f.create();await flush();
 for(const delay of [1000,2000,4000,8000,16000,30000,30000]){
  const count=f.streams.length;f.streams.at(-1).fail();await flush();assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].delay,delay);
  await f.advance(delay-1);f.heartbeat();await flush();assert.equal(f.streams.length,count);
  await f.advance(1);assert.equal(f.streams.length,count+1);
 }
 f.streams.at(-1).open();await flush();f.streams.at(-1).fail();await flush();assert.equal([...f.timers.values()][0].delay,1000);
});

test('native Node heartbeat recovers CLOSED streams even while renderer timeouts are frozen',async t=>{
 const f=fixture(t),surface=f.create();await flush();assert.equal(f.intervals.size,0);assert.equal(f.requests[0].body.visible,false);
 const first=f.streams[0];first.fail();await flush();const queuedRetry=[...f.timers.values()][0].fn;
 await f.advance(4000,false);assert.equal(f.streams.length,1);f.heartbeat();await flush();assert.equal(f.streams.length,2);assert.equal(first.closes,1);
 queuedRetry();f.heartbeat();await flush();assert.equal(f.streams.length,2);assert.equal(f.timers.size,0);
 f.streams[1].open();await flush();assert.equal(f.requests.at(-1).body.id,surface.id);assert.equal(f.requests.at(-1).body.visible,false);
});

test('replaced and destroyed stream callbacks cannot dispatch events, claim announcements, or reconnect',async t=>{
 const f=fixture(t),surface=f.create();await flush();const old=f.streams[0],stale={open:old.onopen,error:old.onerror,message:old.onmessage};
 old.fail();await f.advance(1000);f.streams[1].open();await flush();let before=f.requests.length,eventCount=f.events.length;
 stale.open();stale.error();stale.message({data:JSON.stringify({type:'wake',client:surface.id})});stale.message({data:JSON.stringify({type:'pending'})});await flush();
 assert.equal(f.requests.length,before);assert.equal(f.events.length,eventCount);assert.equal(f.timers.size,0);
 const current=f.streams[1],late={open:current.onopen,error:current.onerror,message:current.onmessage};current.fail();await flush();const queuedRetry=[...f.timers.values()][0].fn;
 surface.destroy();surface.destroy();await flush();before=f.requests.length;eventCount=f.events.length;
 queuedRetry();f.heartbeat();late.open();late.error();late.message({data:JSON.stringify({type:'pending'})});f.document.dispatchEvent(new Event('visibilitychange'));f.window.dispatchEvent(new Event('focus'));await f.advance(60000);
 assert.equal(f.streams.length,2);assert.equal(f.requests.length,before);assert.equal(f.events.length,eventCount);assert.equal(current.closes,1);assert.equal(f.stops,1);assert.equal(f.timers.size,0);
 assert.equal(f.requests.filter(request=>request.path==='/voice/leave').length,1);
});

test('a queued old timeout cannot take ownership of a later reconnect timer',async t=>{
 const f=fixture(t),surface=f.create();await flush();f.streams[0].fail();await flush();const oldTimeout=[...f.timers.values()][0].fn;
 await f.advance(4000,false);f.heartbeat();await flush();f.streams[1].fail();await flush();assert.equal(f.timers.size,1);
 oldTimeout();surface.destroy();await flush();assert.equal(f.timers.size,0);assert.equal(f.streams.length,2);
});

test('EventSource constructor failures recover with the same bounded scheduling',async t=>{
 const f=fixture(t);f.failConstructors(2);f.create();await flush();assert.equal(f.constructors,1);assert.equal(f.streams.length,0);
 await f.advance(1000);assert.equal(f.constructors,2);assert.equal(f.streams.length,0);
 await f.advance(1999);assert.equal(f.constructors,2);await f.advance(1);assert.equal(f.constructors,3);assert.equal(f.streams.length,1);
 f.streams[0].open();await flush();assert.equal(f.timers.size,0);
});

test('recovery does not replay a cancelled voice capture or accept its late transcript',async t=>{
 const f=fixture(t),voice=new VoiceSession(f.transport,async()=>({provider:'codex',model:'gpt-6-astra'}),'native',f.info);t.after(()=>voice.destroy());let message='';voice.onMessage=text=>message=text;
 voice.connect();await flush();const first=f.streams[0],client=new URL(first.url).searchParams.get('client');first.open();first.message({type:'wake',client});assert.equal(voice.mode,'listening');
 first.fail();await flush();assert.equal(voice.mode,'idle');assert.match(message,/connection interrupted/);
 await f.advance(1000);const next=f.streams[1];next.open();next.message({type:'transcript',client,text:'A late request must not run'});await flush();
 assert.equal(voice.mode,'idle');assert.equal(f.requests.some(request=>request.path==='/voice/text'),false);
 assert.deepEqual([...new Set(f.requests.map(request=>request.path))],['/voice/surface']);
});

test('native heartbeat replaces an OPEN socket whose last event predates sleep, exactly once',async t=>{
 const f=fixture(t),surface=f.create();await flush();const old=f.streams[0];old.open();await flush();
 await f.advance(30000,false);f.heartbeat();await flush();assert.equal(f.streams.length,1);
 await f.advance(1,false);f.heartbeat();await flush();assert.equal(f.streams.length,2);assert.equal(old.closes,1);
 const next=f.streams[1];assert.equal(new URL(next.url).searchParams.get('client'),surface.id);
 for(let i=0;i<4;i++){f.heartbeat();await flush()}assert.equal(f.streams.length,2);
 next.open();next.message({type:'heartbeat'});await flush();
 assert.deepEqual(f.events,[]);assert.deepEqual([...new Set(f.requests.map(request=>request.path))],['/voice/surface']);
});

test('observable server heartbeats keep a healthy socket alive without dispatching events or extra requests',async t=>{
 const f=fixture(t);f.create();await flush();const stream=f.streams[0];stream.open();await flush();
 for(let i=0;i<12;i++){
  await f.advance(10000,false);const before=f.requests.length;stream.message({type:'heartbeat'});await flush();assert.equal(f.requests.length,before);
  f.heartbeat();await flush();
 }
 assert.equal(f.streams.length,1);assert.equal(stream.closes,0);assert.deepEqual(f.events,[]);
});

test('window focus recovers a stale browser stream after renderer timers were suspended',async t=>{
 const f=fixture(t);f.create('web');await flush();const old=f.streams[0];old.open();await flush();
 await f.advance(8*60*60*1000,false);f.document.hidden=false;f.window.dispatchEvent(new Event('focus'));await flush();
 assert.equal(f.streams.length,2);assert.equal(old.closes,1);f.document.dispatchEvent(new Event('visibilitychange'));await flush();assert.equal(f.streams.length,2);
});

test('a new voice turn waits briefly for the recovered stream and submits once when it opens',async t=>{
 const f=fixture(t),requests=[];
 const voice=new VoiceSession(async(path,options)=>{requests.push({path,body:JSON.parse(options.body)});return {status:200,json:path==='/voice/text'?{reply:''}:null}},async()=>({provider:'codex',model:'gpt-6-astra'}),'native',f.info);t.after(()=>voice.destroy());
 voice.connect();await flush();const old=f.streams[0];old.open();await flush();await f.advance(30001,false);
 const pending=voice.sendText('A new request after waking');await flush();assert.equal(f.streams.length,2);
 assert.equal(requests.some(request=>request.body.focus),false);assert.equal(requests.some(request=>request.path==='/voice/text'),false);
 old.onmessage({data:JSON.stringify({type:'transcript',client:new URL(old.url).searchParams.get('client'),text:'Never replay this old transcript'})});
 f.streams[1].open();await pending;
 assert.equal(requests.filter(request=>request.body.focus).length,1);assert.equal(requests.filter(request=>request.path==='/voice/text').length,1);
 assert.equal(requests.find(request=>request.path==='/voice/text').body.transcript,'A new request after waking');assert.equal(voice.mode,'idle');
});

test('cancelling while the replacement stream connects never takes ownership or resends the cancelled turn',async t=>{
 const f=fixture(t),voice=new VoiceSession(f.transport,async()=>({provider:'codex',model:'gpt-6-astra'}),'native',f.info);t.after(()=>voice.destroy());
 voice.connect();await flush();f.streams[0].open();await flush();await f.advance(30001,false);
 const pending=voice.sendText('Cancel this request');await flush();voice.cancel();f.streams[1].open();await pending;
 assert.equal(f.requests.some(request=>request.body.focus),false);assert.equal(f.requests.some(request=>request.path==='/voice/text'),false);assert.equal(voice.mode,'idle');
});

test('a coordination timeout retires its socket and only a new user attempt can retry focus',async t=>{
 const f=fixture(t);let focusCount=0,signal;
 const surface=new VoiceSurface(async(path,options)=>{const body=JSON.parse(options.body);if(body.focus){focusCount++;signal=options.signal;return new Promise(()=>{})}return f.transport(path,options)},'native',()=> 'idle',async()=>true,()=>{},f.info);t.after(()=>surface.destroy());
 await flush();const old=f.streams[0];old.open();await flush();const pending=assert.rejects(surface.focus(),/coordination timed out/);await flush();
 await f.advance(5000);await pending;assert.equal(signal.aborted,true);assert.equal(old.closes,1);assert.equal(focusCount,1);
 await f.advance(1000);assert.equal(f.streams.length,2);f.streams[1].open();await flush();assert.equal(focusCount,1);
});

test('connection readiness is bounded and destruction cancels its waiting timer',async t=>{
 const f=fixture(t),surface=f.create();await flush();const first=f.streams[0];const timeout=assert.rejects(surface.focus(),/reconnecting/);await flush();
 await f.advance(5000);await timeout;assert.equal(first.closes,1);await f.advance(1000);assert.equal(f.streams.length,2);
 const disposed=assert.rejects(surface.focus(),/interrupted/);await flush();surface.destroy();await disposed;await flush();
 assert.equal(f.timers.size,0);assert.equal(f.requests.some(request=>request.body.focus),false);
});

test('a normal focus on a healthy stream adds no reconnect timer',async t=>{
 const f=fixture(t),surface=f.create();await flush();f.streams[0].open();await flush();await surface.focus();
 assert.equal(f.requests.filter(request=>request.body.focus).length,1);assert.equal(f.timers.size,0);assert.equal(f.streams.length,1);
});

test('an already queued readiness timeout cannot retire a stream after readiness settled',async t=>{
 const f=fixture(t),surface=f.create();await flush();const pending=surface.focus();await flush();const staleTimeout=[...f.timers.values()][0].fn;
 f.streams[0].open();await pending;staleTimeout();await flush();
 assert.equal(f.streams[0].closes,0);assert.equal(f.streams.length,1);assert.equal(f.timers.size,0);
});

test('a delayed coordination timeout from the old socket cannot close its healthy replacement',async t=>{
 const f=fixture(t);let delayHeartbeat=false;
 const surface=new VoiceSurface(async(path,options)=>{if(delayHeartbeat){delayHeartbeat=false;return new Promise(()=>{})}return f.transport(path,options)},'native',()=> 'idle',async()=>true,()=>{},f.info);t.after(()=>surface.destroy());
 await flush();const old=f.streams[0];old.open();await flush();delayHeartbeat=true;const pending=surface.tick();await flush();const delayedTimeout=[...f.timers.values()][0].fn;
 await f.advance(30001,false);f.heartbeat();await flush();assert.equal(f.streams.length,2);const next=f.streams[1];next.open();await flush();
 delayedTimeout();await pending;assert.equal(old.closes,1);assert.equal(next.closes,0);assert.equal(f.streams.length,2);
});

test('an already queued coordination timeout cannot close the socket after its response arrived',async t=>{
 const f=fixture(t);let complete;
 const surface=new VoiceSurface(async(path,options)=>{if(JSON.parse(options.body).focus)return new Promise(resolve=>complete=resolve);return f.transport(path,options)},'native',()=> 'idle',async()=>true,()=>{},f.info);t.after(()=>surface.destroy());
 await flush();f.streams[0].open();await flush();const pending=surface.focus();await flush();const delayedTimeout=[...f.timers.values()][0].fn;
 complete({status:200,json:null});await pending;delayedTimeout();await flush();assert.equal(f.streams[0].closes,0);assert.equal(f.timers.size,0);
});

test('a replacement rejected while its old server socket closes retries with the same identity',async t=>{
 const f=fixture(t),surface=f.create();await flush();f.streams[0].open();await flush();await f.advance(30001,false);f.heartbeat();await flush();
 const rejected=f.streams[1];rejected.fail(2);await flush();assert.equal(f.streams.length,2);assert.equal(f.timers.size,1);
 await f.advance(1000);assert.equal(f.streams.length,3);const next=f.streams[2];next.open();await flush();
 assert.equal(new URL(next.url).searchParams.get('client'),surface.id);assert.equal(rejected.closes,1);assert.equal(f.timers.size,0);
 assert.equal(f.requests.some(request=>request.body.focus),false);assert.equal(f.requests.some(request=>['/voice/text','/voice/audio'].includes(request.path)),false);
});
