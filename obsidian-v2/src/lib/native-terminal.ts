import type {App, WorkspaceLeaf} from 'obsidian';
import {bindTerminalLifetime,createTerminalLifetime,lifetimeForView,type TerminalLifetime} from './terminal-lifetime';
import {terminalSupport} from '../../shared/terminal-support.mjs';

// This is a deliberately versioned view-state adapter, not a public Terminal
// automation API. Schema checked against the tagged sources of every version in
// shared/terminal-support.mjs: src/terminal/view.ts (State, spawn) and
// src/terminal/profile-properties.ts.
export const NATIVE_TERMINAL_VIEW='terminal:terminal';
type Provider='codex'|'claude';
interface Task {id:string;provider:Provider;title?:string;state:string;pid?:number|null;execution?:string}
interface Snapshot {vault:string;tasks:Task[];attachmentProtocol?:number}
export interface TerminalRuntime {version:1;nodeExecutable:string;attachmentScript:string;runtimeDir:string;vault:string}
interface Profile extends Record<string,unknown> {type:string;args?:unknown;environment?:unknown;executable?:unknown;platforms?:Record<string,boolean>}
interface TerminalPlugin {manifest?:{version?:unknown};settings?:{value?:{defaultProfile?:string;profiles?:Record<string,Profile>}}}
interface Options {pluginDir:string;readSnapshot:()=>Promise<Snapshot>;notice:(message:string)=>void;createLifetime?:()=>Promise<TerminalLifetime>}
/** The Terminal plugin and what its version allows. A plugin without a readable
 * version counts as missing. */
export function terminalPluginStatus(app:App):{plugin?:TerminalPlugin;support:ReturnType<typeof terminalSupport>} {
 const plugin=(app as App&{plugins?:{plugins?:Record<string,TerminalPlugin>}}).plugins?.plugins?.terminal;
 return {plugin,support:terminalSupport(plugin?plugin.manifest?.version:undefined)};
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const canonical=(value:string)=>{const normalized=value.replace(/\\/g,'/').replace(/\/$/,'');return /^[A-Za-z]:\//.test(normalized)?normalized.toLowerCase():normalized};
const absolute=(value:unknown):value is string=>typeof value==='string'&&!/[\x00-\x1f\x7f]/.test(value)&&(/^[A-Za-z]:[\\/]/.test(value)||value.startsWith('/'));
export function checkedTerminalRuntime(value:unknown,vault:string):TerminalRuntime {
 const config=value as TerminalRuntime|null;
 if(!config||config.version!==1||!absolute(config.vault)||canonical(config.vault)!==canonical(vault)||![config.nodeExecutable,config.attachmentScript,config.runtimeDir].every(absolute))throw new Error('Terminal launch configuration is unavailable for this vault. Run the V2 installer.');
 if(!/(?:^|[\\/])node(?:\.exe)?$/i.test(config.nodeExecutable)||!/[\\/]runner[\\/]terminal-attach\.mjs$/i.test(config.attachmentScript)||canonical(config.runtimeDir)!==canonical(config.attachmentScript.replace(/[\\/]runner[\\/]terminal-attach\.mjs$/i,'/.runtime')))throw new Error('Terminal launch configuration does not match the V2 runner. Run the V2 installer.');
 return config;
}
function profileState(leaf:WorkspaceLeaf):Record<string,any>|null {
 try{const state=leaf.getViewState();if(state.type!==NATIVE_TERMINAL_VIEW)return null;const value=(state.state as Record<string,unknown>|undefined)?.[NATIVE_TERMINAL_VIEW];return value&&typeof value==='object'?value as Record<string,any>:null}catch{return null}
}
export function terminalConversation(leaf:WorkspaceLeaf):{id:string;provider:Provider}|null {
 const state=profileState(leaf),profile=state?.profile,args=profile?.args,environment=profile?.environment;
 if(profile?.type==='integrated'&&Array.isArray(environment)){
  const metadata=Object.fromEntries(environment.filter((entry:unknown)=>Array.isArray(entry)&&entry.length===2));
  if(metadata.AOS_V2_NATIVE_DIRECT==='1'&&uuid.test(metadata.AOS_V2_TASK_ID)&&uuid.test(metadata.AOS_V2_NATIVE_INSTANCE)&&['codex','claude'].includes(metadata.AOS_V2_TASK_PROVIDER)&&absolute(profile.executable)&&/(?:^|[\\/])node(?:\.exe)?$/i.test(profile.executable)&&Array.isArray(args)&&args.length===3&&absolute(args[0])&&/[\\/]native-launch\.mjs$/i.test(args[0])&&args[1]==='--ticket'&&absolute(args[2]))return {id:metadata.AOS_V2_TASK_ID,provider:metadata.AOS_V2_TASK_PROVIDER};
 }
 if(profile?.type!=='integrated'||!Array.isArray(args)||args.length!==5||typeof args[0]!=='string'||!/[\\/]runner[\\/]terminal-attach\.mjs$/.test(args[0])||args[1]!=='--runtime'||args[3]!=='--task'||typeof args[4]!=='string'||!uuid.test(args[4])||!Array.isArray(environment))return null;
 const metadata=Object.fromEntries(environment.filter((entry:unknown)=>Array.isArray(entry)&&entry.length===2));
 if(metadata.AOS_V2_TASK_ID!==args[4]||!['codex','claude'].includes(metadata.AOS_V2_TASK_PROVIDER))return null;
 return {id:args[4],provider:metadata.AOS_V2_TASK_PROVIDER};
}
export function attachmentViewState(config:TerminalRuntime,task:Task,base:Profile={type:'integrated'},platform='win32',lifetimeEndpoint?:string) {
 if(!uuid.test(task.id)||!['codex','claude'].includes(task.provider))throw new Error('This terminal task is invalid.');
 const title=`${task.provider==='codex'?'Codex':'Claude'} · ${(task.title||'Conversation').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,70)}`;
 return {type:NATIVE_TERMINAL_VIEW,active:false,state:{[NATIVE_TERMINAL_VIEW]:{
  cwd:config.vault,focus:false,profileSourceId:null,serial:null,userTitle:title,
  profile:{type:'integrated',name:title,executable:config.nodeExecutable,args:[config.attachmentScript,'--runtime',config.runtimeDir,'--task',task.id],
   environment:[['AOS_V2_TASK_ID',task.id],['AOS_V2_TASK_PROVIDER',task.provider],...(lifetimeEndpoint?[['AOS_V2_TERMINAL_LIFETIME',lifetimeEndpoint]]:[])],platforms:{[platform]:true},
   pythonExecutable:typeof base.pythonExecutable==='string'?base.pythonExecutable:platform==='win32'?'python':'python3',
   // Our Windows attachment needs real TTY handles for raw input and resize.
   // Verified with the 3.27.x conhost+batch launch; never inherit its
   // optional pipe-only backend. This does not change the user's own profiles.
   useWin32Conhost:platform==='win32'?true:typeof base.useWin32Conhost==='boolean'?base.useWin32Conhost:true,
   followTheme:typeof base.followTheme==='boolean'?base.followTheme:true,rightClickAction:base.rightClickAction||'copyPaste',
   terminalOptions:base.terminalOptions&&typeof base.terminalOptions==='object'?structuredClone(base.terminalOptions):{documentOverride:null},
   restoreHistory:false,successExitCodes:['0','SIGINT','SIGTERM']},
 }}};
}
export class NativeTerminalTabs {
 private warned=new Set<string>();
 constructor(private app:App,private options:Options){}
 private plugin():TerminalPlugin|undefined {
  return (this.app as App&{plugins?:{plugins?:Record<string,TerminalPlugin>}}).plugins?.plugins?.terminal;
 }
 private fallback(message:string){if(!this.warned.has(message)){this.warned.add(message);this.options.notice(message)}return null}
 /** Open the user's own Terminal profile, exactly like its ribbon command.
  * Navigation never types into, resets, or adopts an existing shell as an agent. */
 async openShell(forceNew=false):Promise<void> {
  const plugin=this.plugin();
  if(!plugin){this.fallback('Enable the Terminal plugin in Obsidian to open a terminal.');return}
  const vault=(this.app.vault.adapter as typeof this.app.vault.adapter&{getBasePath?:()=>string}).getBasePath?.();
  if(!vault){this.fallback('Terminal requires a local vault.');return}
  const settings=plugin.settings?.value,profileId=settings?.defaultProfile,profile=profileId?settings?.profiles?.[profileId]:undefined;
  if(!profile||profile.type!=='integrated'){this.fallback('Choose an integrated default profile in Terminal settings.');return}
  if(!forceNew){
   const existing=this.app.workspace.getLeavesOfType(NATIVE_TERMINAL_VIEW).find(leaf=>{
    const state=profileState(leaf);
    return state&&canonical(String(state.cwd))===canonical(vault)&&!terminalConversation(leaf)&&
     state.profile?.type==='integrated'&&state.profile.executable===profile.executable&&
     JSON.stringify(state.profile.args||[])===JSON.stringify(profile.args||[])&&
     JSON.stringify(state.profile.environment||[])===JSON.stringify(profile.environment||[]);
   });
   if(existing){await this.app.workspace.revealLeaf(existing);return}
  }
  const commands=(this.app as App&{commands?:{executeCommandById?:(id:string)=>boolean}}).commands;
  try{
   if(!commands?.executeCommandById?.('terminal:open-terminal.default.root'))this.fallback('The Terminal command is unavailable. Enable its commands in Terminal settings.');
  }catch(error){this.fallback(`Terminal could not open: ${String(error instanceof Error?error.message:error)}`)}
 }
 /** No task mutation occurs here: the launched program only attaches to a CLI
  * already owned by the bridge. It never resumes a stopped conversation. */
 // null means unavailable; undefined means the user closed/replaced the leaf
 // while it opened, so navigation must not recreate it.
 async open(id:string|null,createLeaf:()=>WorkspaceLeaf,replaceLeaf?:WorkspaceLeaf):Promise<WorkspaceLeaf|null|undefined> {
  if(!id)return null;
  const {plugin,support}=terminalPluginStatus(this.app);
  if(!plugin||support.status==='missing'||support.status==='unsupported')return this.fallback(support.message);
  if(support.status==='untested')this.fallback(support.message);
  const direct=this.app.workspace.getLeavesOfType(NATIVE_TERMINAL_VIEW).find(leaf=>terminalConversation(leaf)?.id===id&&profileState(leaf)?.profile?.environment?.some((entry:unknown)=>Array.isArray(entry)&&entry[0]==='AOS_V2_NATIVE_DIRECT'&&entry[1]==='1'));
  // Direct conversations belong to Terminal itself. Selecting their existing
  // view must never reapply launch state or start a legacy attachment process.
  if(direct)return direct;
  try{
   const basePath=(this.app.vault.adapter as typeof this.app.vault.adapter&{getBasePath?:()=>string}).getBasePath?.();
   if(!basePath)return this.fallback('Native Terminal requires a local vault.');
   const config=checkedTerminalRuntime(JSON.parse(await this.app.vault.adapter.read(`${this.options.pluginDir}/terminal-runtime.json`)),basePath);
   const snapshot=await this.options.readSnapshot();
   if(canonical(snapshot.vault)!==canonical(config.vault))return this.fallback('The terminal bridge is connected to a different vault.');
   if(snapshot.attachmentProtocol!==1)return this.fallback('The V2 bridge needs its terminal attachment update. Restart the updated bridge when its work is safe to interrupt.');
   const task=snapshot.tasks.find(task=>task.id===id);
   if(!task)return this.fallback('That saved conversation is no longer available.');
   if(task.execution==='native')return this.fallback('Open this conversation from Jarvis to restore its native terminal.');
   if(task.execution==='headless')return this.fallback('This workflow runs in the background. Its report appears on the dashboard.');
   if(task.execution==='script')return this.fallback('This refresh runs as a script. Its results appear on the dashboard.');
   if(!task.pid&&['stopped','error'].includes(task.state))return this.fallback('That conversation is stopped. Resume it from Jarvis history, or open a new terminal.');
   const existing=this.app.workspace.getLeavesOfType(NATIVE_TERMINAL_VIEW).find(leaf=>{
    const target=terminalConversation(leaf),state=profileState(leaf),profile=state?.profile;
    return target?.id===id&&target.provider===task.provider&&canonical(String(profile.executable))===canonical(config.nodeExecutable)&&canonical(String(profile.args?.[0]))===canonical(config.attachmentScript)&&canonical(String(profile.args?.[2]))===canonical(config.runtimeDir);
   });
   // Re-selecting a tab must not call setViewState: Terminal starts a new
   // attachment process every time that method is invoked, even on the same ID.
   const lifetime=existing?lifetimeForView(existing.view):undefined;
   const existingEndpoint=existing?profileState(existing)?.profile?.environment?.find((entry:unknown)=>Array.isArray(entry)&&entry[0]==='AOS_V2_TERMINAL_LIFETIME')?.[1]:undefined;
   if(existing&&lifetime?.active&&existingEndpoint===lifetime.endpoint)return existing;
   const platform=canonical(config.nodeExecutable).match(/^[a-z]:\//)?'win32':typeof process!=='undefined'?process.platform:'darwin';
   const settings=plugin.settings?.value,profiles=settings?.profiles||{},preferred=settings?.defaultProfile?profiles[settings.defaultProfile]:undefined;
   const base=preferred?.type==='integrated'&&preferred.platforms?.[platform]?preferred:Object.values(profiles).find(profile=>profile.type==='integrated'&&profile.platforms?.[platform])||{type:'integrated'};
   const controller=await (this.options.createLifetime||createTerminalLifetime)();
   // A serialized tab after an app restart has an expired socket. Refresh that
   // same leaf only when explicitly opened, without starting/resuming its CLI.
   const replacement=existing||replaceLeaf,previous=replacement?.getViewState();
   let leaf:WorkspaceLeaf|undefined;
   try{
    leaf=replacement||createLeaf();
    await leaf.setViewState(attachmentViewState(config,task,base,platform,controller.endpoint));
    const endpoint=profileState(leaf)?.profile?.environment?.find((entry:unknown)=>Array.isArray(entry)&&entry[0]==='AOS_V2_TERMINAL_LIFETIME')?.[1];
    if(!this.app.workspace.getLeavesOfType(NATIVE_TERMINAL_VIEW).includes(leaf)||endpoint!==controller.endpoint){controller.close();return undefined}
    bindTerminalLifetime(leaf.view,controller);return leaf;
   }catch(error){
    controller.close();
    if(leaf){
     if(!this.app.workspace.getLeavesOfType(leaf.getViewState().type).includes(leaf))return undefined;
     if(previous)await leaf.setViewState(previous);else leaf.detach();
    }
    throw error;
   }
  }catch(error){return this.fallback(`Native Terminal could not open: ${String(error instanceof Error?error.message:error)}`)}
 }
}
