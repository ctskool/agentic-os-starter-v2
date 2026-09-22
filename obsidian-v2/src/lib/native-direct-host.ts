import type {App,WorkspaceLeaf} from 'obsidian';
import {NATIVE_TERMINAL_VIEW,terminalPluginStatus} from './native-terminal';
import {untrackedLaunchMessage} from '../../shared/terminal-support.mjs';
import {bindDirectTerminal,TerminalAccessError,type DirectTerminalBinding,type DirectTerminalView} from './direct-terminal-pty';
import {directId,directTerminalMetadata,directTerminalViewState,type DirectAction} from './direct-terminal-profile';
import {bindTerminalLifetime,createTerminalLifetime,lifetimeForView,type TerminalLifetime} from './terminal-lifetime';

interface NativeEvent {taskId:string;instance:string;actionId?:string;type:string;reason?:string;hasDraft?:boolean;hostPid?:number|null}
interface Session {taskId:string;instance:string;leaf:WorkspaceLeaf;view:DirectTerminalView;binding:DirectTerminalBinding;lifetime:TerminalLifetime;revision:number;closed:boolean}
interface Registry {sessions:Map<string,Session>;claimed:Set<string>;events:NativeEvent[];queue:Promise<void>;notified?:Set<string>}
interface HostOptions {
 app:App;request:(path:string,body?:unknown)=>Promise<any>;createLeaf:()=>WorkspaceLeaf;
 reveal?:(leaf:WorkspaceLeaf)=>Promise<void>;notice:(message:string)=>void;
 withLayout?:<T>(operation:()=>Promise<T>)=>Promise<T>;
 /** Test seams avoid real PTYs and clocks. */
 bind?:typeof bindDirectTerminal;settle?:()=>Promise<void>;createLifetime?:()=>Promise<TerminalLifetime>;
}
const registryKey=Symbol.for('agentic-os-v2.native-direct-host.v1');
const registryGlobal=globalThis as typeof globalThis&{[registryKey]?:WeakMap<object,Registry>};
const registries=registryGlobal[registryKey]??=new WeakMap<object,Registry>();
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const canonical=(value:string)=>value.replace(/\\/g,'/').replace(/\/$/,'').toLowerCase();

/** The bridge coordinates intent and receipts. Terminal owns launch, input,
 * rendering and process lifetime; no terminal byte stream crosses this API. */
export class NativeDirectHost {
 private registry:Registry;
 private disposed=false;
 constructor(private options:HostOptions){
  this.registry=registries.get(options.app)??{sessions:new Map(),claimed:new Set(),events:[],queue:Promise.resolve(),notified:new Set()};
  registries.set(options.app,this.registry);
 }
 /** One notice per reason for the whole Obsidian session, also across plugin reloads. */
 private noticeOnce(reason:string){const notified=this.registry.notified??=new Set();if(notified.has(reason))return;notified.add(reason);this.options.notice(reason)}
 /** A missing or unsupported Terminal refuses before any action is claimed. */
 private verified(){const status=terminalPluginStatus(this.options.app);if(!status.plugin||status.support.status==='missing'||status.support.status==='unsupported')throw new Error(status.support.message);return {plugin:status.plugin,support:status.support}}
 private layout<T>(operation:()=>Promise<T>){return this.options.withLayout?this.options.withLayout(operation):operation()}
 private alive(session:Session){const target=directTerminalMetadata(session.leaf);return !session.closed&&session.binding.active&&session.lifetime.active&&session.leaf.view===session.view&&this.options.app.workspace.getLeavesOfType(NATIVE_TERMINAL_VIEW).includes(session.leaf)&&target?.id===session.taskId&&target.instance===session.instance}
 private enqueue(event:NativeEvent){
  // Repeated keystrokes only need the most recent editing status. Lifecycle and
  // submission acknowledgements retain order and are retried without input.
  const previous=this.registry.events.at(-1);
  if(event.type==='editing'&&previous?.type==='editing'&&previous.taskId===event.taskId&&previous.instance===event.instance)this.registry.events[this.registry.events.length-1]=event;
  else this.registry.events.push(event);
 }
 private async flush(){while(this.registry.events.length){const event=this.registry.events[0]!;await this.options.request('/native/event',event);this.registry.events.shift()}}
 private bind(leaf:WorkspaceLeaf,taskId:string,instance:string,lifetime:TerminalLifetime,actionId?:string){
  const prior=this.registry.sessions.get(instance);if(prior&&prior.leaf===leaf&&this.alive(prior))return prior;
  prior?.binding.dispose();
  const session={taskId,instance,leaf,lifetime,view:leaf.view as unknown as DirectTerminalView,revision:0,closed:false} as Session;
  const event=(type:string,extra:Partial<NativeEvent>={})=>this.enqueue({taskId,instance,...(actionId&&type==='launched'?{actionId}:{}),type,...extra});
  const close=(reason:string)=>{if(session.closed)return;session.closed=true;session.revision++;session.lifetime.close();event('closed',{reason})};
  session.binding=(this.options.bind||bindDirectTerminal)(session.view,{
   ready:({hostPid})=>{if(actionId)event('launched',{hostPid})},
   input:({submitted,hasDraft})=>{session.revision++;event(submitted?'submitted':'editing',{hasDraft})},
   approval:reason=>{session.revision++;event('approval',{reason,hasDraft:session.binding.hasDraft})},
   exit:code=>close(`Terminal exited (${String(code)}).`),
   closed:reason=>{if(reason!=='disposed')close(reason==='replaced'?'The Terminal session was replaced.':'The Terminal tab was closed.')},
   error:reason=>{session.revision++;event('error',{reason})},
  },{provider:directTerminalMetadata(leaf)?.provider});
  this.registry.sessions.set(instance,session);return session;
 }
 private adopt(){
  for(const leaf of this.options.app.workspace.getLeavesOfType(NATIVE_TERMINAL_VIEW)){
   const target=directTerminalMetadata(leaf);if(!target)continue;
   const prior=this.registry.sessions.get(target.instance);
   // A copied view carries the same serialized identity. It must never acquire
   // the original task's controller or steal its follow-up destination.
   if(prior&&prior.leaf!==leaf)continue;
   const lifetime=lifetimeForView(leaf.view);
   if(!prior&&lifetime?.active)this.bind(leaf,target.id,target.instance,lifetime);
  }
 }
 private async launch(action:DirectAction){
  const {plugin,support}=this.verified(),launch=action.launch;
  if(support.status==='untested')this.noticeOnce(support.message);
  const vault=(this.options.app.vault.adapter as typeof this.options.app.vault.adapter&{getBasePath?:()=>string}).getBasePath?.();
  if(!vault||!launch||canonical(launch.cwd)!==canonical(vault))throw new Error('The native terminal launch names a different vault.');
  const prior=this.registry.sessions.get(action.instance);
  if(prior){if(this.alive(prior)){this.enqueue({taskId:action.taskId,instance:action.instance,actionId:action.id,type:'launched',hostPid:prior.binding.hostPid});return prior.leaf}throw new Error('This native terminal launch has already been used. Resume the conversation explicitly.')}
  const settings=plugin.settings?.value,base=settings?.defaultProfile?settings.profiles?.[settings.defaultProfile]:undefined;
  const lifetime=await (this.options.createLifetime||createTerminalLifetime)();
  // This socket carries only READY and disconnect. The launcher uses it to
  // stop its owned CLI tree even when Terminal kills conhost before unloading.
  const withLifetime={...action,launch:{...launch,environment:[...(launch.environment||[]).filter(([key])=>key!=='AOS_V2_TERMINAL_LIFETIME'),['AOS_V2_TERMINAL_LIFETIME',lifetime.endpoint] as [string,string]]}};
  let leaf:WorkspaceLeaf|undefined;
  try{
   const state=directTerminalViewState(withLifetime,base?.type==='integrated'?base:{});
   leaf=await this.layout(async()=>{const created=this.options.createLeaf();leaf=created;await created.setViewState(state);return created});
   const target=directTerminalMetadata(leaf);
   if(!this.options.app.workspace.getLeavesOfType(NATIVE_TERMINAL_VIEW).includes(leaf)||target?.instance!==action.instance){lifetime.close();this.enqueue({taskId:action.taskId,instance:action.instance,actionId:action.id,type:'closed',reason:'The terminal was closed while opening.'});return null}
   bindTerminalLifetime(leaf.view,lifetime);
   const session=this.bind(leaf,action.taskId,action.instance,lifetime,action.id);
   await session.binding.ready;
   if(!this.alive(session))return null;
   await this.layout(async()=>{await this.options.reveal?.(leaf!)});return leaf;
  }catch(error){
   if(!leaf||leaf.getViewState().type!==NATIVE_TERMINAL_VIEW)lifetime.close();
   // The profile may already have launched a process. Leave that Terminal view
   // visible for inspection instead of reconstructing it or relaunching.
   if(leaf&&leaf.getViewState().type==='empty')leaf.detach();
   // An untested Terminal may have started the CLI in a tab we cannot follow.
   // Say so plainly; a closed or replaced tab keeps its own message.
   if(support.status==='untested'&&(error as Error|undefined)?.name===TerminalAccessError.NAME&&leaf&&this.options.app.workspace.getLeavesOfType(NATIVE_TERMINAL_VIEW).includes(leaf))throw new Error(untrackedLaunchMessage(support.version));
   throw error;
  }
 }
 private async send(action:DirectAction){
  const session=this.registry.sessions.get(action.instance);
  if(!session||session.taskId!==action.taskId||!this.alive(session))throw new Error('The target native terminal is no longer open.');
  const {binding}=session,text=action.text;
  if(typeof text!=='string'||!text.trim()||text.length>60000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)||!directId(action.requestKey))throw new Error('The native follow-up request is invalid.');
  if(binding.hasDraft||binding.approval)throw new Error(binding.approval||'This terminal has a draft. Finish it in the terminal before sending another request.');
  const revision=session.revision;
  const cancelled=(reason:string,hasDraft=true)=>this.enqueue({taskId:action.taskId,instance:action.instance,actionId:action.id,type:'input-cancelled',reason,hasDraft});
  const authorization={taskId:action.taskId,instance:action.instance,actionId:action.id,requestKey:action.requestKey};
  const firstCheck=await this.options.request('/native/submit-check',authorization) as {submit?:boolean;reason?:string};
  if(firstCheck.submit!==true||this.disposed||!this.alive(session)||session.revision!==revision||binding.hasDraft||binding.approval){cancelled(firstCheck.reason||binding.approval||'This request is no longer ready to be pasted.',binding.hasDraft);return}
  // Record the claim before any bytes. A lost acknowledgement can only resend
  // an event; this action will never paste or press Enter a second time.
  await binding.write(`\x1b[200~${text}\x1b[201~`);
  await (this.options.settle?.()??new Promise<void>(resolve=>setTimeout(resolve,750)));
  if(this.disposed||!this.alive(session)||session.revision!==revision||binding.hasDraft||binding.approval){cancelled(binding.approval||'The terminal changed while the request was pasted. Review its input before pressing Enter.');return}
  let check:{submit?:boolean;reason?:string};
  try{check=await this.options.request('/native/submit-check',authorization)}catch{cancelled('Could not confirm the terminal is ready. Review the pasted request in its input.');return}
  if(check.submit!==true||this.disposed||!this.alive(session)||session.revision!==revision||binding.hasDraft||binding.approval){cancelled(check.reason||binding.approval||'The terminal needs your input. The pasted request was left for review.');return}
  await binding.write('\r');
  this.enqueue({taskId:action.taskId,instance:action.instance,actionId:action.id,type:'input-written'});
 }
 private async claim(pending:DirectAction){
  if(!directId(pending.id)||!directId(pending.taskId)||!directId(pending.instance)||!['launch','send','stop'].includes(pending.type))throw new Error('The bridge returned an invalid native action.');
  if(this.registry.claimed.has(pending.id))return;
  this.registry.claimed.add(pending.id);
  try{
   const {action}=await this.options.request('/native/claim',{id:pending.id}) as {action:DirectAction};
   if(!action||action.id!==pending.id||action.taskId!==pending.taskId||action.instance!==pending.instance||action.type!==pending.type)throw new Error('The native action changed while it was being claimed.');
   if(action.type==='launch')await this.launch(action);
   else if(action.type==='send')await this.send(action);
   else {const session=this.registry.sessions.get(action.instance);if(!session||session.taskId!==action.taskId||!session.lifetime.active)throw new Error('The native terminal is already closed.');session.lifetime.close()}
  }catch(error){const reason=message(error);this.enqueue({taskId:pending.taskId,instance:pending.instance,actionId:pending.id,type:'error',reason});this.options.notice(reason)}
 }
 async sync():Promise<void>{
  if(this.disposed)return;
  const run=this.registry.queue.catch(()=>{}).then(async()=>{
   if(this.disposed)return;
   try{this.verified()}catch(error){
    // The poll that calls sync() stays quiet on errors, so a refused Terminal
    // would otherwise leave a requested conversation silently unopened. Only a
    // waiting launch earns the notice: a member who uses Jarvis is not nagged.
    // Read-only: nothing is claimed, reported or opened.
    const waiting=await this.options.request('/native/pending').catch(()=>null);
    if(Array.isArray(waiting?.actions)&&waiting.actions.some((action:{type?:string}|null)=>action?.type==='launch'))this.noticeOnce(message(error));
    throw error;
   }
   this.adopt();await this.flush();
   const sessions=[...this.registry.sessions.values()].filter(session=>this.alive(session)).map(session=>({taskId:session.taskId,instance:session.instance,hostPid:session.binding.hostPid,hasDraft:session.binding.hasDraft,approval:session.binding.approval}));
   const presence=await this.options.request('/native/presence',{sessions});
   // The bridge's completion hooks can clear an old observed approval. A human
   // draft remains local and is never erased by a status refresh.
   for(const completed of presence?.ready||[]){const session=this.registry.sessions.get(completed.instance);if(session&&session.taskId===completed.taskId)session.binding.clearApproval()}
   const pending=await this.options.request('/native/pending');
   if(!Array.isArray(pending.actions))throw new Error('The bridge returned invalid native terminal actions.');
   for(const action of pending.actions){if(this.disposed)break;await this.claim(action);await this.flush()}
  });
  this.registry.queue=run;await run;
 }
 async open(id:string):Promise<WorkspaceLeaf|null>{
  if(!directId(id))return null;
  await this.sync();
  const session=[...this.registry.sessions.values()].find(session=>session.taskId===id&&this.alive(session));
  if(!session)return null;
  await this.layout(async()=>{await this.options.reveal?.(session.leaf)});return session.leaf;
 }
 dispose(){this.disposed=true}
}
