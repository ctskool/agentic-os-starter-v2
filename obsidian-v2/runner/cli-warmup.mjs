import {spawn} from 'node:child_process';
import {findCli} from './cli-runtime.mjs';

// After hours of idle the first launch of codex.exe is slow on Windows (cold file cache, antivirus scan): it blocks
// whoever spawns it for 250-300 ms, against 12-16 ms warm. That cost used to land on the bridge's event loop when the
// voice classifier is launched, and on a worker terminal when it starts. A detached node helper (node is always hot:
// starting it blocks the bridge for a few milliseconds) takes it instead, when speech capture begins.
//
// The helper's source is fixed. The CLI command and its prefix arguments are passed as ONE argument of data and are
// never interpolated into the source. It runs `<cli> --version` (which opens no Codex state), kills its child and
// exits at a cleanup deadline (allow scheduling overhead on top), so nothing outlives the bridge by much more than that. It is not a classifier, owns nothing
// the bridge owns, and is never awaited.
export const WARM_WINDOW_MS=10*60*1000,WARM_HELPER_LIMIT_MS=10000;
export const helperSource=(limitMs=WARM_HELPER_LIMIT_MS)=>`const {spawn}=require('node:child_process');let spec;try{spec=JSON.parse(process.argv[1])}catch{process.exit(0)}
if(!Array.isArray(spec)||typeof spec[0]!=='string')process.exit(0);
let child;try{child=spawn(spec[0],[...spec.slice(1).map(String),'--version'],{stdio:'ignore',windowsHide:true,shell:false});child.on('error',()=>process.exit(0));child.on('close',()=>process.exit(0))}catch{process.exit(0)}
setTimeout(()=>{try{child.kill()}catch{}process.exit(0)},${Number(limitMs)||WARM_HELPER_LIMIT_MS});`;

let last=-Infinity;
export function warmCli({provider='codex',now=performance.now(),env=process.env,launch=spawn,find=findCli,limitMs=WARM_HELPER_LIMIT_MS}={}){
 if(env.NODE_TEST_CONTEXT&&env===process.env)return false;
 // A failure counts as an attempt: a broken CLI is not retried on every wake.
 if(now-last<WARM_WINDOW_MS)return false;last=now;
 try{
  const cli=find(provider);
  // Only a direct native executable is warmed. A wrapper resolution (node + codex.js) starts a grandchild that the
  // helper would not own, so it is skipped rather than half cleaned up.
  if(!cli?.command||cli.prefix?.length)return false;
  const child=launch(process.execPath,['-e',helperSource(limitMs),JSON.stringify([cli.command])],{detached:true,stdio:'ignore',windowsHide:true,shell:false});
  child.on?.('error',()=>{});child.unref?.();return true;
 }catch{return false}
}
// Only a real capture start warms: the speech socket also carries transcripts, timeouts and errors.
export const warmOnWake=(message,options)=>message?.type==='wake'?warmCli(options):false;
export const resetCliWarmup=()=>{last=-Infinity};
