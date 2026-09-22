import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {build} from 'esbuild';

// Exercise actual plugin activation and the native adapter. Only Obsidian and
// UI/IO dependencies are substituted; no CLI, filesystem mutation or services.
const stubs={
 obsidian:`export const notices=[];export class Notice{constructor(text){notices.push(text)}}
 export class WorkspaceLeaf{};export class Plugin{constructor(app){this.app=app;this.manifest={id:'test'};this.cleanup=[]}registerView(){}addCommand(){}addRibbonIcon(){}addSettingTab(){}register(fn){this.cleanup.push(fn)}registerEvent(){}async loadData(){return {orbEnabled:false}}}`,
 preact:'export const h=()=>null,render=()=>{};',
 'work-view':`export const WORK_VIEW='aos-v2-work';export class WorkView{constructor(taskId=null){this.taskId=taskId}}`,
 view:`export const COCKPIT_VIEW_TYPE='dashboard';export class CockpitView{}`,
 settings:'export const DEFAULT_SETTINGS={};export class ChaseSettingTab{};',
 'lib/work':`let provider='codex',current={codex:null,claude:null},stored={...current},tasks=[],refreshFailure=false;export const choices=[],apiCalls=[];export let refreshes=0;
 export function resetWork(){provider='codex';current={codex:null,claude:null};stored={...current};tasks=[];refreshFailure=false;choices.length=0;apiCalls.length=0;refreshes=0}
 export const workTarget=(p=provider)=>current[p];export function setWorkProvider(p){provider=p}
 export function chooseWork(id,p){p=p||tasks.find(task=>task.id===id)?.provider||provider;current[p]=id;stored[p]=id;choices.push({provider:p,id})}
 export function setPersistedCurrent(value){stored={...value}}export const persistedCurrent=()=>({...stored});export function setCachedCurrent(value){current={...value}}export function setFixtureTasks(value){tasks=value}export function setRefreshFailure(value){refreshFailure=value}
 export const workFeed={getSnapshot:()=>({tasks:structuredClone(tasks),current:{...current}})};
 export function isLiveTerminal(task){return task.execution!=='script'&&(task.pid?true:!['stopped','error'].includes(task.state))}
 export async function refreshWorkConversations(){refreshes++;if(refreshFailure)throw new Error('Fixture bridge offline');current={...stored};return {tasks:structuredClone(tasks),current:{...current},currentRevision:refreshes}}
 export function workRequest(path,data){apiCalls.push({path,data});if(data!==undefined||path!=='?summary=1')throw new Error('Activation must not mutate a work API');return Promise.resolve({vault:'C:\\\\fixture vault',attachmentProtocol:1,tasks:structuredClone(tasks)})}`,
 'lib/provider':"let provider='codex';export function setFixtureProvider(value){provider=value}export async function assertTestVault(){};export async function readSelection(){return {provider,model:provider==='codex'?'gpt-6-astra':'sonnet'}}",
 'lib/v2-voice':'export function configureVoiceTransport(){};export async function v2VoiceTransport(){return {status:200,json:{}}}',
 'lib/native-direct-host':`export class NativeDirectHost{constructor(options){this.options=options;this.opens=[];this.result=null}async sync(){}async open(id){this.opens.push(id);return this.result}dispose(){}async simulateLaunch(state,ready=Promise.resolve()){let leaf;await this.options.withLayout(async()=>{leaf=this.options.createLeaf();await leaf.setViewState(state)});await ready;await this.options.withLayout(async()=>this.options.reveal(leaf));return leaf}}`,
 'lib/native-voice-heartbeat':'export function nativeVoiceHeartbeat(){}',
 'lib/retire-legacy-launchers':'export function retireEmptyLaunchers(){}',
 'lib/queue':'export function registerSkillReports(){}',
 'components/OrbFloat':'export const OrbFloat=()=>null;',
 'components/WorkflowModal':'export function openWorkflowPicker(){}',
};
const result=await build({stdin:{contents:`export {default as TestedPlugin} from './src/main';export {NativeTerminalTabs,terminalConversation} from './lib/native-terminal';export {WorkView} from './src/work-view';export {workTarget,chooseWork,setWorkProvider,setPersistedCurrent,persistedCurrent,setCachedCurrent,setFixtureTasks,setRefreshFailure,choices,apiCalls,refreshes,resetWork} from './src/lib/work';export {setFixtureProvider} from './src/lib/provider';export {notices} from 'obsidian';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'native-tabs-fixture',setup(builder){
 builder.onResolve({filter:/.*/},args=>{if(args.path==='./src/main')return {path:path.resolve('src/main.ts')};if(args.path==='./lib/native-terminal')return {path:path.resolve('src/lib/native-terminal.ts')};if(args.path==='./terminal-lifetime')return {path:path.resolve('src/lib/terminal-lifetime.ts')};if(args.path==='../../shared/terminal-support.mjs')return {path:path.resolve('shared/terminal-support.mjs')};const key=args.path.replace(/^\.\/(?:src\/)?/,'');if(key in stubs)return {path:key,namespace:'fixture'};throw new Error('Unstubbed plugin dependency: '+args.path)});
 builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path],loader:'js'}));
 }}]});
const runtime=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const {TestedPlugin,WorkView,workTarget,chooseWork,setWorkProvider,setPersistedCurrent,persistedCurrent,setCachedCurrent,setFixtureTasks,setRefreshFailure,choices,apiCalls,resetWork,setFixtureProvider,notices}=runtime;
const codex='11111111-1111-4111-8111-111111111111',claude='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
const config={version:1,nodeExecutable:'C:\\Program Files\\nodejs\\node.exe',attachmentScript:'C:\\fixture\\runner\\terminal-attach.mjs',runtimeDir:'C:\\fixture\\.runtime',vault:'C:\\fixture vault'};
const fixturePlugins=[];
afterEach(()=>{for(const plugin of fixturePlugins.splice(0))for(const cleanup of plugin.cleanup)cleanup()});
function workspaceFixture(){
 resetWork();setFixtureProvider('codex');
 const tasks=[{id:codex,provider:'codex',state:'ready',pid:1,title:'First'},{id:claude,provider:'claude',state:'needs input',pid:2,title:'Second'},{id:other,provider:'codex',state:'working',pid:3,title:'Third'}];setFixtureTasks(tasks);
 const leaves=[],created=[],revealed=[],events=new Map(),commands=[],reads=[];let active,lifetimes=0;
 const dashboard={type:'dashboard',view:{dashboard:true},group:'dashboard-group',states:[],async setViewState(state){this.states.push(state)}};leaves.push(dashboard);active=dashboard;
 const workspace={
  getLeavesOfType:type=>leaves.filter(leaf=>leaf.type===type),
  setActiveLeaf(leaf){active=leaf;events.get('active-leaf-change')?.(leaf)},
  getLeaf(kind,direction){const group=kind==='split'?`split-${created.length}`:active.group;const leaf={type:'empty',group,view:{},states:[],getViewState(){return this.states.at(-1)||{type:this.type}},detach(){leaves.splice(leaves.indexOf(this),1)},async setViewState(state){await new Promise(resolve=>setImmediate(resolve));this.states.push(state);this.type=state.type;this.view=state.type==='aos-v2-work'?new WorkView(state.state.taskId):{terminal:true,register(){}}}};created.push({kind,direction,anchor:active,leaf});leaves.push(leaf);return leaf},
  async revealLeaf(leaf){revealed.push(leaf);this.setActiveLeaf(leaf)},
  on(name,callback){events.set(name,callback);return {name,callback}},onLayoutReady(callback){callback()},
 };
 const base={type:'integrated',executable:'powershell',args:[],platforms:{win32:true},pythonExecutable:'python',useWin32Conhost:true},settings={defaultProfile:'shell',profiles:{shell:base}};
 // Obsidian's command dispatcher returns a boolean; view lifecycle completion
 // belongs to the Terminal plugin. Complete its fixture state synchronously.
 const app={workspace,plugins:{plugins:{terminal:{manifest:{version:'3.27.1'},settings:{value:settings}}}},vault:{configDir:'.obsidian',adapter:{getBasePath:()=>config.vault,read:async file=>{reads.push(file);return JSON.stringify(config)}}},commands:{executeCommandById(id){commands.push(id);const leaf=workspace.getLeaf('tab');leaf.states.push({type:'terminal:terminal',state:{'terminal:terminal':{cwd:config.vault,profileSourceId:'shell',profile:structuredClone(base)}}});leaf.type='terminal:terminal';leaf.view={terminal:true,register(){}};void workspace.revealLeaf(leaf);return true}}};
 const plugin=new TestedPlugin(app);
 fixturePlugins.push(plugin);
 plugin.nativeTerminals=new runtime.NativeTerminalTabs(app,{pluginDir:'fixture',readSnapshot:async()=>({vault:config.vault,attachmentProtocol:1,tasks:structuredClone(tasks)}),notice:message=>notices.push(message),createLifetime:async()=>({endpoint:'fixture-socket-'+(++lifetimes),active:true,close(){this.active=false}})});
 return {plugin,workspace,dashboard,created,revealed,leaves,events,tasks,commands,reads,base};
}
const taskIds=f=>f.created.map(item=>runtime.terminalConversation(item.leaf)?.id);
async function shell(f){const leaf=f.workspace.getLeaf('tab');await leaf.setViewState({type:'terminal:terminal',state:{'terminal:terminal':{cwd:config.vault,profileSourceId:'shell',profile:structuredClone(f.base)}}});leaf.group='user-terminal-group';leaf.unsentText='Keep my unfinished command';return leaf}
function withWindow(t){const previous=globalThis.window;globalThis.window=new EventTarget();t.after(()=>{if(previous===undefined)delete globalThis.window;else globalThis.window=previous})}

test('Terminals with no current task reveals the existing bottom PowerShell without creating a custom launcher',async()=>{
 const f=workspaceFixture(),bottom=await shell(f),before=bottom.states.length;f.workspace.setActiveLeaf(f.dashboard);await f.plugin.activateWork();
 assert.equal(f.revealed.at(-1),bottom);assert.equal(f.created.length,1);assert.equal(bottom.states.length,before);assert.equal(bottom.unsentText,'Keep my unfinished command');assert.deepEqual(f.commands,[]);assert.deepEqual(f.reads,[]);assert.deepEqual(choices,[]);assert.equal(f.leaves.some(leaf=>leaf.type==='aos-v2-work'),false);
});
test('a stopped current conversation opens the plain shell without resuming or replacing its saved selection',async()=>{
 const f=workspaceFixture();f.tasks[0].state='stopped';f.tasks[0].pid=null;setPersistedCurrent({codex,claude});setCachedCurrent({codex,claude});await f.plugin.activateWork();
 assert.deepEqual(f.commands,['terminal:open-terminal.default.root']);assert.equal(f.created.length,1);assert.equal(f.created[0].leaf.type,'terminal:terminal');assert.equal(runtime.terminalConversation(f.created[0].leaf),null);assert.equal(workTarget('codex'),codex);assert.equal(workTarget('claude'),claude);assert.deepEqual(choices,[]);assert.deepEqual(apiCalls,[]);
});
test('the generic terminal command remains available when the bridge is offline',async()=>{
 const f=workspaceFixture();setRefreshFailure(true);await f.plugin.activateWork();
 assert.deepEqual(f.commands,['terminal:open-terminal.default.root']);assert.equal(f.created.length,1);assert.equal(f.created[0].leaf.type,'terminal:terminal');assert.deepEqual(f.reads,[]);assert.deepEqual(choices,[]);assert.deepEqual(apiCalls,[]);assert.equal(runtime.refreshes,0);
});
test('concurrent duplicate task-open events reuse one actual native terminal',async()=>{
 const f=workspaceFixture();await Promise.all([f.plugin.activateWork([codex]),f.plugin.activateWork([codex,codex]),f.plugin.activateWork([codex])]);
 assert.equal(f.created.length,1);assert.equal(f.created[0].leaf.states.length,1);assert.deepEqual(taskIds(f),[codex]);assert.equal(workTarget(),codex);assert.equal(f.revealed.length,3);
});
test('multiple tasks create grouped native tabs below the retained dashboard and focus the first ID',async()=>{
 const f=workspaceFixture();await f.plugin.activateWork([codex,claude,other,claude]);
 assert.equal(f.created.length,3);assert.deepEqual(f.created.map(c=>[c.kind,c.direction]),[['split','horizontal'],['tab',undefined],['tab',undefined]]);assert.deepEqual(taskIds(f),[codex,claude,other]);assert.equal(new Set(f.created.map(c=>c.leaf.group)).size,1);
 assert.equal(f.created[0].anchor,f.dashboard);assert.equal(f.created[1].anchor,f.created[0].leaf);assert.equal(f.revealed.at(-1),f.created[0].leaf);assert.equal(workTarget(),codex);assert.deepEqual(f.dashboard.states,[]);assert.ok(f.leaves.includes(f.dashboard));
});
test('new live task tabs join the existing plain PowerShell group without replacing its input',async()=>{
 const f=workspaceFixture(),bottom=await shell(f),before=bottom.states.length;f.workspace.setActiveLeaf(f.dashboard);await f.plugin.activateWork([codex,claude]);
 assert.equal(f.created.length,3);assert.equal(f.created[1].kind,'tab');assert.equal(f.created[1].anchor,bottom);assert.equal(f.created[1].leaf.group,bottom.group);assert.equal(f.created[2].leaf.group,bottom.group);assert.equal(bottom.states.length,before);assert.equal(bottom.unsentText,'Keep my unfinished command');assert.equal(runtime.terminalConversation(bottom),null);
});
test('explicit stopped, missing and script task IDs only show notices and never create a custom view or resume work',async()=>{
 const f=workspaceFixture(),before=notices.length;f.tasks[0].state='stopped';f.tasks[0].pid=null;f.tasks[1].execution='script';f.tasks.splice(2);await f.plugin.activateWork([codex,claude,other],false);
 assert.equal(f.created.length,0);assert.deepEqual(f.revealed,[]);assert.deepEqual(f.commands,[]);assert.deepEqual(choices,[]);assert.deepEqual(apiCalls,[]);assert.ok(notices.length>=before+3);
});
test('disabled Terminal plugin does not recreate the custom launcher for either generic or live task opening',async()=>{
 const f=workspaceFixture(),before=notices.length;delete f.plugin.app.plugins.plugins.terminal;await f.plugin.activateWork();await f.plugin.activateWork([codex],false);
 assert.equal(f.created.length,0);assert.deepEqual(f.commands,[]);assert.deepEqual(f.reads,[]);assert.ok(notices.length>before);assert.doesNotMatch(notices.slice(before).join('\n'),/opening the built-in/i);
});
test('active native task selection survives dashboard navigation until explicitly reset',async t=>{
 withWindow(t);const f=workspaceFixture();await f.plugin.onload();await f.plugin.activateWork([codex,other]);f.workspace.setActiveLeaf(f.created[1].leaf);assert.equal(workTarget(),other);f.workspace.setActiveLeaf(f.dashboard);assert.equal(workTarget(),other);
 await f.plugin.activateWork();assert.equal(runtime.terminalConversation(f.revealed.at(-1)).id,other);assert.equal(workTarget(),other);chooseWork(null);await f.plugin.activateWork();assert.equal(runtime.terminalConversation(f.revealed.at(-1)),null);assert.equal(f.revealed.at(-1).type,'terminal:terminal');assert.equal(workTarget(),null);for(const cleanup of f.plugin.cleanup)cleanup();
});
test('a failed native activation reports the problem without poisoning the next queued request or creating fallback UI',async()=>{
 const f=workspaceFixture(),getLeaf=f.workspace.getLeaf.bind(f.workspace),before=notices.length;let fail=true;f.workspace.getLeaf=(...args)=>{if(fail){fail=false;throw new Error('Fixture layout unavailable')}return getLeaf(...args)};
 await Promise.all([f.plugin.activateWork([codex]),f.plugin.activateWork([other])]);assert.equal(notices.length,before+1);assert.match(notices.at(-1),/Fixture layout unavailable/);assert.equal(f.created.length,1);assert.deepEqual(taskIds(f),[other]);assert.equal(workTarget(),other);assert.equal(f.leaves.some(leaf=>leaf.type==='aos-v2-work'),false);
});
test('registered voice-open events forward every ID and coalesce repeats',async t=>{
 withWindow(t);const f=workspaceFixture();await f.plugin.onload();for(const ids of [[codex,other,codex],[codex,other]]){const event=new Event('aos-open-work');event.detail=ids;window.dispatchEvent(event)}await f.plugin.workOpenQueue;
 assert.deepEqual(taskIds(f),[codex,other]);assert.equal(f.revealed.at(-1),f.created[0].leaf);assert.deepEqual(choices,[]);for(const cleanup of f.plugin.cleanup)cleanup();
});
test('automatic voice opening cannot overwrite the existing voice target through asynchronous anchor activation',async t=>{
 withWindow(t);const f=workspaceFixture();await f.plugin.onload();await f.plugin.activateWork([codex]);const oldLeaf=f.created[0].leaf;
 let entered,release;const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),getLeaf=f.workspace.getLeaf.bind(f.workspace);f.workspace.getLeaf=(...args)=>{const leaf=getLeaf(...args),setState=leaf.setViewState.bind(leaf);leaf.setViewState=async state=>{entered();await gate;return setState(state)};return leaf};
 const event=new Event('aos-open-work');event.detail=[other];window.dispatchEvent(event);await waiting;try{assert.equal(f.created.at(-1).anchor,oldLeaf);assert.equal(workTarget(),codex);assert.equal(f.plugin.openingWork,true);f.workspace.setActiveLeaf(oldLeaf);assert.equal(workTarget(),codex)}finally{release()}
 await f.plugin.workOpenQueue;assert.equal(f.plugin.openingWork,false);assert.equal(workTarget(),codex);f.workspace.setActiveLeaf(oldLeaf);assert.equal(workTarget(),codex);for(const cleanup of f.plugin.cleanup)cleanup();
});
test('the voice-target guard releases after native state restoration fails',async t=>{
 withWindow(t);const f=workspaceFixture();await f.plugin.onload();await f.plugin.activateWork([codex]);const getLeaf=f.workspace.getLeaf.bind(f.workspace),before=notices.length;f.workspace.getLeaf=(...args)=>{const leaf=getLeaf(...args);leaf.setViewState=async()=>{await new Promise(resolve=>setImmediate(resolve));assert.equal(f.plugin.openingWork,true);throw new Error('Fixture state restoration failed')};return leaf};
 const event=new Event('aos-open-work');event.detail=[other];window.dispatchEvent(event);await f.plugin.workOpenQueue;assert.equal(f.plugin.openingWork,false);assert.equal(notices.length,before+1);assert.match(notices.at(-1),/Fixture state restoration failed/);assert.equal(f.leaves.some(leaf=>leaf.type==='aos-v2-work'),false);
 f.workspace.setActiveLeaf(f.created[0].leaf);assert.equal(workTarget(),codex);f.workspace.setActiveLeaf(f.dashboard);assert.equal(workTarget(),codex);for(const cleanup of f.plugin.cleanup)cleanup();
});
test('before the feed loads, Terminals opens a plain shell immediately without fetching or clearing persisted selections',async()=>{
 const f=workspaceFixture();setPersistedCurrent({codex,claude});setFixtureTasks([]);setFixtureProvider('claude');setRefreshFailure(true);assert.equal(workTarget('claude'),null);await f.plugin.activateWork();
 assert.equal(runtime.terminalConversation(f.revealed.at(-1)),null);assert.equal(f.revealed.at(-1).type,'terminal:terminal');assert.deepEqual(persistedCurrent(),{codex,claude});assert.equal(workTarget('codex'),null);assert.equal(workTarget('claude'),null);assert.equal(runtime.refreshes,0);assert.deepEqual(f.reads,[]);assert.deepEqual(choices,[]);
});
test('with the orb disabled, Terminals follows each dashboard provider switch',async t=>{
 withWindow(t);const f=workspaceFixture();await f.plugin.onload();assert.equal(f.plugin.settings.orbEnabled,false);setPersistedCurrent({codex,claude});setCachedCurrent({codex,claude});setWorkProvider('codex');await f.plugin.activateWork();assert.equal(runtime.terminalConversation(f.revealed.at(-1)).id,codex);
 setFixtureProvider('claude');const event=new Event('aos-open-work');event.detail=[];window.dispatchEvent(event);await f.plugin.workOpenQueue;assert.equal(runtime.terminalConversation(f.revealed.at(-1)).id,claude);assert.equal(runtime.refreshes,0);assert.deepEqual(choices,[]);
 setFixtureProvider('codex');await f.plugin.activateWork();assert.equal(runtime.terminalConversation(f.revealed.at(-1)).id,codex);assert.equal(f.created.length,2);for(const cleanup of f.plugin.cleanup)cleanup();
});
test('explicit New terminal forces a new shell and clears only the provider captured at invocation',async()=>{
 const f=workspaceFixture();setPersistedCurrent({codex,claude});setCachedCurrent({codex,claude});await f.plugin.activateWork();const bottom=await shell(f);setFixtureProvider('claude');const open=f.plugin.activateWork([null]);setFixtureProvider('codex');await open;
 assert.notEqual(f.revealed.at(-1),bottom);assert.equal(f.revealed.at(-1).type,'terminal:terminal');assert.equal(runtime.terminalConversation(f.revealed.at(-1)),null);assert.deepEqual(f.commands,['terminal:open-terminal.default.root']);assert.equal(bottom.unsentText,'Keep my unfinished command');assert.equal(workTarget('codex'),codex);assert.equal(workTarget('claude'),null);assert.deepEqual(choices,[{provider:'claude',id:null}]);
});
test('finishing asynchronous native layout cannot overwrite a newer explicit conversation choice',async()=>{
 const f=workspaceFixture();let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve),getLeaf=f.workspace.getLeaf.bind(f.workspace);f.workspace.getLeaf=(...args)=>{const leaf=getLeaf(...args),setState=leaf.setViewState.bind(leaf);leaf.setViewState=async state=>{enter();await gate;return setState(state)};return leaf};
 const open=f.plugin.activateWork([codex]);await entered;chooseWork(other);release();await open;assert.equal(workTarget(),other);assert.deepEqual(choices,[{provider:'codex',id:codex},{provider:'codex',id:other}]);
});
test('native task focus remembers its own provider without changing the dashboard voice provider',async t=>{
 withWindow(t);const f=workspaceFixture();await f.plugin.onload();await f.plugin.activateWork([codex,claude]);f.workspace.setActiveLeaf(f.created[1].leaf);assert.equal(workTarget('claude'),claude);assert.equal(workTarget(),codex);f.workspace.setActiveLeaf(f.dashboard);assert.equal(workTarget('claude'),claude);assert.equal(workTarget('codex'),codex);
 const before=choices.length;await f.plugin.activateWork([claude],false);assert.equal(choices.length,before);assert.equal(f.created.length,2);for(const cleanup of f.plugin.cleanup)cleanup();
});
test('explicit native activation migrates a matching legacy task leaf in place',async()=>{
 const f=workspaceFixture(),original=f.workspace.getLeaf('tab');await original.setViewState({type:'aos-v2-work',state:{taskId:codex}});await f.plugin.activateWork([codex]);assert.equal(f.created.length,1);assert.equal(original.type,'terminal:terminal');assert.equal(f.revealed.at(-1),original);assert.deepEqual(runtime.terminalConversation(original),{id:codex,provider:'codex'});
});
test('closing a native Terminal during activation does not resurrect it as a fallback pane',async()=>{
 const f=workspaceFixture(),getLeaf=f.workspace.getLeaf.bind(f.workspace);f.workspace.getLeaf=(...args)=>{const leaf=getLeaf(...args),set=leaf.setViewState.bind(leaf);leaf.setViewState=async state=>{await set(state);leaf.detach()};return leaf};
 await f.plugin.activateWork([codex]);assert.equal(f.created.length,1);assert.deepEqual(f.leaves,[f.dashboard]);assert.deepEqual(f.revealed,[]);
});

function directState(id=codex,provider='codex'){
 return {type:'terminal:terminal',state:{'terminal:terminal':{cwd:config.vault,profileSourceId:null,serial:null,profile:{type:'integrated',executable:config.nodeExecutable,args:['C:\\fixture\\runner\\native-launch.mjs','--ticket','C:\\fixture\\ticket.json'],environment:[['AOS_V2_NATIVE_DIRECT','1'],['AOS_V2_TASK_ID',id],['AOS_V2_TASK_PROVIDER',provider],['AOS_V2_NATIVE_INSTANCE',id]]}}}};
}
test('direct tasks route through the direct host and never call the legacy attachment adapter',async t=>{
 const f=workspaceFixture();t.after(()=>f.plugin.cleanup.forEach(fn=>fn()));withWindow(t);await f.plugin.onload();f.tasks[0].execution='native';
 const leaf=f.workspace.getLeaf('tab');await leaf.setViewState(directState());f.plugin.nativeDirect.result=leaf;f.plugin.nativeTerminals.open=()=>assert.fail('Direct tasks must not open an attachment');
 await f.plugin.activateWork([codex],false);assert.deepEqual(f.plugin.nativeDirect.opens,[codex]);assert.equal(f.revealed.at(-1),leaf);assert.deepEqual(choices,[]);assert.deepEqual(f.reads,[]);
 f.plugin.nativeDirect.result=null;await f.plugin.activateWork([codex],false);assert.equal(f.created.length,1);assert.equal(f.revealed.length,1);
});
test('poll-driven layout preserves current selection and releases its guard while the CLI is starting',async t=>{
 const f=workspaceFixture();t.after(()=>f.plugin.cleanup.forEach(fn=>fn()));withWindow(t);await f.plugin.onload();f.tasks[0].execution='native';f.tasks[2].execution='native';
 const old=f.workspace.getLeaf('tab');await old.setViewState(directState(codex));chooseWork(other);const before=choices.length;
 let release;const ready=new Promise(resolve=>release=resolve);const opening=f.plugin.nativeDirect.simulateLaunch(directState(other),ready);
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(workTarget(),other);assert.equal(choices.length,before);assert.equal(f.plugin.nativeLayoutDepth,0);assert.equal(f.plugin.openingWork,false);
 // A real click during slow CLI startup remains an explicit newer choice.
 f.workspace.setActiveLeaf(old);assert.equal(workTarget(),codex);release();await opening;
 assert.equal(workTarget(),codex);assert.equal(choices.length,before+1);assert.equal(f.plugin.nativeLayoutDepth,0);assert.equal(runtime.terminalConversation(f.revealed.at(-1)).id,other);
});
test('a failed poll-driven layout releases the guard for subsequent real terminal selection',async t=>{
 const f=workspaceFixture();t.after(()=>f.plugin.cleanup.forEach(fn=>fn()));withWindow(t);await f.plugin.onload();
 const old=f.workspace.getLeaf('tab');await old.setViewState(directState(codex));const getLeaf=f.workspace.getLeaf.bind(f.workspace);f.workspace.getLeaf=(...args)=>{const leaf=getLeaf(...args);leaf.setViewState=async()=>{throw new Error('Layout failed')};return leaf};
 await assert.rejects(f.plugin.nativeDirect.simulateLaunch(directState(other)),/Layout failed/);assert.equal(f.plugin.nativeLayoutDepth,0);f.workspace.setActiveLeaf(old);assert.equal(workTarget(),codex);
});
