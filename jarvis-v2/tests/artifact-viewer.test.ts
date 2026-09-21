import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ArtifactPresenter,artifactUrl,loadArtifact,readArtifactBytes,MAX_ARTIFACT_BYTES,type ArtifactView} from '../lib/artifact-viewer';
import {artifactResponse} from '../lib/artifact-proxy';
import {ArtifactText} from '../lib/artifact-text';
import type {VoiceArtifact} from '../../obsidian-v2/shared/artifact-delivery';

const artifact:VoiceArtifact={id:'artifact_abcdefghijklmnop',taskId:'task-one',turnId:'turn-one',path:'outputs/graphic.png',label:'News graphic',mime:'image/png',bytes:4};
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('display promise waits for the current viewer loaded event and ignores stale load callbacks',async()=>{
 let view:ArtifactView|null=null,done=false;const presenter=new ArtifactPresenter(value=>view=value),first=presenter.open(artifact);
 const firstRejected=assert.rejects(first,/replaced/);assert.ok(view);const prior=(view as ArtifactView|null)!.generation;
 const second=presenter.open({...artifact,id:'artifact_qrstuvwxyz123456'}).then(()=>{done=true});await firstRejected;
 presenter.loaded(prior);await flush();assert.equal(done,false);presenter.loaded((view as ArtifactView|null)!.generation);await second;assert.equal(done,true);presenter.destroy();
});

test('close, errors, cancellation and unmount reject a pending viewer without approving a file',async()=>{
 for(const action of ['close','fail','abort','unmount']){
  let view:ArtifactView|null=null;const presenter=new ArtifactPresenter(value=>view=value),controller=new AbortController();
  const promise=presenter.open(artifact,controller.signal),failure=assert.rejects(promise,/closed|unavailable|cancelled/);
  if(action==='close')presenter.close();else if(action==='fail')presenter.failed(view!.generation,'File unavailable');else if(action==='abort')controller.abort();else presenter.destroy();
  await failure;if(action==='abort'||action==='close')assert.equal(view,null);presenter.destroy();
 }
});

test('viewer timeout is bounded and an already loaded preview remains visible when a later voice turn cancels',async t=>{
 let timeout:(()=>void)|null=null,clears=0;
 t.mock.method(globalThis,'setTimeout',((fn:()=>void)=>{timeout=fn;return 1 as unknown as ReturnType<typeof setTimeout>}) as typeof setTimeout);
 t.mock.method(globalThis,'clearTimeout',(()=>{clears++}) as typeof clearTimeout);
 let view:ArtifactView|null=null;const presenter=new ArtifactPresenter(value=>view=value),pending=presenter.open(artifact),failure=assert.rejects(pending,/too long/);timeout!();await failure;assert.equal(view,null);
 const controller=new AbortController(),loaded=presenter.open(artifact,controller.signal);presenter.loaded(view!.generation);await loaded;controller.abort();assert.ok(view,'finished display is not tied to later voice cancellation');assert.ok(clears>=2);presenter.destroy();
});

test('invalid references and pre-aborted requests never expose a preview',async()=>{
 let shown=0;const presenter=new ArtifactPresenter(()=>shown++),controller=new AbortController();controller.abort();await assert.rejects(presenter.open(artifact,controller.signal),/cancelled/);
 for(const replacement of [{id:'../../secret'},{mime:'text/html'},{mime:'image/svg+xml'},{bytes:MAX_ARTIFACT_BYTES+1}])await assert.rejects(presenter.open({...artifact,...replacement}),/cannot be displayed/);
 assert.equal(shown,0);presenter.destroy();await assert.rejects(presenter.open(artifact),/cancelled/);
});

test('client fetch uses only opaque IDs and verifies returned MIME and byte count before display',async()=>{
 const calls:{url:string;options?:RequestInit}[]=[],controller=new AbortController();
 const fetcher:typeof fetch=async(url,options)=>{calls.push({url:String(url),options});return new Response(new Uint8Array([1,2,3,4]),{headers:{'Content-Type':'image/png'}})};
 const result=await loadArtifact({...artifact,path:'C:/private/never-in-request.png'},controller.signal,fetcher);assert.equal(result.blob.size,4);assert.equal(result.text,null);assert.equal(calls[0].url,artifactUrl(artifact.id));assert.equal(calls[0].options?.signal,controller.signal);assert.doesNotMatch(calls[0].url,/private|path=/);
 await assert.rejects(loadArtifact(artifact,controller.signal,async()=>new Response('<script>bad()</script>',{headers:{'Content-Type':'text/html'}})),/unsupported format/);
 await assert.rejects(loadArtifact(artifact,controller.signal,async()=>new Response('changed',{headers:{'Content-Type':'image/png'}})),/changed while/);
 await assert.rejects(loadArtifact(artifact,controller.signal,async()=>new Response('changed',{status:409})),/changed/);
});

test('text is decoded but rendered as inert content, including embedded HTML and executable links',async()=>{
 const text='# Saved answer\n<script>alert(1)</script>\n[bad](javascript:alert(1))\n<svg onload="bad()"/>',bytes=new TextEncoder().encode(text);
 const result=await loadArtifact({...artifact,mime:'text/markdown',bytes:bytes.byteLength},new AbortController().signal,async()=>new Response(bytes,{headers:{'Content-Type':'text/markdown; charset=utf-8'}}));
 assert.equal(result.text,text);
 for(const mime of ['text/markdown','text/plain']){const html=renderToStaticMarkup(createElement(ArtifactText,{text:result.text!,mime}));assert.doesNotMatch(html,/<script|<svg|href="javascript:/);assert.match(html,/&lt;script&gt;/)}
});

test('proxy rejects traversal, arbitrary URLs, missing and duplicate IDs before contacting the bridge',async()=>{
 let called=0;const fetcher:typeof fetch=async()=>{called++;throw new Error('Must not fetch')};
 for(const suffix of ['', '?id=../secret','?id=https://example.com','?path=C:/private.txt',`?id=${artifact.id}&id=${artifact.id}`])assert.equal((await artifactResponse(new Request('http://localhost/api/artifact'+suffix),fetcher)).status,400);
 assert.equal(called,0);
});

test('proxy forwards allowed file bytes with no-store and nosniff, never tokens or upstream headers',async()=>{
 let endpoint='',options:RequestInit|undefined;
 const response=await artifactResponse(new Request('http://localhost/api/artifact?id='+artifact.id),async(url,init)=>{endpoint=String(url);options=init;return new Response(new Uint8Array([1,2,3,4]),{headers:{'Content-Type':'image/png','X-V2-Token':'must-not-copy','Set-Cookie':'bad=1'}})});
 assert.equal(endpoint,'http://127.0.0.1:3219/artifacts/file?id='+artifact.id);assert.equal(options?.redirect,'error');assert.equal(options?.headers,undefined);
 assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('x-v2-token'),null);assert.equal(response.headers.get('set-cookie'),null);assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[1,2,3,4]);
});

test('proxy rejects active document MIME and preserves missing or changed-file failures',async()=>{
 for(const mime of ['text/html','image/svg+xml','application/javascript','application/octet-stream'])assert.equal((await artifactResponse(new Request('http://localhost/api/artifact?id='+artifact.id),async()=>new Response('unsafe',{headers:{'Content-Type':mime}}))).status,415);
 for(const status of [404,409]){const response=await artifactResponse(new Request('http://localhost/api/artifact?id='+artifact.id),async()=>new Response('private diagnostic',{status}));assert.equal(response.status,status);assert.doesNotMatch(await response.text(),/private diagnostic/)}
});

test('declared and chunked oversized files are refused, and abort releases a hanging reader',async()=>{
 let cancelled=0;const oversized=new Response(new ReadableStream({cancel(){cancelled++}}),{headers:{'Content-Length':String(MAX_ARTIFACT_BYTES+1)}});await assert.rejects(readArtifactBytes(oversized),/too large/);assert.equal(cancelled,1);
 const large=new Uint8Array(MAX_ARTIFACT_BYTES/2+1);let emitted=0;
 const chunked=new Response(new ReadableStream({pull(controller){if(emitted++<2)controller.enqueue(large);else controller.close()},cancel(){cancelled++}}));await assert.rejects(readArtifactBytes(chunked),/too large/);assert.equal(cancelled,2);
 const abort=new AbortController(),hanging=new Response(new ReadableStream({cancel(){cancelled++}})),pending=readArtifactBytes(hanging,abort.signal),failure=assert.rejects(pending,/cancelled/);abort.abort();await failure;assert.equal(cancelled,3);
});
