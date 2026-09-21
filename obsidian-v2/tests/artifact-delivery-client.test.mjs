import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const built=await build({entryPoints:['shared/artifact-delivery.ts','shared/voice-surface.ts','shared/voice-session.ts','src/lib/voice-actions.ts'],bundle:true,platform:'node',format:'esm',outdir:'unused',write:false});
const modules=await Promise.all(built.outputFiles.map(file=>import('data:text/javascript;base64,'+Buffer.from(file.text).toString('base64'))));
const {ArtifactDelivery}=modules.find(m=>m.ArtifactDelivery),{VoiceSurface}=modules.find(m=>m.VoiceSurface),{VoiceSession}=modules.find(m=>m.VoiceSession),{openVoiceArtifact}=modules.find(m=>m.openVoiceArtifact);
const artifact={id:'artifact-id',taskId:'task-id',turnId:'turn-id',path:'system/v2/artifacts/example.png',label:'Cipher explainer',mime:'image/png',bytes:1200};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {resolve,reject,promise}};
const flush=async()=>{for(let n=0;n<4;n++)await new Promise(resolve=>setImmediate(resolve))};
function replace(t,key,value){const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});t.after(()=>old?Object.defineProperty(globalThis,key,old):delete globalThis[key])}

test('artifact delivery confirms only after the awaited renderer succeeds',async()=>{
 const rendered=deferred(),calls=[];let opens=0;
 const delivery=new ArtifactDelivery(async(path,body)=>{calls.push({path,body});return path==='/artifacts/claim'?{action:{id:'open-one',artifact}}:{}},'native-client',()=>true,async(value,signal)=>{assert.deepEqual(value,artifact);assert.equal(signal.aborted,false);opens++;await rendered.promise},()=>assert.fail('no error'));
 const pending=delivery.tick({visible:true,mode:'idle'});await flush();assert.equal(opens,1);assert.deepEqual(calls.map(c=>c.path),['/artifacts/claim']);
 rendered.resolve();await pending;assert.deepEqual(calls[0].body,{client:'native-client',visible:true,mode:'idle'});assert.deepEqual(calls[1].body,{client:'native-client',id:'open-one',ok:true});delivery.destroy();
});

test('a lost artifact ACK retries only the receipt, and repeated claims never reopen the file',async()=>{
 const calls=[];let opens=0,acks=0;
 const delivery=new ArtifactDelivery(async(path,body)=>{calls.push({path,body});if(path==='/artifacts/ack'&&++acks===1)throw new Error('Response lost');return path==='/artifacts/claim'?{action:{id:'open-once',artifact}}:{}},'client',()=>true,async()=>{opens++},()=>{});
 await assert.rejects(delivery.tick(),/Response lost/);assert.equal(opens,1);await delivery.tick();assert.equal(opens,1);
 assert.deepEqual(calls.map(c=>c.path),['/artifacts/claim','/artifacts/ack','/artifacts/ack','/artifacts/claim','/artifacts/ack']);assert.ok(calls.filter(c=>c.path==='/artifacts/ack').every(c=>c.body.ok));delivery.destroy();
});

test('a failed open is explicitly acknowledged and cannot become a successful receipt',async()=>{
 const calls=[],messages=[];
 const delivery=new ArtifactDelivery(async(path,body)=>{calls.push({path,body});return path==='/artifacts/claim'?{action:{id:'failed',artifact}}:{}},'client',()=>true,async()=>{throw new Error('The saved file is missing.')},text=>messages.push(text));
 await delivery.tick();assert.deepEqual(messages,['The saved file is missing.']);assert.deepEqual(calls.at(-1).body,{client:'client',id:'failed',ok:false,error:'The saved file is missing.'});delivery.destroy();
});

test('hidden or active surfaces never claim a file; cancellation aborts a pending renderer',async()=>{
 let eligible=false,claims=0,signal;const calls=[],started=deferred();
 const delivery=new ArtifactDelivery(async(path,body)=>{calls.push({path,body});if(path==='/artifacts/claim'){claims++;return {action:{id:'cancelled',artifact}}}return {}},'client',()=>eligible,async(_value,s)=>{signal=s;started.resolve();await new Promise((_resolve,reject)=>s.addEventListener('abort',()=>reject(new Error('Opening was cancelled.')),{once:true}))},()=>assert.fail('cancellation is quiet'));
 await delivery.tick();assert.equal(claims,0);eligible=true;const pending=delivery.tick();await started.promise;delivery.cancel();await pending;assert.equal(signal.aborted,true);assert.equal(calls.at(-1).body.ok,false);delivery.destroy();await delivery.tick();assert.equal(claims,1);
});

test('cancelling an in-flight claim prevents its late response from opening a file',async()=>{
 const claim=deferred(),calls=[];let opens=0;
 const delivery=new ArtifactDelivery(async(path,body)=>{calls.push({path,body});return path==='/artifacts/claim'?claim.promise:{}},'client',()=>true,async()=>{opens++},()=>assert.fail('cancellation is quiet'));
 const pending=delivery.tick();await flush();delivery.cancel();claim.resolve({action:{id:'late',artifact}});await pending;assert.equal(opens,0);assert.equal(calls.at(-1).body.ok,false);delivery.destroy();
});

test('artifact opening and its ACK precede completion speech, even when audio is locked',async t=>{
 replace(t,'window',undefined);replace(t,'document',{hidden:false});const order=[];
 const surface=new VoiceSurface(async(path,options)=>{const body=JSON.parse(options.body);order.push(path);if(path==='/artifacts/claim')return {status:200,json:{action:{id:'open',artifact}}};if(path==='/voice/surface'){assert.equal(body.canPlay,false);return {status:200,json:null}}return {status:200,json:null}},'web',()=> 'idle',async()=>assert.fail('audio remains locked'),()=>{},{},()=>false,()=>null,async()=>{order.push('rendered')});
 await surface.tick();assert.deepEqual(order,['/artifacts/claim','rendered','/artifacts/ack','/voice/surface']);surface.destroy();
});

test('a hidden surface aborts its pending render instead of stealing focus later',async t=>{
 replace(t,'window',undefined);const document={hidden:false};replace(t,'document',document);const started=deferred(),calls=[];let signal,claims=0;
 const surface=new VoiceSurface(async(path,options)=>{const body=JSON.parse(options.body);calls.push({path,body});if(path==='/artifacts/claim'&&claims++===0)return {status:200,json:{action:{id:'hidden',artifact}}};return {status:200,json:null}},'native',()=> 'idle',async()=>true,()=>{},{},()=>true,()=>null,async(_artifact,s)=>{signal=s;started.resolve();await new Promise((_resolve,reject)=>s.addEventListener('abort',()=>reject(new Error('Opening was cancelled.')),{once:true}))});
 const pending=surface.tick();await started.promise;document.hidden=true;await surface.tick();await pending;assert.equal(signal.aborted,true);assert.equal(calls.find(c=>c.path==='/artifacts/ack').body.ok,false);surface.destroy();
});

test('voice dispatch identifies its owning surface, and a missing opener fails clearly',async t=>{
 const window=new EventTarget();replace(t,'window',window);replace(t,'document',{hidden:false});replace(t,'EventSource',class{readyState=1;close(){}});replace(t,'AudioContext',undefined);
 const calls=[],messages=[];let pending=false;
 const session=new VoiceSession(async(path,options)=>{const body=JSON.parse(options.body);calls.push({path,options,body});if(path==='/artifacts/claim'&&pending){pending=false;return {status:200,json:{action:{id:'unsupported',artifact}}}}return {status:200,json:path==='/voice/text'?{reply:''}:null}},async()=>({provider:'codex',model:'gpt-6-astra'}),'native',{heartbeat:()=>()=>{}});
 session.onMessage=(text,error)=>messages.push({text,error});session.connect();await flush();await session.sendText('Create an image');await flush();
 const dispatch=calls.find(c=>c.path==='/voice/text'),surface=calls.find(c=>c.path==='/voice/surface');assert.equal(dispatch.options.headers['X-V2-Surface'],surface.body.id);
 pending=true;window.dispatchEvent(new Event('focus'));await flush();assert.ok(messages.some(m=>m.error&&/cannot display/.test(m.text)));assert.equal(calls.find(c=>c.path==='/artifacts/ack').body.ok,false);await session.destroy();
});

function nativeFixture(file=artifact.path){const calls=[],leaf={view:{getViewType:()=> 'image'},openFile:async value=>calls.push(['open',value.path])};const app={vault:{getAbstractFileByPath:path=>path===file?{path,name:path.split('/').at(-1),extension:path.split('.').at(-1)}:null},workspace:{iterateAllLeaves:()=>{},getLeaf:where=>{calls.push(['leaf',where]);return leaf},revealLeaf:async value=>{assert.equal(value,leaf);calls.push(['reveal'])}}};return {app,leaf,calls}}

test('native artifact delivery opens a real file tab and awaits reveal, with a bounded indexing retry',async t=>{
 const f=nativeFixture();let reads=0;const find=f.app.vault.getAbstractFileByPath;f.app.vault.getAbstractFileByPath=path=>++reads<3?null:find(path);
 t.mock.method(globalThis,'setTimeout',fn=>setImmediate(fn));t.mock.method(globalThis,'clearTimeout',id=>clearImmediate(id));
 await openVoiceArtifact(f.app,artifact);assert.equal(reads,3);assert.deepEqual(f.calls,[['leaf','tab'],['open',artifact.path],['reveal']]);
});

test('native artifact delivery reuses an exact open file pane and waits for reveal without reopening',async()=>{
 const f=nativeFixture(),revealed=deferred();f.leaf.view.file={path:artifact.path};f.app.workspace.iterateAllLeaves=visit=>visit(f.leaf);
 f.app.workspace.getLeaf=()=>assert.fail('an open file must not create another tab');f.leaf.openFile=()=>assert.fail('an open file must not reload');
 f.app.workspace.revealLeaf=async leaf=>{assert.equal(leaf,f.leaf);f.calls.push(['reveal']);await revealed.promise};
 let settled=false;const pending=openVoiceArtifact(f.app,artifact).then(()=>{settled=true});await flush();assert.equal(settled,false);assert.deepEqual(f.calls,[['reveal']]);revealed.resolve();await pending;assert.equal(settled,true);
});

test('native reuse never mistakes the same basename in another folder for the requested artifact',async()=>{
 const f=nativeFixture(),other={view:{file:{path:'other-folder/example.png'},getViewType:()=> 'image'}};f.app.workspace.iterateAllLeaves=visit=>visit(other);
 await openVoiceArtifact(f.app,artifact);assert.deepEqual(f.calls,[['leaf','tab'],['open',artifact.path],['reveal']]);
});

test('native reuse rejects cancellation, a changed pane, or failed reveal without spawning a replacement',async()=>{
 for(const scenario of ['cancelled','changed','failed']){
  const f=nativeFixture(),revealed=deferred(),controller=new AbortController();f.leaf.view.file={path:artifact.path};f.app.workspace.iterateAllLeaves=visit=>visit(f.leaf);
  f.app.workspace.getLeaf=()=>assert.fail('no replacement pane');f.leaf.openFile=()=>assert.fail('no reload');f.app.workspace.revealLeaf=()=>revealed.promise;
  const pending=openVoiceArtifact(f.app,artifact,controller.signal);await flush();
  if(scenario==='cancelled')controller.abort();else if(scenario==='changed')f.leaf.view.file={path:'other.png'};
  if(scenario==='failed')revealed.reject(new Error('Reveal failed'));else revealed.resolve();
  await assert.rejects(pending,scenario==='cancelled'?/cancelled/:scenario==='changed'?/pane changed/:/Reveal failed/);
 }
});

test('native artifact delivery rejects traversal, executable formats, mismatched MIME, and missing files',async t=>{
 const f=nativeFixture();
 for(const path of ['../outside.png','C:/private.png','/private.png','system/../outside.png','system\\outside.png','./example.png'])await assert.rejects(openVoiceArtifact(f.app,{...artifact,path}),/invalid path/);
 for(const path of ['system/image.svg','system/page.html','system/file.exe'])await assert.rejects(openVoiceArtifact(f.app,{...artifact,path}),/file type/);
 await assert.rejects(openVoiceArtifact(f.app,{...artifact,mime:'image/jpeg'}),/file type/);assert.equal(f.calls.length,0);
 t.mock.method(globalThis,'setTimeout',fn=>setImmediate(fn));t.mock.method(globalThis,'clearTimeout',id=>clearImmediate(id));await assert.rejects(openVoiceArtifact(f.app,{...artifact,path:'system/missing.png'}),/not found/);assert.equal(f.calls.length,0);
});

test('native open failure, empty viewer, or cancellation never report success',async()=>{
 const failed=nativeFixture();failed.leaf.openFile=async()=>{throw new Error('Viewer failed')};await assert.rejects(openVoiceArtifact(failed.app,artifact),/Viewer failed/);assert.ok(!failed.calls.some(c=>c[0]==='reveal'));
 const empty=nativeFixture();empty.leaf.view.getViewType=()=> 'empty';await assert.rejects(openVoiceArtifact(empty.app,artifact),/could not display/);
 const cancelled=nativeFixture(),controller=new AbortController();controller.abort();await assert.rejects(openVoiceArtifact(cancelled.app,artifact,controller.signal),/cancelled/);assert.equal(cancelled.calls.length,0);
});
