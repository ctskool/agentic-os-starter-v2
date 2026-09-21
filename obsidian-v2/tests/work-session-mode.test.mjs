import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {build} from 'esbuild';

const built=await build({entryPoints:['src/lib/work.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'isolated-voice-transport',setup(builder){
 builder.onResolve({filter:/^\.\/v2-voice$/},()=>({path:'voice',namespace:'fixture'}));
 builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const v2VoiceTransport=(...args)=>globalThis.__workSessionTransport(...args);',loader:'js'}));
}}]});
let generation=0;
async function load(t){
 const calls=[],current={codex:'saved-codex',claude:'saved-claude'},tasks=[{id:current.codex,provider:'codex',model:'gpt-6-astra'},{id:current.claude,provider:'claude',model:'sonnet'}];
 const previousWindow=globalThis.window,previousTransport=globalThis.__workSessionTransport;globalThis.window=new EventTarget();
 globalThis.__workSessionTransport=async(path,options={})=>{calls.push({path,...options});return {status:200,json:path==='/work?summary=1'?{tasks,current,currentRevision:5}:{...current,revision:5}}};
 t.after(()=>{if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;if(previousTransport===undefined)delete globalThis.__workSessionTransport;else globalThis.__workSessionTransport=previousTransport});
 const module=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text+`\n// instance ${++generation}`).toString('base64'));
 return {module,calls,current};
}

test('the component preview loads and follows existing web conversations without a session POST',async t=>{
 const {module,calls,current}=await load(t);module.configureWorkSession('preview');
 await module.workFeed.refresh();
 assert.deepEqual(module.workConversations.current(),current);
 assert.equal((await module.workConversations.getSelection({provider:'codex',model:'gpt-6-astra'})).targetId,current.codex);
 module.setWorkProvider('claude');assert.equal((await module.workConversations.getSelection({provider:'claude',model:'sonnet'})).targetId,current.claude);
 assert.equal(calls[0].path,'/work/current');assert.ok(calls.every(call=>!call.method||call.method==='GET'));
 assert.ok(calls.every(call=>call.path!=='/work/session'));
 const entry=fs.readFileSync(new URL('../preview/entry.tsx',import.meta.url),'utf8');
 assert.ok(entry.indexOf("configureWorkSession('preview')")<entry.indexOf('render(<Cockpit'),'Preview mode must be configured before components mount');
});

test('the native runtime retains its fresh-session handshake and cannot change policy after loading',async t=>{
 const {module,calls}=await load(t);await module.workConversations.startSession();await module.workConversations.startSession();
 assert.equal(calls.length,1);assert.equal(calls[0].path,'/work/session');assert.equal(calls[0].method,'POST');
 const body=JSON.parse(calls[0].body);assert.match(body.sessionId,/^[a-f0-9-]{36}$/);assert.equal(body.mode,undefined);
 assert.throws(()=>module.configureWorkSession('preview'),/before loading/);
});
