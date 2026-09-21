import fs from 'node:fs';
import path from 'node:path';

export const LIFECYCLE_MAX_BYTES=1024*1024;
const fieldNames=['service','version','reason','code','signal','status','port','exitCode','provider','command'];
function fields(input){
 const out={};
 for(const key of fieldNames){const value=input?.[key];if(typeof value==='string')out[key]=value.slice(0,key==='command'?600:160);else if(typeof value==='number'&&Number.isFinite(value))out[key]=value;else if(typeof value==='boolean')out[key]=value}
 return out;
}
function providerDetails(input){
 const out={};
 for(const provider of ['codex','claude'])if(input?.[provider])out[provider]=fields(input[provider]);
 return out;
}
function lastRecord(file){
 let descriptor;
 try{
  descriptor=fs.openSync(file,'r');const size=fs.fstatSync(descriptor).size,length=Math.min(size,65536),buffer=Buffer.alloc(length);
  fs.readSync(descriptor,buffer,0,length,size-length);
  const lines=buffer.toString('utf8').trim().split('\n');
  for(const line of lines.reverse())try{const record=JSON.parse(line);if(typeof record.event==='string')return {event:record.event.slice(0,64),pid:record.pid,ts:record.ts,shutdownObserved:record.event==='shutdown'}}catch{}
 }catch{}finally{if(descriptor!==undefined)try{fs.closeSync(descriptor)}catch{}}
 return null;
}

// Bounded local operational evidence only. No exit handlers, task content,
// environment, prompts, auth material or remote telemetry are collected.
export function startLifecycle(runtimeDir,details={},options={}){
 const file=path.join(runtimeDir,'bridge-lifecycle.jsonl'),previousFile=path.join(runtimeDir,'bridge-lifecycle.previous.jsonl');
 const maxBytes=options.maxBytes??LIFECYCLE_MAX_BYTES,now=options.now??Date.now;
 const processInfo=options.processInfo??(()=>({pid:process.pid,uptimeSeconds:Math.round(process.uptime()),rssMiB:Math.round(process.memoryUsage().rss/1048576)}));
 const startTimer=options.startTimer??setInterval,stopTimer=options.stopTimer??clearInterval;
 let stopped=false,timer=null;
 const write=(event,extra={})=>{
  try{
   if(!/^[a-z][a-z0-9:_-]{0,63}$/.test(event))return;
   const info=processInfo();
   const line=JSON.stringify({ts:new Date(now()).toISOString(),event,pid:info.pid,uptimeSeconds:info.uptimeSeconds,rssMiB:info.rssMiB,...extra})+'\n';
   fs.mkdirSync(runtimeDir,{recursive:true});
   if(fs.existsSync(file)&&fs.statSync(file).size+Buffer.byteLength(line)>maxBytes){fs.rmSync(previousFile,{force:true});fs.renameSync(file,previousFile)}
   fs.appendFileSync(file,line,{encoding:'utf8'});
  }catch{} // Logging must never stop voice, terminal work, or shutdown.
 };
 let previous=null;
 try{previous=lastRecord(file)||lastRecord(previousFile)}catch{}
 try{write('boot',{...fields(details),providers:providerDetails(details.providers),previous})}catch{}
 try{timer=startTimer(()=>{if(!stopped)write('heartbeat')},30000);timer?.unref?.()}catch{}
 return {
  mark(event,extra={}){if(!stopped)try{write(event,fields(extra))}catch{}},
  stop(reason='shutdown'){
   if(stopped)return;stopped=true;try{if(timer!==null)stopTimer(timer)}catch{}
   try{write('shutdown',fields({reason}))}catch{}
  },
 };
}
