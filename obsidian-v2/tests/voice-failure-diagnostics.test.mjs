import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {ROOT,validateSelection} from '../shared/contract.mjs';
import {vaultPath,writeJson} from '../runner/core.mjs';
import {readCurrentState,reconcileCurrent,readConversationEpoch} from '../runner/current-conversations.mjs';
import {readJson} from '../runner/bridge-core.mjs';

// Exercise the actual HTTP handler without starting services, recording audio,
// or contacting a provider. Only the routing/STT boundaries are substituted.
const source=fs.readFileSync(new URL('../runner/bridge.mjs',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const marker="server.on('request',async(req,res)=>{";
const start=source.indexOf(marker),end=source.indexOf('\n});\n{\n // Mint',start);
assert.ok(start>=0&&end>start);
const createHandler=new Function('deps',`const {preconnectJev=()=>false,classifierProcesses=()=>({running:0,detached:0,total:0}),root,fs,ROOT,origins,bridgeAuth,uuid,body,terminals,readCurrentState,reconcileCurrent,readConversationEpoch,readJson,vaultPath,writeJson,validateSelection,routeVoice,active,speech,fetch,hub,artifactTarget,artifacts}=deps;return async(req,res)=>{${source.slice(start+marker.length,end)}\n};`);
const uuid=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);

function fixture(t,{scope='native',provider='codex',route=async()=>{throw new Error('Voice classification timed out')},stt=async()=>({ok:true,json:async()=>({text:'Pull up the morning intel brief.'})}),write=writeJson}={}){
 const temp=path.resolve(os.tmpdir()),root=fs.mkdtempSync(path.join(temp,'voice-failure-diagnostics-'));
 t.after(()=>{assert.equal(path.dirname(root),temp);assert.ok(path.basename(root).startsWith('voice-failure-diagnostics-'));fs.rmSync(root,{recursive:true,force:true})});
 const active=new Map(),chosen={provider,model:provider==='codex'?'gpt-6-astra':'sonnet'};let routes=0,bodyReads=0;
 const handler=createHandler({root,fs,ROOT,origins:new Set(),bridgeAuth:{accepts:()=>true},uuid,terminals:{},readCurrentState,reconcileCurrent,readConversationEpoch,readJson,vaultPath,writeJson:write,validateSelection,active,speech:'http://test-speech',fetch:stt,hub:{live:()=>[]},artifactTarget:()=>null,artifacts:{bind(){}},
  body:async req=>{bodyReads++;return Buffer.isBuffer(req.payload)?req.payload:Buffer.from(JSON.stringify(req.payload))},
  routeVoice:async(...args)=>{routes++;return route(...args)}
 });
 let lastResponse;
 const request=async(url,payload={},headers={})=>{
  const response=Object.assign(new EventEmitter(),{headersSent:false,writableEnded:false,destroyed:false,status:null,value:null,setHeader(){},writeHead(status){this.status=status;this.headersSent=true},end(text){this.writableEnded=true;this.value=text?JSON.parse(text):null}});lastResponse=response;
  await handler({url,method:'POST',payload,headers:{host:'127.0.0.1:3219','x-v2-app':scope,...headers}},response);return response;
 };
 const voice=({id=crypto.randomUUID(),text='Pull up the morning intel brief.',audio=false,targetId=null,headers={}}={})=>request(audio?'/voice/audio':'/voice/text',audio?Buffer.alloc(2000):{transcript:text,unrelated:'Do not save this payload'},
  {'x-v2-request':id,'x-v2-selection':JSON.stringify(chosen),'x-v2-work':JSON.stringify({targetId,context:'Do not save conversation context'}),'x-v2-token':'Do not save this auth token',...headers});
 return {root,active,voice,request,get response(){return lastResponse},claim:id=>readJson(root,`${ROOT}/voice-requests/${id}.json`,null),claimPath:id=>vaultPath(root,`${ROOT}/voice-requests/${id}.json`),counts:()=>({routes,bodyReads})};
}

for(const audio of [false,true])for(const scope of ['native','web'])test(`${scope} ${audio?'audio':'text'} disconnect aborts routing and releases the single-flight slot`,async t=>{
 let started,signal;const entered=new Promise(resolve=>started=resolve);
 const f=fixture(t,{scope,route:async(_root,_request,stop)=>{signal=stop;started();await new Promise((_,reject)=>stop.addEventListener('abort',()=>reject(new Error('Voice request cancelled')),{once:true}))}}),id=crypto.randomUUID();
 const pending=f.voice({id,audio});await entered;const response=f.response;
 try{response.destroyed=true;response.emit('close');assert.equal(signal.aborted,true)}finally{await f.request('/voice/cancel',{id});await pending}
 assert.equal(f.active.size,0);assert.equal(f.claim(id).cancelled,true);assert.equal(response.listenerCount('close'),0);
 const replay=await f.voice({id});assert.match(replay.value.error,/cancelled|already submitted/);assert.equal(f.counts().routes,1);
});

test('a normal response completion does not cancel accepted work',async t=>{
 let signal;const f=fixture(t,{route:async(_root,request,stop)=>{signal=stop;return {...request,provider:'codex',reply:'Done'}}});
 const response=await f.voice();assert.equal(response.status,200);response.emit('close');assert.equal(signal.aborted,false);assert.equal(response.listenerCount('close'),0);
});

for(const audio of [false,true])for(const scope of ['native','web'])for(const provider of ['codex','claude'])test(`${scope} ${provider} ${audio?'audio':'text'} routing failure preserves bounded evidence without voice memory`,async t=>{
 const f=fixture(t,{scope,provider}),id=crypto.randomUUID(),targetId=crypto.randomUUID();
 const response=await f.voice({id,audio,targetId});
 assert.equal(response.status,400);assert.equal(response.value.error,'Voice classification timed out');
 const claim=f.claim(id);assert.equal(claim.id,id);assert.equal(claim.provider,provider);assert.equal(claim.appScope,scope);assert.equal(claim.source,audio?'audio':'text');assert.equal(claim.workTarget,targetId);
 assert.equal(claim.transcript,'Pull up the morning intel brief.');assert.equal(claim.stage,'routing');assert.equal(claim.error,response.value.error);assert.equal(claim.cancelled,false);
 for(const key of ['ts','updatedAt','failedAt'])assert.ok(Number.isFinite(Date.parse(claim[key])),key);
 assert.deepEqual(Object.keys(claim).sort(),['appScope','cancelled','error','failedAt','id','model','provider','source','stage','transcript','ts','updatedAt','workTarget'].sort());
 assert.equal(fs.existsSync(vaultPath(f.root,`${ROOT}/voice-results/${id}.json`)),false);assert.equal(f.active.size,0);assert.deepEqual(f.counts(),{routes:1,bodyReads:1});
});

test('oversized strings are bounded and invalid target metadata is not retained',async t=>{
 const message='Provider failure '.repeat(200),text='Long transcript '.repeat(400),f=fixture(t,{route:async()=>{throw new Error(message)}}),id=crypto.randomUUID();
 const response=await f.voice({id,text,targetId:{privatePrompt:'Do not save this'}});
 assert.equal(response.status,400);assert.equal(response.value.error,message);assert.equal(f.claim(id).transcript,text.slice(0,4000));assert.equal(f.claim(id).error,message.slice(0,1000));assert.equal(f.claim(id).workTarget,undefined);
});

test('transcription failures identify the stage without storing audio or inventing a transcript',async t=>{
 const f=fixture(t,{stt:async()=>({ok:false})}),id=crypto.randomUUID(),response=await f.voice({id,audio:true});
 assert.equal(response.status,400);assert.match(response.value.error,/Local transcription failed/);assert.equal(f.claim(id).stage,'transcribing');assert.equal(f.claim(id).transcript,undefined);assert.equal(f.claim(id).error,response.value.error);assert.equal(f.counts().routes,0);assert.equal(f.active.size,0);
});

test('post-transcription validation failures keep the transcript without parsing context into diagnostics',async t=>{
 const f=fixture(t),id=crypto.randomUUID(),response=await f.voice({id,headers:{'x-v2-work':'{broken'}});
 assert.equal(response.status,400);assert.equal(f.claim(id).stage,'validating');assert.equal(f.claim(id).transcript,'Pull up the morning intel brief.');assert.equal(f.claim(id).workTarget,undefined);assert.equal(f.counts().routes,0);
});

test('failed request replay preserves the original claim byte for byte and never redispatches',async t=>{
 const f=fixture(t),id=crypto.randomUUID();await f.voice({id});const before=fs.readFileSync(f.claimPath(id)),counts=f.counts();
 const replay=await f.voice({id,text:'Different replacement text',targetId:crypto.randomUUID()});
 assert.equal(replay.status,400);assert.match(replay.value.error,/already submitted/);assert.deepEqual(fs.readFileSync(f.claimPath(id)),before);assert.deepEqual(f.counts(),counts);assert.equal(f.active.size,0);
});

test('best-effort diagnostic failures preserve the original routing error and mandatory duplicate guard',async t=>{
 let writes=0;const f=fixture(t,{write:(...args)=>{if(++writes>1)throw new Error('Diagnostic storage unavailable');return writeJson(...args)}}),id=crypto.randomUUID();
 const response=await f.voice({id});assert.equal(response.status,400);assert.equal(response.value.error,'Voice classification timed out');assert.equal(f.claim(id).id,id);assert.equal(f.active.size,0);assert.equal(writes,3);
 const before=fs.readFileSync(f.claimPath(id));assert.match((await f.voice({id})).value.error,/already submitted/);assert.deepEqual(fs.readFileSync(f.claimPath(id)),before);assert.equal(f.counts().routes,1);
});

test('a failed mandatory claim still prevents routing',async t=>{
 const f=fixture(t,{write:()=>{throw new Error('Claim storage unavailable')}}),id=crypto.randomUUID(),response=await f.voice({id});
 assert.equal(response.value.error,'Claim storage unavailable');assert.equal(f.claim(id),null);assert.deepEqual(f.counts(),{routes:0,bodyReads:0});assert.equal(f.active.size,0);
});

test('completed requests retain their normal response and replay from the original receipt',async t=>{
 const f=fixture(t,{route:async(root,request)=>{const result={...request,provider:request.selection.provider,requestedWorkerModel:request.selection.model,reply:'Opened.'};writeJson(root,`${ROOT}/voice-results/${request.id}.json`,result);return result}}),id=crypto.randomUUID();
 const response=await f.voice({id});assert.equal(response.status,200);assert.equal(response.value.reply,'Opened.');assert.equal(f.claim(id).stage,'completed');assert.ok(Date.parse(f.claim(id).completedAt));assert.equal(f.claim(id).error,undefined);
 const before=fs.readFileSync(f.claimPath(id)),counts=f.counts(),replay=await f.voice({id,text:'Do not overwrite this receipt'});assert.equal(replay.status,200);assert.deepEqual(replay.value,response.value);assert.deepEqual(fs.readFileSync(f.claimPath(id)),before);assert.deepEqual(f.counts(),counts);
});

test('live cancellation records failure without weakening cancelled-ID protection',async t=>{
 let started;const entered=new Promise(resolve=>started=resolve);
 const f=fixture(t,{route:async(_root,_request,signal)=>{started();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('Voice request cancelled')),{once:true}))}}),id=crypto.randomUUID();
 const pending=f.voice({id});await entered;const cancel=await f.request('/voice/cancel',{id});assert.equal(cancel.status,200);
 const response=await pending;assert.equal(response.status,400);assert.equal(response.value.error,'Voice request cancelled');assert.equal(f.claim(id).cancelled,true);assert.equal(f.claim(id).stage,'routing');assert.equal(f.active.size,0);
 const before=fs.readFileSync(f.claimPath(id)),counts=f.counts(),replay=await f.voice({id});assert.match(replay.value.error,/cancelled/);assert.deepEqual(fs.readFileSync(f.claimPath(id)),before);assert.deepEqual(f.counts(),counts);
});
