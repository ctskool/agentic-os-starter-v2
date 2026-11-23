import fs from 'node:fs';
import path from 'node:path';

// One line per Live call event (start, end and why), so "why did my call end?" has an answer.
// Reasons and timings only: never transcript text, keys or secrets.
const MAX_BYTES=256000,KEEP_LINES=400;
export function liveCallLog(runtimeDir){
 const file=path.join(runtimeDir,'live-calls.jsonl');
 return entry=>{
  try{
   fs.appendFileSync(file,JSON.stringify({ts:new Date().toISOString(),...entry})+'\n');
   if(fs.statSync(file).size>MAX_BYTES){
    const lines=fs.readFileSync(file,'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(file,lines.slice(-KEEP_LINES).join('\n')+'\n');
   }
  }catch{}
 };
}
// The client says why it hung up; anything else is reduced to a short plain label.
export function clientStopReason(value){
 const text=typeof value==='string'?value.replace(/[^\w .,:'’()/-]/g,'').trim().slice(0,120):'';
 return text||'hung up';
}
