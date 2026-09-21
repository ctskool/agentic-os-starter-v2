import path from 'node:path';
import {spawn} from 'node:child_process';

// Called only with a ChildProcess created by this bridge. POSIX workers have
// their own process group; Windows taskkill follows this owned process's tree.
export function stopCliProcessTree(child,{platform=process.platform,launch=spawn,killGroup=process.kill}={}){
 if(!Number.isInteger(child.pid)||child.pid<=0||child.exitCode!==null||child.signalCode!==null)return;
 const fallback=()=>{if(child.exitCode===null&&child.signalCode===null)try{child.kill('SIGKILL')}catch{/* The caller retains ownership until exit is confirmed. */}};
 if(platform!=='win32'){try{killGroup(-child.pid,'SIGKILL')}catch{fallback()}return}
 try{
  const killer=launch(path.join(process.env.SystemRoot||'C:\\Windows','System32/taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});
  killer.once('error',fallback);killer.once('close',code=>{if(code)fallback()});
 }catch{fallback()}
}
