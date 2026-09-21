import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundled=await build({entryPoints:['src/lib/v2-voice.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'obsidian-test-transport',setup(build){
 build.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'fixture'}));
 build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const requestUrl = options => globalThis.nativeTransportRequest(options);',loader:'js'}));
}}]});
const {configureVoiceTransport,v2VoiceTransport}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
test('native writes refresh a rotated token once without changing the original body',async t=>{
 const previous=globalThis.nativeTransportRequest;t.after(()=>{globalThis.nativeTransportRequest=previous});
 const requests=[];let reads=0;
 configureVoiceTransport({vault:{adapter:{getBasePath:()=>'/vault',read:async file=>{assert.equal(file,'.obsidian/plugins/agentic-os-v2/bridge-auth.json');return JSON.stringify({version:1,token:(++reads===1?'a':'b').repeat(64)})}}}},'.obsidian/plugins/agentic-os-v2');
 globalThis.nativeTransportRequest=async options=>{requests.push(options);return {status:requests.length===1?401:200,headers:{'content-type':'application/json'},json:{ok:true}}};
 assert.equal((await v2VoiceTransport('/work/start',{method:'POST',body:'{"prompt":"Keep this exact text"}'})).status,200);
 assert.equal(requests.length,2);assert.equal(requests[0].body,requests[1].body);assert.equal(requests[0].headers['X-V2-Token'],'a'.repeat(64));assert.equal(requests[1].headers['X-V2-Token'],'b'.repeat(64));
 await v2VoiceTransport('/work');assert.equal(requests[2].headers['X-V2-Token'],'b'.repeat(64));assert.equal(reads,2);
 assert.ok(requests.every(request=>request.headers['X-V2-App']==='native'));
});
test('native auth failure never dispatches a write and preview delegates to its own shim',async t=>{
 const previous=globalThis.nativeTransportRequest;t.after(()=>{globalThis.nativeTransportRequest=previous});let requests=0;
 globalThis.nativeTransportRequest=async options=>{requests++;assert.equal(options.headers['X-V2-Token'],undefined);assert.equal(options.headers['X-V2-App'],undefined);return {status:200,headers:{'content-type':'application/json'},json:{ok:true}}};
 configureVoiceTransport({vault:{adapter:{getBasePath:()=>'/vault',read:async()=>{throw new Error('missing')}}}},'.obsidian/plugins/agentic-os-v2');
 await assert.rejects(v2VoiceTransport('/work/start',{method:'POST',body:'{}'}),/Start the V2 bridge/);assert.equal(requests,0);
 await assert.rejects(v2VoiceTransport('/work'),/Start the V2 bridge/);assert.equal(requests,0);
 configureVoiceTransport({vault:{adapter:{}}},'.obsidian/plugins/agentic-os-v2');await v2VoiceTransport('/work/start',{method:'POST',body:'{}'});assert.equal(requests,1);
});

test('native conversation reads refresh authorization and retain native scope on retry',async t=>{
 const previous=globalThis.nativeTransportRequest;t.after(()=>{globalThis.nativeTransportRequest=previous});
 const requests=[];let reads=0;
 configureVoiceTransport({vault:{adapter:{getBasePath:()=>'/vault',read:async()=>JSON.stringify({version:1,token:(++reads===1?'c':'d').repeat(64)})}}},'.obsidian/plugins/agentic-os-v2');
 globalThis.nativeTransportRequest=async options=>{requests.push(options);return {status:requests.length===1?401:200,headers:{'content-type':'application/json'},json:{current:{codex:null,claude:null}}}};
 const result=await v2VoiceTransport('/work?summary=1');
 assert.equal(result.status,200);assert.equal(requests.length,2);assert.equal(reads,2);
 assert.ok(requests.every(request=>request.method==='GET'&&request.headers['X-V2-App']==='native'));
 assert.equal(requests[0].headers['X-V2-Token'],'c'.repeat(64));assert.equal(requests[1].headers['X-V2-Token'],'d'.repeat(64));
});
