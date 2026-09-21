// node-pty's Windows argv encoder treats quote-enclosed user text as already
// quoted. Use its raw-command-line overload with one complete Windows encoding.
export function windowsArguments(args){
 return args.map(value=>'"'+String(value).replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')+'"').join(' ');
}

export function stopOwnedPtyTree(live,{isCurrent=()=>true,launch=spawn,platform=process.platform}={}){
 if(platform!=='win32'||!Number.isInteger(live.proc.pid)||live.proc.pid<=0||live.proc.pid===process.pid||live.exitObserved||!isCurrent())return Promise.resolve(false);
 // Only an in-memory process returned by this manager's spawn is eligible.
 // Persisted session PIDs are never accepted as an ownership claim.
 return new Promise(resolve=>{
  const killer=launch(path.join(process.env.SystemRoot||'C:\\Windows','System32/taskkill.exe'),['/PID',String(live.proc.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});
  const timeout=setTimeout(()=>{killer.kill?.();resolve(false)},5000);timeout.unref();
  const finish=value=>{clearTimeout(timeout);resolve(value)};
  killer.once('error',()=>finish(false));killer.once('close',code=>finish(code===0));
 });
}

const releasedPtys=new WeakMap();
export async function releaseStoppedWindowsPty(proc){
 // node-pty 1.1's public kill/destroy path enumerates a console even after its
 // root has exited. Its natural onExit path, conversely, leaves the conout
 // worker alive. After our tree termination or observed native exit, release
 // only these owned handles;
 // do not launch a process-list helper against a vanished console.
 const agent=proc?._agent;
 if(releasedPtys.has(proc))return releasedPtys.get(proc);
 const connection=agent?._conoutSocketWorker,worker=connection?._worker;
 if(!agent?._useConpty||typeof agent._ptyNative?.kill!=='function'||typeof worker?.terminate!=='function'||typeof worker.on!=='function'||typeof worker.off!=='function'||typeof agent.inSocket?.destroy!=='function'||typeof agent.outSocket?.destroy!=='function')return false;
 const release=Promise.resolve().then(async()=>{
  // dispose() delays worker termination for 1s. Closing its destination first
  // lets the worker's pipe write to a dead socket and raise an uncaught EPIPE.
  // Await the owned worker before closing output. A queued EPIPE during an
  // already-observed native exit is an expected shutdown error, not a crash.
  let unexpectedError;const onError=error=>{if(error?.code!=='EPIPE')unexpectedError=error};
  worker.on('error',onError);
  try{
   if(agent._closeTimeout)clearTimeout(agent._closeTimeout);
   agent._ptyNative.kill(agent.pty,agent._useConptyDll);
   connection._isDisposed=true;if(connection._drainTimeout)clearTimeout(connection._drainTimeout);
   await worker.terminate();
   if(agent._closeTimeout)clearTimeout(agent._closeTimeout);
   agent.inSocket.destroy();agent.outSocket.destroy();return !unexpectedError;
  }catch{return false}finally{worker.off('error',onError)}
 });
 releasedPtys.set(proc,release);return release;
}

export class TerminalInputBoundary {
 constructor({trackRecall=false}={}){this.trackRecall=trackRecall;this.reset()}
 reset(){this.pending='';this.pasting=false;this.hasDraft=false}
 update(data){
  const input=this.pending+data;this.pending='';let submitted=false,edited=false;
  const start='\x1b[200~',end='\x1b[201~';
  for(let i=0;i<input.length;){
   const tail=input.slice(i);
   if(tail.startsWith(start)){this.pasting=true;i+=start.length;continue}
   if(tail.startsWith(end)){this.pasting=false;i+=end.length;continue}
   if(start.startsWith(tail)||end.startsWith(tail)){this.pending=tail;break}
   if(!this.pasting&&tail.startsWith('\x1b[')){
    const sequence=/^\x1b\[[0-?]*[ -/]*[@-~]/.exec(tail);if(sequence){if(this.trackRecall&&/[AB]$/.test(sequence[0])){edited=true;this.hasDraft=true}i+=sequence[0].length;continue}
    if(tail.length<64){this.pending=tail;break}
   }
   if(!this.pasting&&tail.startsWith('\x1bO')){
    if(tail.length<3){this.pending=tail;break}
    if(this.trackRecall&&/[AB]/.test(tail[2])){edited=true;this.hasDraft=true}i+=3;continue;
   }
   if(!this.pasting&&tail.startsWith('\x1b]')){
    const end=/\x07|\x1b\\/.exec(tail);
    if(end){i+=end.index+end[0].length;continue}
    this.pending=tail.slice(-4096);break;
   }
   const character=input[i++];
   if(this.pasting){edited=true;this.hasDraft=true}
   else if(character==='\r'){submitted=true;this.hasDraft=false}
   // History/autocomplete can insert text without emitting printable input.
   // Cursor movement, Escape and focus reports cannot establish a new draft.
   else if(this.trackRecall&&/[\t\x0e\x10\x12]/.test(character)){edited=true;this.hasDraft=true}
   else if(/[\x20-\x7e\u0080-\uffff]/.test(character)){edited=true;this.hasDraft=true}
  }
  return {submitted,edited};
 }
}

// These are observed interactive screens, not approval decisions. Keep a small
// recent buffer so split ANSI sequences/words are recognized across PTY chunks.
export class TerminalPromptDetector {
 constructor(provider='codex'){this.name=provider==='claude'?'Claude Code':'Codex';this.reset()}
 reset(){this.raw=''}
 update(data){
  this.raw=(this.raw+data).slice(-12000);
  const clear=[...this.raw.matchAll(/\x1b\[(?:2J|3J)/g)].at(-1);
  if(clear)this.raw=this.raw.slice(clear.index+clear[0].length);
  const text=this.raw.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b[^\x1b]*$/g,'').replace(/\r/g,'\n').slice(-6000);
  // Ordinary plans can contain both numbered "Review/Approve" steps and a
  // sentence mentioning Enter. Require actual choices plus a selection marker,
  // or multiple choices and the complete CLI instruction (not prose after it).
  const choices=[...text.matchAll(/^\s*([›❯>]\s*)?\d+[.)]\s+(?:yes\b|no\b|allow\b|deny\b|approve\b|reject\b|trust\b|continue\b|cancel\b|review hooks\b)[^\n]*$/gim)];
  const footer=/^\s*press (?:enter|return) to confirm(?: or (?:esc|escape) to (?:go back|cancel))?\.?\s*$/im.test(text);
  const menu=choices.some(choice=>choice[1])||(choices.length>=2&&footer);
  if(!menu)return null;
  if(/(?:^|\n)\s*Hooks need review\s*(?:\n|$)/i.test(text)&&/review hooks|trust all and continue/i.test(text))return `${this.name} needs you to review its hooks. Open the terminal and choose how to proceed.`;
  if(/(?:do you trust (?:the (?:contents|files|authors)|this)|trust this (?:folder|directory|workspace)|working in this directory)/i.test(text)&&/trust|yes, continue/i.test(text))return `${this.name} is asking whether you trust this workspace. Review the terminal prompt.`;
  const actionPrompt=/^\s*(?:would you like to (?:make the following edits|grant these permissions|send input to terminal \d+)|approve app tool call)\?\s*$/im.test(text);
  if(actionPrompt||/(?:would you like to (?:run|allow)|approve (?:this|the)|requires? (?:your )?approval|do you want to (?:run|proceed|allow))/i.test(text))return `${this.name} is waiting for your approval. Review the requested action in its terminal.`;
  return null;
 }
}
import {spawn} from 'node:child_process';
import path from 'node:path';
