import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['shared/voice-session.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {VoiceSession}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));

function replace(t,key,value){const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});t.after(()=>old?Object.defineProperty(globalThis,key,old):delete globalThis[key])}
const written='Here are the results.\n\n## File details\n\n| Name | Value |\n| --- | --- |\n| Progress | 42 |';
const spoken='I found the results. The full details are in the written reply.';
function playback(t,streamed,heard){
 replace(t,'AudioContext',class{state='running';destination={};resume(){return Promise.resolve()}close(){return Promise.resolve()}decodeAudioData(){return Promise.resolve({duration:1})}createAnalyser(){return {disconnect(){},connect(){}}}createMediaElementSource(){return {connect(){},disconnect(){}}}createBufferSource(){return {connect(){},disconnect(){},start(){queueMicrotask(()=>this.onended?.())},stop(){}}}});
 replace(t,'Audio',streamed?class{set src(url){heard.push(new URL(url).searchParams.get('text'))}play(){queueMicrotask(()=>{this.onplaying?.();this.onended?.()});return Promise.resolve()}pause(){}load(){}removeAttribute(){}}:undefined);
}
for(const provider of ['codex','claude'])for(const kind of ['native','web'])for(const streamed of [true,false]){
 test(`${provider} ${kind} ${streamed?'streaming':'buffered'} speech uses the prepared reply while display keeps the complete answer`,async t=>{
  const heard=[],displayed=[],replies=[],requests=[];playback(t,streamed,heard);
  const response={reply:written,spokenReply:spoken};
  const session=new VoiceSession(async(path,options)=>{
   requests.push(path);
   if(path==='/voice/text')return {status:200,json:response};
   assert.equal(path,'/voice/speak');heard.push(JSON.parse(options.body).text);return {status:200,audio:new ArrayBuffer(8)};
  },async()=>({provider,model:provider==='codex'?'gpt-6-astra':'claude-opus-4-6'}),kind);
  t.after(()=>session.destroy());session.onMessage=text=>displayed.push(text);session.onReply=value=>replies.push(value);
  await session.sendText('Explain the report');
  assert.deepEqual(heard,[spoken]);assert.deepEqual(displayed,[written]);assert.deepEqual(replies,[response]);
  assert.deepEqual(requests,streamed?['/voice/text']:['/voice/text','/voice/speak']);assert.equal(session.mode,'idle');
 });
}
for(const prepared of [undefined,'   ',123])test(`old or invalid spoken reply ${JSON.stringify(prepared)} falls back to the written answer`,async t=>{
 const heard=[];playback(t,true,heard);
 const session=new VoiceSession(async()=>({status:200,json:{reply:'The saved answer is ready.',spokenReply:prepared}}),async()=>({provider:'codex',model:'gpt-6-astra'}));
 t.after(()=>session.destroy());await session.sendText('Read the answer');assert.deepEqual(heard,['The saved answer is ready.']);
});
