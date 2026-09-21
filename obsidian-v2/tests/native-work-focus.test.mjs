import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {build} from 'esbuild';
const stubs={
 obsidian:`export class ItemView{constructor(leaf){this.leaf=leaf;this.app=leaf.app;this.contentEl=leaf.contentEl}async setState(){}};export class WorkspaceLeaf{}`,
 preact:`export const h=(type,props)=>({type,props});export function render(value,element){element.rendered=value}`,
 'preact/jsx-runtime':`export const jsx=(type,props)=>({type,props}),jsxs=jsx;`,
 './components/WorkPane':`export function WorkPane(){}`,
 './lib/provider':`export async function readSelection(){return {provider:'codex',model:'gpt-6-astra'}}`,
 './lib/v2-voice':`export async function assertVoiceVault(){}`,
 './lib/work':`let snapshot={tasks:[]};const listeners=new Set();export const choices=[];export function chooseWork(id){choices.push(id)}export const workFeed={getSnapshot:()=>snapshot,subscribe(fn){listeners.add(fn);fn(snapshot);return()=>listeners.delete(fn)}};export function publish(tasks){snapshot={tasks};for(const fn of listeners)fn(snapshot)}export function reset(){snapshot={tasks:[]};listeners.clear();choices.length=0}export const subscriberCount=()=>listeners.size;`,
};
const result=await build({stdin:{contents:`export {WorkView} from './src/work-view';export {publish,reset,choices,subscriberCount} from './lib/work';`,loader:'ts',resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',jsx:'automatic',jsxImportSource:'preact',write:false,plugins:[{name:'work-view-focus-fixture',setup(builder){
 builder.onResolve({filter:/.*/},args=>{if(args.path==='./src/work-view')return {path:path.resolve('src/work-view.tsx')};if(args.path==='../shared/work-presentation')return {path:path.resolve('shared/work-presentation.ts')};if(args.path in stubs)return {path:args.path,namespace:'fixture'};throw new Error('Unexpected view dependency '+args.path)});
 builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path],loader:'js'}));
 }}]});
const {WorkView,publish,reset,choices,subscriberCount}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 reset();const dashboard={id:'dashboard'},workspace={activeLeaf:dashboard,reveals:0,async revealLeaf(leaf){this.activeLeaf=leaf;this.reveals++}};
 const leaf={app:{workspace},states:[],focuses:0,stored:{type:'aos-v2-work',active:true,state:{taskId:'history-task',title:'HN research · Ready'}},contentEl:{empty(){},addClass(){},setText(){}},getViewState(){return this.stored},async setViewState(state){this.states.push(state);this.stored=state;if(state.active){workspace.activeLeaf=this;this.focuses++}await view.setState(state.state,{})}};
 const opened=[],plugin={activateWork(ids){opened.push(ids)}},view=new WorkView(leaf,plugin);
 return {dashboard,workspace,leaf,view,opened};
}
test('background ready-to-closed title refresh cannot replay persisted active:true or retarget voice',async()=>{
 const f=fixture(),task={id:'history-task',title:'HN research',state:'ready',provider:'codex'};publish([task]);await f.view.setState(f.leaf.stored.state,{});await f.view.onOpen();
 assert.equal(subscriberCount(),1);publish([{...task,state:'stopped'}]);await flush();
 assert.equal(f.view.getDisplayText(),'HN research · Closed');assert.equal(f.leaf.states.at(-1).active,false);assert.equal(f.workspace.activeLeaf,f.dashboard);assert.equal(f.leaf.focuses,0);assert.equal(f.workspace.reveals,0);assert.deepEqual(choices,[]);assert.deepEqual(f.opened,[]);
 const before=f.leaf.states.length;publish([{...task,state:'stopped'}]);await flush();assert.equal(f.leaf.states.length,before,'unchanged task does not repeatedly restore view state');
 await f.view.onClose();assert.equal(subscriberCount(),0);publish([{...task,state:'error'}]);await flush();assert.equal(f.leaf.states.length,before);
});
test('history activation stays available through the explicit task action',async()=>{
 const f=fixture();await f.view.setState(f.leaf.stored.state,{});await f.view.onOpen();
 f.leaf.contentEl.rendered.props.onOpenTask('history-task');assert.deepEqual(choices,[]);assert.deepEqual(f.opened,[['history-task']]);
 f.leaf.contentEl.rendered.props.onOpenTask(null);assert.deepEqual(f.opened,[['history-task'],[null]],'New terminal passes an explicit null instead of reopening current');
 await f.view.onClose();
});
