import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const built=await build({entryPoints:['shared/voice-session.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {VoiceSession}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve()};

for(const provider of ['codex','claude'])test(`${provider}: a stuck route times out even when native transport ignores AbortSignal`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let finish,signal;const calls=[],messages=[],replies=[];
 const voice=new VoiceSession(async(path,options)=>{calls.push({path,options});if(path==='/voice/text'){signal=options.signal;return new Promise(resolve=>finish=resolve)}return {status:200}},async()=>({provider,model:provider==='codex'?'gpt-6-astra':'sonnet'}));
 t.after(()=>voice.destroy());voice.onMessage=text=>messages.push(text);voice.onReply=reply=>replies.push(reply);
 const pending=voice.sendText('Explain the saved result');await flush();assert.equal(voice.mode,'working');
 t.mock.timers.tick(120000);await flush();assert.equal(voice.mode,'error');assert.equal(signal.aborted,true);
 assert.match(messages.at(-1),/timed out/i);assert.equal(calls.filter(call=>call.path==='/voice/cancel').length,1);
 await pending;finish({status:200,json:{reply:'Late answer'}});await flush();assert.equal(replies.length,0);
});

test('a successful route clears its timeout and never sends a late cancellation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const calls=[];
 const voice=new VoiceSession(async(path)=>{calls.push(path);return {status:200,json:{reply:''}}},async()=>({provider:'codex',model:'gpt-6-astra'}));t.after(()=>voice.destroy());
 await voice.sendText('Open a saved report');t.mock.timers.tick(120001);await flush();assert.equal(voice.mode,'idle');assert.deepEqual(calls,['/voice/text']);
});
