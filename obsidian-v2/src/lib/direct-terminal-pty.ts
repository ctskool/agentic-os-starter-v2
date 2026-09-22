import {TerminalInputBoundary,TerminalPromptDetector} from '../../runner/terminal-transport.mjs';

/** Internal surface verified against the Terminal versions in
 * shared/terminal-support.mjs. Its ChildProcess owns the conhost/Python
 * terminal host; hostPid is deliberately not called a CLI PID. */
/** Terminal opened, but its emulator or process is not reachable the way this
 * integration expects. The CLI may be running in that tab. */
export class TerminalAccessError extends Error {
 static readonly NAME='TerminalAccessError';
 constructor(message:string){super(message);this.name=TerminalAccessError.NAME}
}
interface Disposable {dispose():void}
interface Stream {on(event:'data',listener:(data:Uint8Array|string)=>void):unknown;removeListener(event:'data',listener:(data:Uint8Array|string)=>void):unknown}
interface NativeProcess {
 pid?:number;exitCode:number|null;signalCode?:string|null;
 stdin:{destroyed?:boolean;writableEnded?:boolean;write(data:string,callback:(error?:Error|null)=>void):unknown};
 stdout:Stream;stderr:Stream;
}
interface NativePty {shell:Promise<NativeProcess>;onExit:Promise<number|string>;kill():Promise<void>}
interface Emulator {pseudoterminal:Promise<NativePty>;terminal:{onData(listener:(data:string)=>void):Disposable}}
export interface DirectTerminalView {emulator?:Emulator|null;register(cleanup:()=>unknown):void}
export interface DirectTerminalCallbacks {
 ready?(state:{hostPid:number|null}):void;
 input?(state:{submitted:boolean;edited:boolean;hasDraft:boolean}):void;
 approval?(reason:string):void;
 exit?(code:number|string):void;
 closed?(reason:'closed'|'replaced'|'disposed'):void;
 error?(message:string):void;
}
export interface DirectTerminalBinding {
 readonly ready:Promise<void>;
 readonly active:boolean;
 readonly hostPid:number|null;
 readonly hasDraft:boolean;
 readonly approval:string|null;
 write(data:string):Promise<void>;
 /** A completion hook may clear approval, but must not erase a human draft. */
 clearApproval():void;
 /** Unsubscribes only. The Terminal view continues owning its process. */
 dispose():void;
}
const terminalReport=(data:string)=>/^(?:\x1b\[(?:\??\d+;\d+R|[?>]?\d+(?:;\d+)*c|[IO]|<\d+;\d+;\d+[Mm]|\d+;\d+;\d+M|M[\x20-\xff]{3})|\x1b\](?:10|11|12);rgb:[\da-f]{1,4}\/[\da-f]{1,4}\/[\da-f]{1,4}(?:\x07|\x1b\\))+$/i.test(data);
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
export const DIRECT_TERMINAL_LAUNCH_TIMEOUT_MS=27000;

/** Reads input/output alongside Terminal's own subscriptions. It never replaces
 * xterm.write, PTY.pipe, stream methods, or the Terminal view's lifecycle. */
export function bindDirectTerminal(view:DirectTerminalView,callbacks:DirectTerminalCallbacks={},options:{timeoutMs?:number;pollMs?:number;provider?:'codex'|'claude'}={}):DirectTerminalBinding {
 const boundary=new TerminalInputBoundary({trackRecall:true}),detector=new TerminalPromptDetector(options.provider);
 let active=true,emulator:Emulator|undefined,pty:NativePty|undefined,child:NativeProcess|undefined,input:Disposable|undefined;
 let hostPid:number|null=null,approval:string|null=null,timer:ReturnType<typeof setTimeout>|undefined;
 let readyResolve:()=>void,readyReject:(error:Error)=>void,settled=false;
 const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject});
 // Opening a view starts observation immediately; callers can await the same
 // promise without an unobserved rejection if a tab closes during opening.
 void ready.catch(()=>{});
 const streamListeners:Array<{stream:Stream;listener:(data:Uint8Array|string)=>void}>=[];
 function notify<T extends keyof DirectTerminalCallbacks>(name:T,...args:Parameters<NonNullable<DirectTerminalCallbacks[T]>>){
  try{(callbacks[name] as ((...values:unknown[])=>void)|undefined)?.(...args)}catch{}
 }
 function finish(reason:'closed'|'replaced'|'disposed',error?:Error){
  if(!active)return;active=false;
  if(timer!==undefined)clearTimeout(timer);timer=undefined;
  input?.dispose();input=undefined;
  for(const {stream,listener} of streamListeners)stream.removeListener('data',listener);
  streamListeners.length=0;
  if(!settled){settled=true;readyReject(error||new Error('The terminal closed before its process was ready.'))}
  notify('closed',reason);
 }
 function assertCurrent(){
  if(!active||!emulator||view.emulator!==emulator||!child||child.exitCode!==null||child.signalCode||child.stdin.destroyed||child.stdin.writableEnded)throw new Error('The terminal session changed or exited. Open its current tab before sending input.');
 }
 function observe(stream:Stream){
  const decoder=new TextDecoder();
  const listener=(data:Uint8Array|string)=>{
   if(!active||view.emulator!==emulator)return;
   const reason=detector.update(typeof data==='string'?data:decoder.decode(data,{stream:true}));
   if(reason&&reason!==approval){approval=reason;notify('approval',reason)}
  };
  stream.on('data',listener);streamListeners.push({stream,listener});
 }
 async function attach(candidate:Emulator){
  emulator=candidate;
  if(typeof candidate.terminal?.onData!=='function'||typeof candidate.pseudoterminal?.then!=='function')throw new TerminalAccessError('This Terminal version does not expose the process access Agentic OS needs.');
  // Attach the human-input observer before awaiting the process so a draft
  // typed while the terminal starts cannot be mistaken for an empty composer.
  input=candidate.terminal.onData(data=>{
   if(!active||view.emulator!==candidate||terminalReport(data))return;
   const changed=boundary.update(data);
   if(changed.edited||changed.submitted)notify('input',{submitted:!!changed.submitted,edited:!!changed.edited,hasDraft:!!boundary.hasDraft});
  });
  pty=await candidate.pseudoterminal;
  if(!active)return;
  if(view.emulator!==candidate){finish('replaced');return}
  if(typeof pty?.kill!=='function'||typeof pty.onExit?.then!=='function'||typeof pty.shell?.then!=='function')throw new TerminalAccessError('This Terminal version does not expose the process access Agentic OS needs.');
  void pty.onExit.then(code=>{if(active&&view.emulator===candidate){notify('exit',code);finish('closed')}},error=>{if(active){notify('error',message(error));finish('disposed',new Error(message(error)))}});
  const process=await pty.shell;
  if(!active)return;
  if(view.emulator!==candidate){finish('replaced');return}
  if(!process?.stdin||typeof process.stdin.write!=='function'||!process.stdout||typeof process.stdout.on!=='function'||typeof process.stdout.removeListener!=='function'||!process.stderr||typeof process.stderr.on!=='function'||typeof process.stderr.removeListener!=='function')throw new TerminalAccessError('This Terminal version does not expose the process streams Agentic OS needs.');
  child=process;assertCurrent();
  hostPid=Number.isInteger(process.pid)&&process.pid!>0?process.pid!:null;
  observe(process.stdout);observe(process.stderr);
  settled=true;readyResolve();notify('ready',{hostPid});
 }
 // A cold first launch of the day needed 21.6 s until the launcher was running (2026-09-21), and the bridge itself
 // allows 30 s for an unconfirmed launch, counted from before this binding exists. Giving up at 15 s raised a false
 // alarm and left a working terminal without a watcher. Which phase is slow on a cold start is not known, so one
 // limit covers both, and the message says which phase it ended in.
 const started=Date.now(),pollMs=options.pollMs??100,timeoutMs=options.timeoutMs??DIRECT_TERMINAL_LAUNCH_TIMEOUT_MS;
 function poll(){
  timer=undefined;if(!active)return;
  if(emulator&&view.emulator!==emulator){finish('replaced');return}
  if(!emulator&&view.emulator){void attach(view.emulator).catch(error=>{if(active){notify('error',message(error));finish('disposed',error instanceof Error?error:new Error(message(error)))}})}
  // Either way the tab exists and its CLI may have started: an unknown Terminal can
  // simply hide its emulator. Only a closed or replaced view is a plain Error.
  if(!settled&&Date.now()-started>=timeoutMs){const error=new TerminalAccessError(emulator?'Terminal did not expose its process before the launch timeout.':'Terminal did not open before the launch timeout.');notify('error',error.message);finish('disposed',error);return}
  timer=setTimeout(poll,pollMs);timer.unref?.();
 }
 view.register(()=>finish('closed'));poll();
 return {ready,get active(){return active},get hostPid(){return hostPid},get hasDraft(){return !!boundary.hasDraft},get approval(){return approval},
  async write(data:string){
   await ready;assertCurrent();
   if(typeof data!=='string'||!data.length)throw new Error('Terminal input must be nonempty text.');
   await new Promise<void>((resolve,reject)=>{
    try{child!.stdin.write(data,error=>error?reject(error):resolve())}catch(error){reject(error)}
   });
  },
  clearApproval(){approval=null;detector.reset()},
  dispose(){finish('disposed')},
 };
}
