import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createWorkFeed} from '../shared/work-feed.mjs';
const built=await build({entryPoints:['shared/work-conversations.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {createWorkConversations}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const tasks=[{id:'c1',provider:'codex',model:'astra'},{id:'c2',provider:'codex',model:'astra'},{id:'h1',provider:'claude',model:'sonnet'},{id:'h2',provider:'claude',model:'fable'},{id:'script',provider:'codex',model:'none',execution:'script'}];
tasks.push({id:'background',provider:'codex',model:'astra',execution:'headless'});
const selection=provider=>({provider,model:provider==='codex'?'astra':'sonnet'}),deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(initial={codex:null,claude:null},revision=0){
 let snapshot={tasks,current:{...initial},currentRevision:revision,vault:'test'},server={...initial,revision};const writes=[];
 const options={getSnapshot:()=>snapshot,readFresh:async()=>({tasks,current:{codex:server.codex,claude:server.claude},currentRevision:server.revision}),persist:async(provider,id)=>{writes.push({provider,id});server={...server,[provider]:id,revision:server.revision+1};return {...server}},publish:value=>{snapshot=value},onChange:()=>{}};
 return {options,writes,get snapshot(){return snapshot},set snapshot(value){snapshot=value},get server(){return server},set server(value){server=value},create(){return createWorkConversations(options)}};
}

test('first load never adopts history, and a recreated controller restores explicit persisted choices',async()=>{
 const f=fixture(),c=f.create();c.sync(f.snapshot);assert.equal(c.target(),null);assert.equal(f.writes.length,0);
 await c.choose('c1');const reload=f.create();reload.sync(f.snapshot);assert.equal(reload.target(),'c1');assert.equal(f.writes.length,1);
});
test('provider swaps restore separate targets and New request clears only its provider without dispatch',async()=>{
 const f=fixture({codex:'c1',claude:'h1'}),c=f.create();c.sync(f.snapshot);
 c.setProvider('claude');assert.equal(c.target(),'h1');c.setProvider('codex');assert.equal(c.target(),'c1');assert.equal(f.writes.length,0);
 c.setProvider('claude');await c.choose(null);assert.deepEqual(c.current(),{codex:'c1',claude:null});assert.deepEqual(f.writes,[{provider:'claude',id:null}]);
});
test('rapid selection writes serialize and older polls cannot override optimistic or acknowledged choices',async()=>{
 const f=fixture({codex:'c1',claude:'h1'},1),first=deferred(),second=deferred(),calls=[];
 f.options.persist=(provider,id)=>{calls.push({provider,id});return calls.length===1?first.promise:second.promise};
 const c=f.create();c.sync(f.snapshot);const a=c.choose('c2'),b=c.choose(null);await flush();assert.equal(calls.length,1);assert.equal(c.target(),null);
 c.sync({tasks,current:{codex:'c1',claude:'h1'},currentRevision:1});assert.equal(c.target(),null);
 first.resolve({codex:'c2',claude:'h1',revision:2});await a;await flush();assert.equal(calls.length,2);assert.equal(c.target(),null);
 second.resolve({codex:null,claude:'h1',revision:3});await b;
 c.sync({tasks,current:{codex:'c1',claude:'h1'},currentRevision:1});assert.equal(c.target(),null);assert.equal(f.snapshot.currentRevision,3);
});
test('an acknowledged response older than a newer remote revision cannot rewind that remote choice',async()=>{
 const f=fixture({codex:'c1',claude:null},1),write=deferred();f.options.persist=()=>write.promise;
 const c=f.create();c.sync(f.snapshot);const pending=c.choose('c2');
 c.sync({tasks,current:{codex:'c1',claude:'h2'},currentRevision:3});assert.equal(c.target(),'c2');
 write.resolve({codex:'c2',claude:null,revision:2});await pending;assert.deepEqual(c.current(),{codex:'c1',claude:'h2'});assert.equal(f.snapshot.currentRevision,3);
});
test('voice captures provider and target while its selection write is pending, despite later clicks and flips',async()=>{
 const f=fixture({codex:'c1',claude:'h1'},1),write=deferred(),read=deferred();let reads=0;
 f.options.persist=()=>write.promise;f.options.readFresh=()=>{reads++;return read.promise};
 const c=f.create();c.sync(f.snapshot);const save=c.choose('c2');const spoken=c.getSelection(selection('codex'));c.setProvider('claude');await flush();assert.equal(reads,0);
 write.resolve({codex:'c2',claude:'h1',revision:2});await save;await flush();assert.equal(reads,1);
 c.sync({tasks,current:{codex:'c1',claude:'h2'},currentRevision:3});read.resolve({tasks,current:{codex:'c1',claude:'h2'},currentRevision:3});
 assert.deepEqual(await spoken,{provider:'codex',model:'astra',terminalMode:true,targetId:'c2'});assert.equal(c.target(),'h2');
});
test('null targets remain on the captured provider through asynchronous reads',async()=>{
 const f=fixture({codex:null,claude:'h1'}),read=deferred();f.options.readFresh=()=>read.promise;
 const c=f.create();c.sync(f.snapshot);const spoken=c.getSelection(selection('codex'));c.setProvider('claude');
 read.resolve(f.snapshot);assert.deepEqual(await spoken,{provider:'codex',model:'astra',terminalMode:true,targetId:null});
});
test('missing, stopped, or busy targets do not prevent the router from hearing an explicit new-task command',async()=>{
 const f=fixture({codex:'missing',claude:null}),c=f.create();c.sync(f.snapshot);
 assert.equal((await c.getSelection(selection('codex'))).targetId,'missing');
 for(const state of ['stopped','working']){f.options.readFresh=async()=>({tasks:[{...tasks[0],state}],current:{codex:'c1',claude:null},currentRevision:1});c.sync(await f.options.readFresh());assert.equal((await c.getSelection(selection('codex'))).targetId,'c1')}
});
test('foreign-provider or direct-script remembered records reject instead of overriding the top provider',async()=>{
 for(const id of ['h1','script','background']){const f=fixture({codex:id,claude:null}),c=f.create();c.sync(f.snapshot);await assert.rejects(c.getSelection(selection('codex')),/does not belong/);assert.equal(c.target(),id)}
 const f=fixture(),c=f.create();await assert.rejects(c.choose('h1'),/selected provider/);await assert.rejects(c.choose('script'),/CLI conversation/);assert.equal(f.writes.length,0);
 await assert.rejects(c.choose('background'),/CLI conversation/);assert.equal(f.writes.length,0);
});
test('failed saves stay actionable and prevent accidental new-target dispatch until a successful explicit choice',async()=>{
 const f=fixture({codex:null,claude:'h1'}),c=f.create();c.sync(f.snapshot);f.options.persist=async()=>{throw new Error('Selection was not saved')};
 await assert.rejects(c.choose('c1'),/not saved/);assert.equal(c.target(),null);assert.match(c.error(),/not saved/);
 await assert.rejects(c.getSelection(selection('codex')),/not saved/);
 f.options.persist=async()=>({codex:'c2',claude:'h1',revision:1});f.server={codex:'c2',claude:'h1',revision:1};await c.choose('c2');assert.equal(c.error(),null);assert.equal((await c.getSelection(selection('codex'))).targetId,'c2');
});
test('initial voice hydration reads only the captured provider current map and never the most recent task',async()=>{
 const f=fixture();f.snapshot={tasks,vault:'test'};f.server={codex:'c2',claude:'h2',revision:4};const c=f.create();
 assert.equal((await c.getSelection(selection('claude'))).targetId,'h2');assert.equal(c.target('codex'),'c2');assert.equal(f.writes.length,0);
});

test('new runtime clears its inactive selection once, without resetting on views or provider changes',async()=>{
 const f=fixture({codex:'c1',claude:'h1'},5);let starts=0;
 f.options.startSession=async()=>{starts++;f.server={codex:null,claude:'h1',revision:6};return {...f.server}};
 const c=f.create();assert.equal(c.sync(f.snapshot),false);assert.equal(c.target(),null);
 await Promise.all([c.startSession(),c.startSession(),c.getSelection(selection('codex'))]);
 assert.equal(starts,1);assert.deepEqual(c.current(),{codex:null,claude:'h1'});
 await c.choose('c2');c.setProvider('claude');await c.startSession();c.setProvider('codex');await c.startSession();
 assert.equal(starts,1);assert.equal(c.target(),'c2');assert.equal((await c.getSelection(selection('claude'))).targetId,'h1');
 assert.equal(c.sync({tasks,current:{codex:'c1',claude:'h1'},currentRevision:5}),false);assert.equal(c.target(),'c2');
});
test('failed session initialization can retry and cannot hydrate the old snapshot',async()=>{
 const f=fixture({codex:'c1',claude:null},4);let starts=0,reads=0;
 const read=f.options.readFresh;f.options.readFresh=async()=>{reads++;return read()};
 f.options.startSession=async()=>{if(++starts===1)throw new Error('Bridge offline');f.server={codex:null,claude:null,revision:5};return {...f.server}};
 const c=f.create();await assert.rejects(c.getSelection(selection('codex')),/Bridge offline/);
 assert.equal(reads,0);assert.equal(c.sync(f.snapshot),false);assert.equal(c.target(),null);
 assert.equal((await c.getSelection(selection('codex'))).targetId,null);assert.equal(starts,2);assert.equal(reads,1);
});
test('explicit history selection waits for session reset and remains the captured voice destination',async()=>{
 const f=fixture({codex:'c1',claude:null},3),start=deferred();let starts=0;
 f.options.startSession=()=>{starts++;return start.promise};
 const c=f.create(),save=c.choose('c2'),spoken=c.getSelection(selection('codex'));
 await flush();assert.equal(starts,1);assert.equal(f.writes.length,0);assert.equal(c.target(),'c2');
 f.server={codex:null,claude:null,revision:4};start.resolve({...f.server});await save;
 assert.equal((await spoken).targetId,'c2');assert.deepEqual(f.writes,[{provider:'codex',id:'c2'}]);assert.equal(starts,1);
});
test('authoritative expiry clears a captured target instead of resuming its saved terminal',async()=>{
 for(const provider of ['codex','claude']){
  const original={codex:'c1',claude:'h1'},f=fixture(original,1),c=f.create();c.sync(f.snapshot);
  f.server={...original,[provider]:null,revision:2};
  assert.equal((await c.getSelection(selection(provider))).targetId,null);assert.equal(c.target(provider),null);
  assert.equal(f.writes.length,0);
 }
});
test('New conversation clicked after speech capture does not retarget that already captured request',async()=>{
 const f=fixture({codex:'c1',claude:null},1),read=deferred();f.options.readFresh=()=>read.promise;
 const c=f.create();c.sync(f.snapshot);const spoken=c.getSelection(selection('codex'));await flush();
 await c.choose(null);read.resolve({tasks,current:{codex:null,claude:null},currentRevision:2});
 assert.equal((await spoken).targetId,'c1');assert.equal(c.target(),null);
});
test('a different remote conversation cannot hijack a request already being captured',async()=>{
 const f=fixture({codex:'c1',claude:null},1),c=f.create();c.sync(f.snapshot);f.server={codex:'c2',claude:null,revision:2};
 assert.equal((await c.getSelection(selection('codex'))).targetId,'c1');assert.equal(c.target(),'c2');
});
test('a later history click cannot hijack the first voice request while the app initializes',async()=>{
 const f=fixture({codex:'c1',claude:null},3),start=deferred();f.options.startSession=()=>start.promise;
 const c=f.create(),spoken=c.getSelection(selection('codex')),save=c.choose('c2');await flush();
 f.server={codex:'c1',claude:null,revision:4};start.resolve({...f.server});await save;
 assert.equal((await spoken).targetId,'c1');assert.equal(c.target(),'c2');
});
test('session initialization does not invalidate the first shared task-feed read',async()=>{
 let c,reads=0;
 const feed=createWorkFeed(async()=>{await c.startSession();reads++;return {tasks,current:{codex:null,claude:'h1'},currentRevision:2}});
 c=createWorkConversations({getSnapshot:()=>feed.getSnapshot(),readFresh:()=>feed.refresh(),persist:async()=>{throw new Error('Unexpected write')},startSession:async()=>({codex:null,claude:'h1',revision:2}),publish:snapshot=>feed.publish(snapshot)});
 const result=await feed.refresh();assert.equal(reads,1);assert.ok(result.tasks.some(task=>task.id==='c1'));assert.equal(result.current.claude,'h1');assert.equal(c.target('claude'),'h1');
});
