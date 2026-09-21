import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {build} from 'esbuild';

// Run the actual plugin command and OrbFloat component. The hook fixture keeps
// layout effects synchronous and passive effects deferred, as Preact does.
const stubs={
 obsidian:`export class Notice{}export class WorkspaceLeaf{}export class Plugin{constructor(app){this.app=app;this.manifest={id:'fixture'};this.commands=[];this.cleanup=[]}registerView(){}addCommand(value){this.commands.push(value)}addRibbonIcon(){}addSettingTab(){}register(fn){this.cleanup.push(fn)}registerEvent(){}async loadData(){return {orbEnabled:false,orbRight:12,orbBottom:12,pauseMotion:true}}}`,
 preact:`import {flushLayout,cleanup} from 'preact/hooks';export const h=(type,props,...children)=>({type,props:{...props,children}});export function render(vnode){if(vnode){vnode.type(vnode.props);flushLayout()}else cleanup()}`,
 'preact/hooks':`let layout=[],passive=[],cleanups=[];const run=queue=>{for(const effect of queue.splice(0)){const dispose=effect();if(dispose)cleanups.push(dispose)}};export const useEffect=effect=>passive.push(effect),useLayoutEffect=effect=>layout.push(effect);export const useState=initial=>[typeof initial==='function'?initial():initial,()=>{}],useRef=current=>({current}),useMemo=fn=>fn();export const flushLayout=()=>run(layout),flushPassive=()=>run(passive);export function cleanup(){passive=[];layout=[];for(const dispose of cleanups.splice(0).reverse())dispose()}`,
 'work-view':`export const WORK_VIEW='fixture-work';export class WorkView{}`,
 view:`export const COCKPIT_VIEW_TYPE='fixture-cockpit';export class CockpitView{}`,
 settings:`export const DEFAULT_SETTINGS={};export class ChaseSettingTab{}`,
 'lib/provider':`export async function assertTestVault(){}export async function readSelection(){return {provider:'codex',model:'fixture'}}export const useProvider=()=>({selection:{provider:'codex',model:'fixture'}})`,
 'lib/work':`export const workTarget=()=>null,chooseWork=()=>{},setWorkProvider=()=>{},openWork=()=>{},workRequest=()=>{},isLiveTerminal=()=>false;export const workFeed={getSnapshot:()=>({tasks:[]}),subscribe:()=>()=>{},refresh:async()=>({tasks:[]})},workConversations={getSelection:async chosen=>chosen,sync:()=>{}}`,
 'lib/v2-voice':`export function configureVoiceTransport(){}export async function assertVoiceVault(){}export const v2VoiceTransport=()=>{throw new Error('No network allowed')}`,
 'lib/voice-actions':`export async function applyVoiceAction(){}export async function openVoiceArtifact(){}`,
 'lib/queue':`export function registerSkillReports(){}export async function readRun(){return null}`,
 'lib/native-terminal':`export const NATIVE_TERMINAL_VIEW='fixture-terminal',terminalConversation=()=>null;export class NativeTerminalTabs{}`,
 'lib/native-direct-host':`export class NativeDirectHost{}`,
 'lib/native-voice-heartbeat':`export function nativeVoiceHeartbeat(){}`,
 'lib/retire-legacy-launchers':`export function retireEmptyLaunchers(){}`,
 'components/WorkflowModal':`export function openWorkflowPicker(){}`,
 GalaxyCore:`export default function GalaxyCore(){}`,
 GraphCore:`export function GraphCore(){}`,
 'shared/work-presentation':`export const shortConversationTitle=value=>value`,
 'shared/voice-session':`export const sessions=[];export class VoiceSession{constructor(){this.mode='idle';this.toggles=0;this.connected=false;this.destroyed=false;this.getLevel=()=>null;sessions.push(this)}connect(){this.connected=true}async toggle(){this.toggles++;this.mode='listening';this.onState?.(this.mode)}async destroy(){this.destroyed=true}cancelArtifact(){}cancel(){this.mode='idle'}}`,
};
const result=await build({stdin:{contents:`export {default as TestedPlugin} from './src/main';export {sessions} from './shared/voice-session';export {flushPassive} from 'preact/hooks';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',jsxFactory:'h',write:false,plugins:[{name:'orb-start-fixture',setup(builder){
 builder.onResolve({filter:/.*/},args=>{
  if(args.path==='./src/main')return {path:path.resolve('src/main.ts')};
  if(args.path==='./components/OrbFloat')return {path:path.resolve('src/components/OrbFloat.tsx')};
  const key=args.path.replace(/^(?:\.\.\/|\.\/)+(?:src\/)?/,'');
  if(key in stubs)return {path:key,namespace:'fixture'};throw new Error('Unexpected orb dependency '+args.path);
 });
 builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path],loader:'js'}));
}}]});
const {TestedPlugin,sessions,flushPassive}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));

test('first native voice command mounts a disabled orb and starts recording before passive effects',async t=>{
 const priorWindow=globalThis.window,priorDocument=globalThis.document;
 const timers=new Set();let timerId=0;
 globalThis.window=Object.assign(new EventTarget(),{setInterval:()=>{timers.add(++timerId);return timerId},clearInterval:id=>timers.delete(id)});
 globalThis.document={documentElement:{clientWidth:1200,clientHeight:900},body:{createDiv:()=>({remove(){}})}};
 const app={vault:{configDir:'.obsidian',adapter:{}},workspace:{onLayoutReady:fn=>fn(),on:()=>({})}};
 const plugin=new TestedPlugin(app);
 t.after(async()=>{await plugin.onunload();for(const dispose of plugin.cleanup)dispose();if(priorWindow===undefined)delete globalThis.window;else globalThis.window=priorWindow;if(priorDocument===undefined)delete globalThis.document;else globalThis.document=priorDocument});
 await plugin.onload();assert.equal(plugin.settings.orbEnabled,false);assert.equal(sessions.length,0);
 const command=plugin.commands.find(item=>item.id==='toggle-voice-recording');assert.ok(command);
 command.callback();assert.equal(plugin.settings.orbEnabled,true);const session=sessions.at(-1);
 assert.equal(session.connected,true,'transport and handlers must exist before the command dispatches');
 assert.equal(session.toggles,1,'the very first event reaches the new recording session');assert.equal(session.mode,'listening');
 flushPassive();assert.equal(session.toggles,1,'passive effects do not start a duplicate recording');
 command.callback();assert.equal(session.toggles,2);assert.equal(sessions.length,1);
 await plugin.onunload();window.dispatchEvent(new Event('aos-toggle-voice'));assert.equal(session.toggles,2);assert.equal(session.destroyed,true);assert.equal(timers.size,0);
});
