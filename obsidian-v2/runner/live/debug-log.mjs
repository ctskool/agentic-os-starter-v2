import fs from 'node:fs';
import path from 'node:path';

// An opt-in record of what was said on a Live call, for testing and debugging (2026-11-26: nothing else keeps Live's
// own words, so a call could not be checked afterwards). It writes only while `.runtime/live-transcripts/ON` exists,
// stays on this computer, and holds the call's words: delete the folder to remove it. One JSON line per event.
export function liveDebugLog(runtimeDir){
 if(!runtimeDir)return ()=>{};
 const dir=path.join(runtimeDir,'live-transcripts');
 return (call,record)=>{
  try{
   if(!fs.existsSync(path.join(dir,'ON')))return;
   const name=String(call?.callId||'call').replace(/[^a-z0-9-]/gi,'').slice(0,8)||'call';
   fs.appendFileSync(path.join(dir,`${name}.jsonl`),JSON.stringify({ts:new Date().toISOString(),session:call?.sessionId?String(call.sessionId).slice(-6):null,...record})+'\n');
  }catch{}
 };
}
const KEEP=new Set(['session.started','session.paused','session.resumed','session.delegation.created','session.commentary.appended','session.closed','error']);
// The useful part of a sideband event: what was heard or said, and the moments that matter.
export function debugRecord(event){
 if(event.type==='session.input_transcript.delta'){
  const turn=event.turn_id??event.item_id,offset=event.offset_ms??event.end_offset_ms;
  return {heard:String(event.delta??''),...(turn?{turn:String(turn).slice(-8)}:{}),...(Number.isFinite(offset)?{offset}:{})};
 }
 if(event.type==='session.output_transcript.delta'||event.type==='session.assistant_transcript.delta')return {said:String(event.delta??'')};
 if(!KEEP.has(event.type))return null;
 return {event:event.type,...(event.delegation?.id?{delegation:event.delegation.id}:{}),...(event.error?{error:String(event.error.message||event.error.code||'').slice(0,300)}:{})};
}
