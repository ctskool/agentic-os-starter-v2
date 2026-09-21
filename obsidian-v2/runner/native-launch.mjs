// Give the native Terminal plugin one safely quoted filename. Its own TTY is
// inherited directly by the CLI; this launcher never reads or relays its output.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const absolute=value=>typeof value==='string'&&path.isAbsolute(value)&&!/[\x00-\x1f\x7f]/.test(value);
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
export function connectNativeOwner(endpoint,{onClose=()=>{},platform=process.platform,timeoutMs=3000}={}){
 const prefix='\\\\.\\pipe\\aos-v2-terminal-';
 const name=typeof endpoint==='string'?path.posix.basename(endpoint):'';
 const valid=platform==='win32'?typeof endpoint==='string'&&endpoint.startsWith(prefix)&&uuid(endpoint.slice(prefix.length)):
  typeof endpoint==='string'&&path.posix.isAbsolute(endpoint)&&path.posix.normalize(endpoint)===endpoint&&Buffer.byteLength(endpoint)<=100&&name.startsWith('aos-v2-terminal-')&&name.endsWith('.sock')&&uuid(name.slice(16,-5))&&[path.posix.normalize(os.tmpdir()),'/tmp'].includes(path.posix.dirname(endpoint));
 if(!valid)throw new Error('The native terminal lifetime socket is invalid.');
 return new Promise((resolve,reject)=>{
  const socket=net.createConnection({path:endpoint});let ready=false,closed=false,received='';
  const close=()=>{if(closed)return;closed=true;clearTimeout(timer);socket.removeAllListeners();socket.on('error',()=>{});socket.destroy()};
  const failed=()=>{if(closed)return;const owned=ready;close();if(owned)onClose();else reject(new Error('The native terminal closed before its launch was confirmed.'))};
  const timer=setTimeout(failed,Math.max(50,Math.min(10000,timeoutMs)));
  socket.on('error',failed);socket.on('end',failed);socket.on('close',failed);
  socket.on('data',data=>{
   if(closed)return;if(ready||received.length+data.length>6){failed();return}received+=data.toString('utf8');
   if(!'READY\n'.startsWith(received)){failed();return}
   if(received==='READY\n'){ready=true;clearTimeout(timer);resolve({close})}
  });
 });
}
export function readNativeTicket(file){
 if(!absolute(file))throw new Error('An absolute native launch ticket is required.');
 const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>512*1024)throw new Error('The native launch ticket is invalid.');
 const ticket=JSON.parse(fs.readFileSync(file,'utf8'));
 if(!record(ticket)||ticket.version!==1||!uuid(ticket.taskId)||!uuid(ticket.instance)||![ticket.cwd,ticket.command,ticket.events].every(absolute)||!Array.isArray(ticket.args)||ticket.args.length>100||ticket.args.some(arg=>typeof arg!=='string'||arg.includes('\0'))||!record(ticket.env)||Object.entries(ticket.env).some(([key,value])=>!/^\w+$/.test(key)||typeof value!=='string'||value.includes('\0')))throw new Error('The native launch ticket has an invalid command or identity.');
 if(ticket.claimFile!==undefined&&ticket.claimFile!==file+'.claimed')throw new Error('The native launch ticket has an invalid claim path.');
 if(!fs.statSync(ticket.cwd).isDirectory()||!fs.statSync(ticket.command).isFile()||!fs.statSync(ticket.events).isDirectory()||fs.lstatSync(ticket.events).isSymbolicLink())throw new Error('The native CLI or event folder is unavailable.');
 return ticket;
}
function publish(ticket,type,details={}){
 const name=crypto.randomUUID(),file=path.join(ticket.events,name+'.json');
 fs.writeFileSync(file+'.tmp',JSON.stringify({type,taskId:ticket.taskId,nativeInstance:ticket.instance,ts:Date.now(),...details}),{flag:'wx'});
 fs.renameSync(file+'.tmp',file);
}
function claim(file,ticket){
 let fd;try{fd=fs.openSync(file+'.claimed','wx');fs.writeFileSync(fd,JSON.stringify({taskId:ticket.taskId,instance:ticket.instance,launcherPid:process.pid,ts:Date.now()}));fs.fsyncSync(fd)}
 catch(error){if(error.code==='EEXIST')throw new Error('This native launch was already used. Resume the saved conversation explicitly; it was not started twice.');throw error}
 finally{if(fd!==undefined)fs.closeSync(fd)}
}
export async function runNativeLaunch(file,{spawnImpl=spawn,signals=process,env=process.env,platform=process.platform,stderr=process.stderr,stopGraceMs=4000,ownerTimeoutMs=3000}={}){
 const ticket=readNativeTicket(file),endpoint=env.AOS_V2_TERMINAL_LIFETIME||ticket.env.AOS_V2_TERMINAL_LIFETIME;
 let owner=null,ownerClosed=false,stopOwned=null;
 if(endpoint)owner=await connectNativeOwner(endpoint,{platform,timeoutMs:ownerTimeoutMs,onClose:()=>{ownerClosed=true;stopOwned?.()}});
 try{if(ownerClosed)throw new Error('The native terminal closed before launch.');claim(file,ticket)}catch(error){owner?.close();throw error}
 const childEnv={...env,...ticket.env,AOS_WORK_EVENTS:ticket.events,AOS_NATIVE_INSTANCE:ticket.instance,AOS_NATIVE_TASK_ID:ticket.taskId};delete childEnv.CLAUDECODE;
 let child;
 try{child=spawnImpl(ticket.command,ticket.args,{cwd:ticket.cwd,env:childEnv,shell:false,stdio:'inherit',windowsHide:true})}
 catch(error){owner?.close();publish(ticket,'native-exit',{code:1,error:'The native CLI could not start.'});throw error}
 return new Promise(resolve=>{
  let finished=false,stopping=false,killTimer=null,killer=null;
  const report=(type,details)=>{try{publish(ticket,type,details)}catch{stderr.write('The native CLI status could not be saved. Check the terminal before retrying.\n')}};
  const ignoreInterrupt=()=>{}; // The foreground console group already receives Ctrl+C.
  const stop=()=>{
   if(stopping||finished)return;stopping=true;
   if(platform==='win32'&&Number.isSafeInteger(child.pid)&&child.pid>0){
    // Only the process just created above is eligible, never a saved/report PID.
    try{const program=path.join(env.SystemRoot||'C:\\Windows','System32','taskkill.exe');killer=spawnImpl(program,['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});killer.on('error',()=>{try{child.kill('SIGTERM')}catch{}})}catch{try{child.kill('SIGTERM')}catch{}}
   }else try{child.kill('SIGTERM')}catch{}
   killTimer=setTimeout(()=>{if(finished)return;try{killer?.kill()}catch{}try{child.kill('SIGKILL')}catch{}},stopGraceMs);killTimer.unref?.();
  };
  const finish=(code,signal,error)=>{
   if(finished)return;finished=true;clearTimeout(killTimer);owner?.close();signals.off('SIGINT',ignoreInterrupt);signals.off('SIGTERM',stop);signals.off('SIGHUP',stop);
   report('native-exit',{code:Number.isInteger(code)?code:null,signal:signal||null,...(error?{error:'The native CLI could not start.'}:{})});
   if(error)stderr.write('The native CLI could not start. Check its configured executable.\n');
   resolve(Number.isInteger(code)?code:signal==='SIGINT'?130:signal==='SIGTERM'?143:1);
  };
  signals.on('SIGINT',ignoreInterrupt);signals.on('SIGTERM',stop);signals.on('SIGHUP',stop);
  child.once('spawn',()=>{if(!finished)report('native-start',{pid:child.pid})});
  child.once('error',error=>finish(1,null,error));child.once('exit',(code,signal)=>finish(code,signal));
  stopOwned=stop;if(ownerClosed)stop();
 });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==4||process.argv[2]!=='--ticket')throw new Error('Usage: native-launch.mjs --ticket <absolute ticket path>');process.exitCode=await runNativeLaunch(process.argv[3])}
 catch(error){process.stderr.write(String(error.message||'Native CLI launch failed.')+'\n');process.exitCode=1}
}
