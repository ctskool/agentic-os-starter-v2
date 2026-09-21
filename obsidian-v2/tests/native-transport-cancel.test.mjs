import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundled=await build({entryPoints:['src/lib/v2-voice.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'native-cancel-fixture',setup(builder){
 builder.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'fixture'}));
 builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const requestUrl = options => globalThis.cancelTransportRequest(options);',loader:'js'}));
}}]});
const {configureVoiceTransport,v2VoiceTransport}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));

test('cancel during native credential loading cannot dispatch the queued request',async t=>{
 const previous=globalThis.cancelTransportRequest;t.after(()=>{globalThis.cancelTransportRequest=previous});
 let release,requests=0;
 const credential=new Promise(resolve=>{release=resolve});
 configureVoiceTransport({vault:{adapter:{getBasePath:()=>'/vault',read:()=>credential}}},'.obsidian/plugins/agentic-os-v2');
 globalThis.cancelTransportRequest=async()=>{requests++;return {status:200,headers:{'content-type':'application/json'},json:{ok:true}}};
 const controller=new AbortController();
 const pending=v2VoiceTransport('/voice/text',{method:'POST',body:'{"transcript":"Do the task"}',signal:controller.signal});
 controller.abort();release(JSON.stringify({version:1,token:'a'.repeat(64)}));
 await assert.rejects(pending,/aborted/);assert.equal(requests,0);
});

test('cancel after native authentication rejection prevents credential retry dispatch',async t=>{
 const previous=globalThis.cancelTransportRequest;t.after(()=>{globalThis.cancelTransportRequest=previous});
 let requests=0,reads=0;const controller=new AbortController();
 configureVoiceTransport({vault:{adapter:{getBasePath:()=>'/vault',read:async()=>JSON.stringify({version:1,token:(++reads===1?'a':'b').repeat(64)})}}},'.obsidian/plugins/agentic-os-v2');
 globalThis.cancelTransportRequest=async()=>{requests++;controller.abort();return {status:401,headers:{'content-type':'application/json'},json:{error:'authentication required'}}};
 await assert.rejects(v2VoiceTransport('/voice/audio',{method:'POST',body:new ArrayBuffer(1000),signal:controller.signal}),/aborted/);
 assert.equal(requests,1);
});
