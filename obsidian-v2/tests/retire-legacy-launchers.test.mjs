import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const compiled=await build({entryPoints:['src/lib/retire-legacy-launchers.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {retireEmptyLaunchers}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const legacy='aos-v2-work',vault='C:\\Fixture Vault';
const draft='aos-v2-draft:obsidian:c%3A%2Ffixture%20vault:new';
function storage(t,values=new Map()){
 const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 const reads=[];
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem(key){reads.push(key);return values.get(key)??null},setItem(){throw new Error('Migration must not write storage')},removeItem(){throw new Error('Migration must not remove storage')}}});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete globalThis.localStorage});
 return reads;
}
function leaf({type=legacy,taskId=null,savedId=null,input=''}={}){
 return {view:{taskId,contentEl:{querySelectorAll:()=>[{value:input}]}},detached:0,getViewState:()=>({type,state:{taskId:savedId}}),detach(){this.detached++}};
}
function fixture(leaves){return {vault:{adapter:{getBasePath:()=>vault}},workspace:{getLeavesOfType:()=>leaves}}}

test('retires only an empty restored launcher and leaves native terminals and both kinds of task identity intact',t=>{
 const reads=storage(t),empty=leaf(),native=leaf({type:'terminal:terminal'}),live=leaf({taskId:'codex-task'}),restoring=leaf({savedId:'claude-task'}),app=fixture([empty,native,live,restoring]);
 retireEmptyLaunchers(app,legacy);
 assert.equal(empty.detached,1);assert.deepEqual([native.detached,live.detached,restoring.detached],[0,0,0]);
 assert.deepEqual(reads,[draft,draft+':selection']);
});
test('keeps a launcher with a saved draft, including whitespace, without mutating it',async t=>{
 for(const text of ['Finish my graphic','   '])await t.test(JSON.stringify(text),t=>{
  const values=new Map([[draft,text]]);storage(t,values);const view=leaf();retireEmptyLaunchers(fixture([view]),legacy);
  assert.equal(view.detached,0);assert.equal(values.get(draft),text);
 });
});
test('keeps recovery metadata even when its draft is absent or its metadata is malformed',async t=>{
 for(const selection of ['{"skill":"morning-intel"}',''])await t.test(JSON.stringify(selection),t=>{
  storage(t,new Map([[draft+':selection',selection]]));const view=leaf();retireEmptyLaunchers(fixture([view]),legacy);assert.equal(view.detached,0);
 });
});
test('keeps visible unsaved input after a failed draft save but still retires another empty launcher',t=>{
 storage(t);const unsaved=leaf({input:'Keep this unfinished request'}),empty=leaf();retireEmptyLaunchers(fixture([unsaved,empty]),legacy);
 assert.equal(unsaved.detached,0);assert.equal(empty.detached,1);
});
test('storage access failure preserves every launcher',t=>{
 storage(t);globalThis.localStorage.getItem=()=>{throw new Error('Storage inaccessible')};const view=leaf();
 assert.doesNotThrow(()=>retireEmptyLaunchers(fixture([view]),legacy));assert.equal(view.detached,0);
});
test('missing or failing local vault access preserves every launcher',async t=>{
 storage(t);
 for(const getBasePath of [undefined,()=>'',()=>{throw new Error('Vault unavailable')}])await t.test(String(getBasePath),()=>{
  const view=leaf(),app=fixture([view]);app.vault.adapter.getBasePath=getBasePath;
  assert.doesNotThrow(()=>retireEmptyLaunchers(app,legacy));assert.equal(view.detached,0);
 });
});
test('a view inspection failure preserves that leaf and does not prevent safely retiring another',t=>{
 storage(t);const badState=leaf(),badInput=leaf(),empty=leaf();badState.getViewState=()=>{throw new Error('Unloading')};badInput.view.contentEl.querySelectorAll=()=>{throw new Error('Detached DOM')};
 retireEmptyLaunchers(fixture([badState,badInput,empty]),legacy);
 assert.deepEqual([badState.detached,badInput.detached,empty.detached],[0,0,1]);
});
