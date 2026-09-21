import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const built=await build({entryPoints:['src/lib/queue.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'isolated-obsidian-client',setup(builder){
 builder.onResolve({filter:/^(obsidian|\.\/provider|\.\/work|\.\/v2-voice)$/},args=>({path:args.path,namespace:'fixture'}));
 builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:{
  obsidian:'export class Notice{constructor(message){globalThis.skillQueueFixture.notices.push(message)}}',
  './provider':'export async function assertTestVault(){};export async function readSelection(){return globalThis.skillQueueFixture.selection}',
  './work':'export async function workRequest(path,body){return globalThis.skillQueueFixture.request(path,body)};export function openWork(){throw new Error("A skill opened a terminal")}',
  './v2-voice':'export async function assertVoiceVault(){}',
 }[args.path],loader:'js'}));
}}]});
const {writeIntent,registerSkillReports}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
function fixture(){
 const files=new Map(),events=new Map(),cleanups=[],opens=[],reveals=[],leaves=[],calls=[],notices=[];
 const app={
  vault:{
   adapter:{exists:async path=>files.has(path),read:async path=>files.get(path)},
   getFileByPath:path=>files.has(path)?{path}:null,
   on(name,handler){const handlers=events.get(name)||new Set();handlers.add(handler);events.set(name,handlers);return {name,handler}},
  },
  workspace:{
   getLeavesOfType:()=>leaves,revealLeaf:async leaf=>reveals.push(leaf),
   getLeaf:kind=>{assert.equal(kind,'tab');return {openFile:async file=>{opens.push(file.path);leaves.push({view:{file}})}}},
  },
 };
 const plugin={app,register:fn=>cleanups.push(fn),registerEvent:ref=>cleanups.push(()=>events.get(ref.name)?.delete(ref.handler))};
 const state={selection:{provider:'codex',model:'gpt-6-astra'},notices,async request(path,body){calls.push({path,body});return {...body,execution:body.skill==='metrics-pull'?'script':'headless'}}};
 globalThis.skillQueueFixture=state;
 const emit=path=>{for(const handler of events.get('modify')||[])handler({path})};
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 const complete=(id,skill='morning-intel',path='inbox/report.md')=>{files.set(path,'A completed report');files.set('system/v2/runs/'+id+'.json',JSON.stringify({id,skill,status:'ok',deliverable_path:path}));emit('system/v2/runs/'+id+'.json')};
 return {app,plugin,state,files,events,opens,reveals,leaves,calls,notices,complete,settle,dispose:()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup()}};
}
for(const provider of ['codex','claude'])test(`${provider} skill dispatch requests background execution and opens the referenced native report once`,async t=>{
 const f=fixture();t.after(f.dispose);f.state.selection=provider==='codex'?{provider,model:'gpt-6-astra'}:{provider,model:'sonnet'};registerSkillReports(f.plugin);
 const id=await writeIntent(f.app,'morning-intel');assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'/skill');assert.equal(f.calls[0].body.execution,'headless');assert.deepEqual(f.calls[0].body.selection,f.state.selection);assert.equal(f.opens.length,0);assert.match(f.notices[0],/background/);
 f.complete(id);f.complete(id);await f.settle();assert.deepEqual(f.opens,['inbox/report.md']);
 f.complete(id);await f.settle();assert.equal(f.opens.length,1);
});
test('multiple skill surfaces reuse an existing report tab and a plugin reload never enrolls history',async t=>{
 const f=fixture();t.after(f.dispose);registerSkillReports(f.plugin);
 const id=await writeIntent(f.app,'morning-intel');f.leaves.push({view:{file:{path:'inbox/report.md'}}});f.complete(id);await f.settle();assert.equal(f.opens.length,0);assert.equal(f.reveals.length,1);
 f.dispose();registerSkillReports(f.plugin);f.complete(id);await f.settle();assert.equal(f.reveals.length,1);assert.equal(f.opens.length,0);
});
test('plugin unload removes listeners and prevents a request accepted afterward from opening a report',async t=>{
 const f=fixture();t.after(f.dispose);registerSkillReports(f.plugin);let accept;f.state.request=async(path,body)=>new Promise(resolve=>accept=()=>resolve({...body,execution:'headless'}));
 const started=writeIntent(f.app,'morning-intel');await f.settle();f.dispose();accept();const id=await started;f.complete(id);await f.settle();assert.equal(f.opens.length,0);assert.equal([...f.events.values()].reduce((sum,set)=>sum+set.size,0),0);
});
test('a recovered workflow keeps its saved provider and scripts remain background jobs',async t=>{
 const f=fixture();t.after(f.dispose);registerSkillReports(f.plugin);const saved={provider:'claude',model:'sonnet'};
 await writeIntent(f.app,'morning-intel',{},saved);assert.deepEqual(f.calls[0].body.selection,saved);
 const id=await writeIntent(f.app,'metrics-pull');f.files.set('system/v2/runs/'+id+'.json',JSON.stringify({id,skill:'metrics-pull',status:'ok',deliverable_path:null}));for(const handler of f.events.get('modify'))handler({path:'system/v2/runs/'+id+'.json'});await f.settle();assert.equal(f.opens.length,0);assert.ok(f.notices.includes('Pull Metrics finished.'));
});
