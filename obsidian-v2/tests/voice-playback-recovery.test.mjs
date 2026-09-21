import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {VoiceHub} from '../runner/voice-hub.mjs';
const built=await build({entryPoints:['shared/voice-session.ts','shared/voice-surface.ts'],bundle:true,platform:'node',format:'esm',outdir:'unused',write:false});
const modules=await Promise.all(built.outputFiles.map(file=>import('data:text/javascript;base64,'+Buffer.from(file.text).toString('base64'))));
const {VoiceSession}=modules.find(m=>m.VoiceSession),{VoiceSurface}=modules.find(m=>m.VoiceSurface);
const chosen={provider:'codex',model:'gpt-6-astra'},flush=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve))};
function fixture(t){
 let now=0,id=0;const timers=new Map();
 const replace=(key,value)=>{const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});t.after(()=>old?Object.defineProperty(globalThis,key,old):delete globalThis[key])};
 replace('Audio',undefined);replace('AudioContext',undefined);replace('window',undefined);
 t.mock.method(globalThis,'setTimeout',(fn,delay)=>{timers.set(++id,{fn,at:now+delay});return id});t.mock.method(globalThis,'clearTimeout',key=>timers.delete(key));
 const advance=async milliseconds=>{now+=milliseconds;for(let pass=0;pass<20;pass++){const due=[...timers].filter(([,timer])=>timer.at<=now);if(!due.length)break;for(const [key,timer] of due){timers.delete(key);timer.fn()}await flush()}};
 return {replace,advance,timers};
}
test('voice errors recover to idle without clearing the written error, and cancellation removes recovery timers',async t=>{
 const f=fixture(t),voice=new VoiceSession(async()=>{throw new Error('Bridge offline')},async()=>chosen);let message='';voice.onMessage=text=>message=text;
 await voice.sendText('A request');assert.equal(voice.mode,'error');assert.match(message,/Bridge offline/);
 await f.advance(4000);assert.equal(voice.mode,'idle');assert.match(message,/Bridge offline/);
 await voice.sendText('Retry');voice.cancel();assert.equal(f.timers.size,0);await voice.destroy();
});
test('suspended or never-resolving audio resume is bounded before synthesis and cancelled waits release immediately',async t=>{
 const f=fixture(t);let calls=0;
 f.replace('AudioContext',class{state='suspended';resume(){return new Promise(()=>{})}close(){return Promise.resolve()}});
 const voice=new VoiceSession(async()=>{calls++;return {status:200,audio:new ArrayBuffer(1)}},async()=>chosen);
 const pending=voice.speak('The written result');await flush();await f.advance(2500);assert.equal(await pending,false);assert.equal(calls,0);assert.equal(voice.mode,'error');
 await f.advance(4000);assert.equal(voice.mode,'idle');
 const cancelled=voice.speak('Cancelled result');await flush();voice.cancel();assert.equal(await cancelled,false);assert.equal(voice.mode,'idle');assert.equal(calls,0);await voice.destroy();
 f.replace('AudioContext',class{state='suspended';resume(){return Promise.resolve()}close(){return Promise.resolve()}});
 const suspended=new VoiceSession(async()=>{calls++;return {status:200}},async()=>chosen);assert.equal(await suspended.speak('Still suspended'),false);assert.equal(calls,0);await suspended.destroy();
});
test('buffered playback without an ended event times out and releases its source without replay',async t=>{
 const f=fixture(t);let stops=0,disconnects=0,calls=0;
 f.replace('AudioContext',class{state='running';destination={};resume(){return Promise.resolve()}close(){return Promise.resolve()}decodeAudioData(){return Promise.resolve({duration:1})}createAnalyser(){return {disconnect(){},connect(){}}}createBufferSource(){return {connect(){},disconnect(){disconnects++},start(){},stop(){stops++}}}});
 const voice=new VoiceSession(async()=>{calls++;return {status:200,audio:new ArrayBuffer(1)}},async()=>chosen);let message='';voice.onMessage=text=>message=text;
 const pending=voice.speak('Keep this written result');await flush();assert.equal(voice.mode,'speaking');await f.advance(6000);
 assert.equal(await pending,false);assert.equal(voice.mode,'error');assert.equal(calls,1);assert.equal(stops,1);assert.equal(disconnects,1);assert.match(message,/Keep this written result/);await voice.destroy();
});
test('web gesture unlock enables claiming and all gesture listeners are removed on destroy',async t=>{
 const f=fixture(t),window=new EventTarget(),requests=[];let allowed=false,context;
 f.replace('window',window);f.replace('document',{hidden:false});f.replace('EventSource',class{close(){}});
 f.replace('AudioContext',class{state='suspended';constructor(){context=this}resume(){if(allowed)this.state='running';return Promise.resolve()}close(){return Promise.resolve()}});
 const voice=new VoiceSession(async(path,options)=>{requests.push({path,body:JSON.parse(options.body)});return {status:200,json:null}},async()=>chosen,'web');voice.connect();await flush();
 assert.ok(requests.some(r=>r.path==='/voice/surface'&&r.body.canPlay===false));assert.equal(await voice.speak('Written announcement'),false);
 allowed=true;window.dispatchEvent(new Event('pointerdown'));await flush();assert.equal(context.state,'running');assert.ok(requests.some(r=>r.path==='/voice/surface'&&r.body.canPlay===true));
 await voice.destroy();const count=requests.length;window.dispatchEvent(new Event('keydown'));await flush();assert.equal(requests.length,count);
});
test('surface presence reports actual working state and partial playback is acknowledged once',async t=>{
 fixture(t);let mode='idle',finish,claimed=false;const requests=[];
 const surface=new VoiceSurface(async(path,options)=>{const body=JSON.parse(options.body);requests.push({path,body});if(path==='/voice/surface'&&!claimed){claimed=true;return {status:200,json:{id:'item',text:'Announcement'}}}return {status:200,json:null}},'native',()=>mode,()=>new Promise(resolve=>finish=resolve),()=>{});
 const pending=surface.tick();await flush();mode='working';await surface.tick();assert.equal(requests.at(-1).body.mode,'working');assert.equal(requests.at(-1).body.playbackStarted,false);assert.equal(requests.at(-1).body.claim,false);
 mode='speaking';await surface.tick();assert.equal(requests.at(-1).body.playbackStarted,true);mode='idle';finish({ok:false,started:true});await pending;
 assert.equal(requests.find(r=>r.path==='/voice/ack').body.ok,true);surface.destroy();
});
test('hub bypasses an errored or locked owner, expires hung leases, and never repeats started audio',()=>{
 let now=1;const hub=new VoiceHub({now:()=>now,leaseMs:100});
 const web=(mode='idle',extra={})=>({id:'web',kind:'web',visible:true,mode,...extra}),native=(mode='idle')=>({id:'native',kind:'native',visible:true,mode});
 hub.presence(web('error',{focus:true}));hub.presence(native());hub.publish('one','One');assert.equal(hub.presence({...native(),claim:false}),null);assert.equal(hub.presence(native()).id,'one');hub.ack('one','native',true);
 hub.presence(web('idle',{canPlay:false,focus:true}));hub.publish('two','Two');assert.equal(hub.presence(native()).id,'two');hub.ack('two','native',true);
 hub.presence(web('idle',{canPlay:true,focus:true}));hub.publish('hung','Never started');assert.equal(hub.presence(web()).id,'hung');hub.presence(web('working'));now=102;
 assert.equal(hub.presence(native()).id,'hung');hub.ack('hung','native',true);
 hub.presence(web('idle',{focus:true}));hub.publish('partial','Partial audio');assert.equal(hub.presence(web()).id,'partial');hub.presence(web('speaking',{playbackId:'partial',playbackStarted:true}));hub.publish('next','Next announcement');now=203;
 assert.equal(hub.presence(native()).id,'next');assert.ok(hub.items.find(item=>item.id==='partial').delivered);
});
