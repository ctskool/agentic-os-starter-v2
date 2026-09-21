import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {prepareJev,takePreparedJev,dropPreparedJev,preparedJevState,trackOwnedWork,classifyJev,hedgeClassifier,drainDetachedClassifiers,jevState,JEV_REVISION} from '../runner/jev.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const tick=(ms=0)=>new Promise(resolve=>setTimeout(resolve,ms));
const KEY='sk-or-SENTINEL-key-000000';
const config=(fields={})=>({key:KEY,mode:{codex:'fastpath',claude:'fastpath'},theta:0.9,deadlineMs:600,tier2kind:false,rulebook:'v1',openVeto:false,...fields});
const answer=JSON.stringify({model:JEV_REVISION,answers:{route:{type:'choice',choice:'tier3',probabilities:{tier3:0.97,tier2:0.03}}}});
const state=jevState({transcript:'make a guide'});

// A transport that records everything and sends nothing.
function transport(){
 const made=[];
 const request=(options,onResponse)=>{
  const req=new EventEmitter();
  Object.assign(req,{options,headers:{...(options.headers||{})},ended:null,destroyed:false,headersSent:false,reusedSocket:false,
   setHeader(name,value){if(req.headersSent)throw new Error('headers already sent');req.headers[name]=value},
   end(raw){if(req.failEnd)throw new Error('end failed');req.headersSent=true;req.ended=raw},
   destroy(){req.destroyed=true},
   respond(status=200,text=answer){const response=new EventEmitter();response.statusCode=status;response.resume=()=>{};(onResponse||(()=>{}))(response);req.emit('response',response);queueMicrotask(()=>{response.emit('data',Buffer.from(text));response.emit('end')})}});
  made.push(req);return req;
 };
 const socket=(fields={})=>Object.assign(new EventEmitter(),{connecting:false,secureConnecting:false,destroyed:false,writable:true,authorized:true,...fields});
 const agents=[];const createAgent=()=>{const agent={destroyed:false,destroy(){agent.destroyed=true}};agents.push(agent);return agent};
 return {made,request,socket,agents,createAgent};
}
const clean=()=>dropPreparedJev();

test('a prepared request is opened with no headers, no key and no body',()=>{
 clean();const t=transport();
 assert.equal(prepareJev({config:config(),request:t.request,createAgent:t.createAgent}),true);
 assert.equal(t.made.length,1);
 const {options}=t.made[0];
 assert.deepEqual(Object.keys(options).sort(),['agent','hostname','method','path']);
 assert.equal(options.hostname,'openrouter.ai');assert.equal(options.path,'/api/alpha/decisions');assert.equal(options.method,'POST');
 assert.equal(t.made[0].ended,null);assert.deepEqual(t.made[0].headers,{});
 assert.ok(!JSON.stringify({options:{...options,agent:undefined},headers:t.made[0].headers}).includes('SENTINEL'));
 clean();assert.equal(t.made[0].destroyed,true);assert.equal(t.agents[0].destroyed,true);
});

test('nothing is opened when Jev is off, the key is missing, or the chosen provider is off',()=>{
 clean();const t=transport(),open=fields=>prepareJev({request:t.request,createAgent:t.createAgent,...fields});
 assert.equal(open({config:config({mode:{codex:'off',claude:'off'}})}),false);
 assert.equal(open({config:config({key:''})}),false);
 assert.equal(open({config:config({mode:{codex:'off',claude:'fastpath'}}),provider:'codex'}),false);
 assert.equal(t.made.length,0);
 assert.equal(open({config:config({mode:{codex:'off',claude:'shadow'}}),provider:'claude'}),true);
 assert.equal(t.made.length,1);clean();
 // Under the test runner the real configuration is off, so the real bridge call opens nothing.
 assert.equal(prepareJev({request:t.request,createAgent:t.createAgent}),false);assert.equal(t.made.length,1);
});

test('only a ready, young, unused request is taken, exactly once; anything else is destroyed and today\'s path runs',()=>{
 clean();const t=transport(),open=now=>prepareJev({config:config(),now,request:t.request,createAgent:t.createAgent});
 // Not ready yet: the handshake has not finished. Never waited for.
 open(0);t.made[0].emit('socket',t.socket({secureConnecting:true}));
 assert.equal(takePreparedJev(100),null);assert.equal(t.made[0].destroyed,true);
 // Ready and young: taken once, then the slot is empty.
 open(1000);t.made[1].emit('socket',t.socket());
 const entry=takePreparedJev(1500);assert.ok(entry);assert.equal(entry.req,t.made[1]);assert.equal(takePreparedJev(1500),null);assert.equal(t.made[1].destroyed,false);
 // Just before the limit it is taken; at the limit it is not, even if the expiry timer has not fired yet.
 open(10000);t.made[2].emit('socket',t.socket());assert.ok(takePreparedJev(17999));
 open(20000);t.made[3].emit('socket',t.socket());assert.equal(takePreparedJev(28000),null);assert.equal(t.made[3].destroyed,true);
 // Dead, unwritable or unverified sockets are never used.
 for(const [index,spoil] of [[4,(req,s)=>s.emit('close')],[5,(req,s)=>{s.writable=false}],[6,(req,s)=>{s.authorized=false}],[7,(req,s)=>{s.destroyed=true}],[8,req=>req.emit('error',new Error('reset'))],[9,req=>{req.headersSent=true}]]){
  open(30000+index*10000);const s=t.socket();t.made[index].emit('socket',s);spoil(t.made[index],s);
  assert.equal(takePreparedJev(30000+index*10000+10),null,`case ${index}`);assert.equal(t.made[index].destroyed,true,`case ${index}`);
 }
 clean();
});

test('a healthy young request is kept; an old or dead one is replaced, and late events of the old one cannot touch the new one',()=>{
 clean();const t=transport(),open=now=>prepareJev({config:config(),now,request:t.request,createAgent:t.createAgent});
 assert.equal(open(0),true);const first=t.socket();t.made[0].emit('socket',first);
 assert.equal(open(5000),false);assert.equal(t.made.length,1);
 assert.equal(open(9000),true);assert.equal(t.made.length,2);assert.equal(t.made[0].destroyed,true);
 t.made[1].emit('socket',t.socket());
 first.emit('close');t.made[0].emit('error',new Error('late'));          // the old request's callbacks arrive late
 const entry=takePreparedJev(9500);assert.ok(entry);assert.equal(entry.req,t.made[1]);assert.equal(t.made[1].destroyed,false);
 clean();
});

test('a response before anything was sent invalidates the request',()=>{
 clean();const t=transport();prepareJev({config:config(),now:0,request:t.request,createAgent:t.createAgent});
 t.made[0].emit('socket',t.socket());t.made[0].respond(400,'{}');
 assert.equal(takePreparedJev(10),null);assert.equal(t.made[0].destroyed,true);
});

test('an unused request is destroyed by its own expiry, and a taken one is not',async()=>{
 clean();const t=transport(),open=()=>prepareJev({config:config(),request:t.request,createAgent:t.createAgent,expireAfterMs:25});
 open();t.made[0].emit('socket',t.socket());await tick(60);
 assert.equal(t.made[0].destroyed,true);assert.equal(t.agents[0].destroyed,true);assert.equal(preparedJevState(),null);
 open();t.made[1].emit('socket',t.socket());const entry=takePreparedJev();assert.ok(entry);await tick(60);
 assert.equal(t.made[1].destroyed,false,'the expiry of a taken request was cancelled');entry.req.destroy();entry.agent.destroy();
});

test('shutdown destroys an unused request, and none is opened while shutdown drains',async()=>{
 clean();const t=transport(),open=()=>prepareJev({config:config(),request:t.request,createAgent:t.createAgent});
 open();t.made[0].emit('socket',t.socket());
 // Something owned is still closing, so the drain really has to wait.
 trackOwnedWork(tick(40),new AbortController());
 const draining=drainDetachedClassifiers({timeoutMs:500});
 assert.equal(t.made[0].destroyed,true);assert.equal(open(),false,'refused while draining');assert.equal(t.made.length,1);
 await draining;assert.equal(takePreparedJev(),null);
 assert.equal(open(),true,'allowed again afterwards');clean();
});

test('classifyJev sends on the prepared request: the key and the body are attached only then, and it reports prepared',async()=>{
 clean();const t=transport();prepareJev({config:config(),request:t.request,createAgent:t.createAgent});t.made[0].emit('socket',t.socket());
 const pending=classifyJev(state,{key:KEY,request:t.request,takePrepared:takePreparedJev});
 assert.equal(t.made.length,1,'no second request is created');
 const req=t.made[0];
 assert.equal(req.headers.Authorization,`Bearer ${KEY}`);assert.equal(req.headers['Content-Type'],'application/json');assert.equal(req.headers['Content-Length'],Buffer.byteLength(req.ended));
 assert.equal(JSON.parse(req.ended).state.transcript,'make a guide');
 req.respond();const result=await pending;
 assert.equal(result.prepared,true);assert.equal(result.route,'tier3');assert.equal(t.agents[0].destroyed,true,'the single-use agent is closed after settlement');
});

test('without a usable prepared request today\'s path runs unchanged and reports prepared:false',async()=>{
 clean();const t=transport();
 const pending=classifyJev(state,{key:KEY,request:t.request,takePrepared:takePreparedJev});
 assert.equal(t.made.length,1);assert.equal(t.made[0].options.headers.Authorization,`Bearer ${KEY}`);assert.ok(t.made[0].ended);
 t.made[0].respond();assert.equal((await pending).prepared,false);
 // An injected transport never sees the real prepared slot unless it asks for it.
 prepareJev({config:config(),request:t.request,createAgent:t.createAgent});t.made[1].emit('socket',t.socket());
 const other=classifyJev(state,{key:KEY,request:t.request});
 assert.equal(t.made.length,3);t.made[2].respond();assert.equal((await other).prepared,false);clean();
});

test('once sending on the prepared request was attempted there is never a second POST',async()=>{
 clean();const t=transport();prepareJev({config:config(),request:t.request,createAgent:t.createAgent});t.made[0].emit('socket',t.socket());
 t.made[0].failEnd=true;
 await assert.rejects(classifyJev(state,{key:KEY,request:t.request,takePrepared:takePreparedJev}),error=>error.message==='Jev transport error'&&error.prepared===true);
 assert.equal(t.made.length,1);assert.equal(t.made[0].destroyed,true);assert.equal(t.agents[0].destroyed,true);
 // A transport error after sending: the same.
 prepareJev({config:config(),request:t.request,createAgent:t.createAgent});t.made[1].emit('socket',t.socket());
 const pending=classifyJev(state,{key:KEY,request:t.request,takePrepared:takePreparedJev});
 t.made[1].emit('error',new Error('ECONNRESET'));
 await assert.rejects(pending,error=>error.prepared===true);assert.equal(t.made.length,2);
});

test('deadline and cancellation behave the same on the prepared path and carry prepared in the failure',async()=>{
 clean();const t=transport();
 prepareJev({config:config(),request:t.request,createAgent:t.createAgent});t.made[0].emit('socket',t.socket());
 await assert.rejects(classifyJev(state,{key:KEY,deadlineMs:20,request:t.request,takePrepared:takePreparedJev}),error=>error.message==='Jev deadline'&&error.prepared===true);
 assert.equal(t.made[0].destroyed,true);
 prepareJev({config:config(),request:t.request,createAgent:t.createAgent});t.made[1].emit('socket',t.socket());
 const controller=new AbortController(),pending=classifyJev(state,{key:KEY,signal:controller.signal,request:t.request,takePrepared:takePreparedJev});
 controller.abort();await assert.rejects(pending,error=>error.message==='Jev cancelled'&&error.prepared===true);
 // Cancelled before routing: the key is never attached and the prepared request is left for the next utterance or its expiry.
 prepareJev({config:config(),request:t.request,createAgent:t.createAgent});t.made[2].emit('socket',t.socket());
 const gone=new AbortController();gone.abort();
 await assert.rejects(classifyJev(state,{key:KEY,signal:gone.signal,request:t.request,takePrepared:takePreparedJev}),/Jev cancelled/);
 assert.deepEqual(t.made[2].headers,{});clean();
});

test('the hedge result (which the receipt stores as decision.jev) and the shadow record carry prepared, on success and on failure',async()=>{
 const run=()=>new Promise(resolve=>setTimeout(()=>resolve({text:'{"tier":2,"reply":"ok"}'}),15));
 const logs=[],base={root:'unused',id:'request-1',provider:'codex',state:()=>state,validate:()=>true,config:config({mode:{codex:'shadow',claude:'shadow'}}),log:(_r,_i,_b,entry)=>logs.push(entry),run};
 const ok=await hedgeClassifier({...base,classify:async()=>({route:'tier3',tier:3,skill:null,p:0.97,kind:null,revision:JEV_REVISION,pinned:true,ms:5,socketReused:false,prepared:true})});
 assert.equal(ok.jev.prepared,true);
 const failed=await hedgeClassifier({...base,classify:async()=>{throw Object.assign(new Error('Jev deadline'),{ms:600,socketReused:false,prepared:true})}});
 assert.equal(failed.jev.prepared,true);assert.equal(failed.jev.deadlineMissed,true);
 const old=await hedgeClassifier({...base,classify:async()=>({route:'tier3',tier:3,skill:null,p:0.97,kind:null,revision:JEV_REVISION,pinned:true,ms:5,socketReused:true})});
 assert.equal(old.jev.prepared,false);
 await tick(5);assert.ok(logs.some(entry=>entry.jev?.prepared===true));
});

// Real transport, real TLS, an independent receiver on another thread (this thread is blocked on purpose).
const cert=fs.readFileSync(path.join(here,'fixtures/jev-loopback-cert.pem')),key=fs.readFileSync(path.join(here,'fixtures/jev-loopback-key.pem'));
function receiver(){
 const worker=new Worker(`
  const {parentPort,workerData}=require('node:worker_threads'),https=require('node:https');
  let bytes=0;
  const server=https.createServer({cert:workerData.cert,key:workerData.key},(req,res)=>{const receivedAt=Date.now();let body='';req.on('data',c=>body+=c);req.on('end',()=>{parentPort.postMessage({type:'request',receivedAt,authorization:req.headers.authorization||null,bodyBytes:Buffer.byteLength(body)});res.writeHead(200,{'Content-Type':'application/json'});res.end(workerData.answer)})});
  server.on('secureConnection',socket=>{parentPort.postMessage({type:'tls'});socket.on('data',chunk=>{bytes+=chunk.length})});
  parentPort.on('message',message=>{if(message==='bytes')parentPort.postMessage({type:'bytes',bytes});if(message==='close'){server.close();process.exit(0)}});
  server.listen(0,'127.0.0.1',()=>parentPort.postMessage({type:'listening',port:server.address().port}));
 `,{eval:true,workerData:{cert:cert.toString(),key:key.toString(),answer}});
 const seen=[],waiters=[];
 worker.on('message',message=>{seen.push(message);for(const waiter of [...waiters])if(waiter.test(message)){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(message)}});
 let failed=null;worker.on('error',error=>{failed=error;for(const waiter of waiters.splice(0))waiter.reject(error)});worker.on('exit',code=>{if(code){failed=new Error('receiver exited '+code);for(const waiter of waiters.splice(0))waiter.reject(failed)}});
 const next=(testFn,ms=5000)=>{if(failed)return Promise.reject(failed);const hit=seen.find(testFn);if(hit)return Promise.resolve(hit);
  return new Promise((resolve,reject)=>{const waiter={test:testFn,resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}};const timer=setTimeout(()=>{waiters.splice(waiters.indexOf(waiter),1);reject(new Error('the receiver did not report in time'))},ms);waiters.push(waiter)})};
 return {worker,seen,next,ask:async what=>{worker.postMessage(what);return next(message=>message.type===what&&!message.used&&(message.used=true))}};
}
const block=ms=>{const end=Date.now()+ms;while(Date.now()<end);return end};

test('real TLS: nothing is sent before routing; the request reaches the receiver while the launch still blocks; today\'s path only after',async()=>{
 clean();const r=receiver();
 try{
  const {port}=await r.next(message=>message.type==='listening');
  const toLoopback=trusted=>(options,onResponse)=>https.request({...options,hostname:'localhost',port,...(trusted?{ca:cert}:{})},onResponse);
  // Prepared path.
  assert.equal(prepareJev({config:config(),request:toLoopback(true)}),true);
  await r.next(message=>message.type==='tls');
  for(let i=0;i<150&&!preparedJevState()?.ready;i++)await tick(20);assert.equal(preparedJevState()?.ready,true,'TLS came up');
  assert.equal((await r.ask('bytes')).bytes,0,'no HTTP byte before the request is taken');
  const sentAt=Date.now(),pending=classifyJev(state,{key:KEY,deadlineMs:3000,request:toLoopback(true),takePrepared:takePreparedJev});
  const blockedUntil=block(400);                                    // the model launch freezes this thread right after the send
  const result=await pending,got=await r.next(message=>message.type==='request');
  assert.equal(result.prepared,true);assert.equal(got.authorization,`Bearer ${KEY}`);assert.ok(got.bodyBytes>100);
  assert.ok(got.receivedAt<blockedUntil-100,`received ${got.receivedAt-sentAt} ms after the send, the block ended at ${blockedUntil-sentAt} ms`);
  // Today's path under the same block: the request cannot leave until the block is over.
  r.seen.length=0;
  const laterSent=Date.now(),later=classifyJev(state,{key:KEY,deadlineMs:3000,request:toLoopback(true),agent:new https.Agent({keepAlive:false}),takePrepared:null});
  const laterBlockedUntil=block(400);await later;
  const late=await r.next(message=>message.type==='request');
  assert.ok(late.receivedAt>=laterBlockedUntil-5,`today's path was received ${late.receivedAt-laterSent} ms after the send`);
  // A certificate that does not verify: the prepared request dies and is never used.
  assert.equal(prepareJev({config:config(),request:toLoopback(false)}),true);
  for(let i=0;i<150&&preparedJevState()&&!preparedJevState().dead;i++)await tick(20);
  assert.equal(preparedJevState()?.ready??false,false,'an unverified certificate never becomes ready');assert.equal(takePreparedJev(),null);
 }finally{clean();r.worker.postMessage('close');await tick(20);await r.worker.terminate()}
});
