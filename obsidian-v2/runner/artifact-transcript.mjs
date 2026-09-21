// Bounded, exact-conversation completion inspection. Image tool results can have
// a real file path even when the provider's final answer contains no file link.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {linkedArtifacts} from './artifacts.mjs';

const MAX_TRANSCRIPT_BYTES=32*1024*1024;
const sessionPattern=/^[a-f0-9-]{36}$/;
const inside=(root,file)=>{const relative=path.relative(root,file);return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);};
function safeFile(root,file){
 const base=fs.realpathSync(root),absolute=path.resolve(file);
 if(!inside(base,absolute))throw new Error('Transcript is outside its provider folder.');
 for(let cursor=absolute;cursor!==base;cursor=path.dirname(cursor))if(fs.lstatSync(cursor).isSymbolicLink())throw new Error('Linked transcripts are not allowed.');
 if(!inside(base,fs.realpathSync(absolute)))throw new Error('Transcript is outside its provider folder.');
 return absolute;
}
function rows(file){
 const descriptor=fs.openSync(file,'r');
 try{
  const size=fs.fstatSync(descriptor).size,offset=Math.max(0,size-MAX_TRANSCRIPT_BYTES),buffer=Buffer.alloc(Math.min(size,MAX_TRANSCRIPT_BYTES));
  fs.readSync(descriptor,buffer,0,buffer.length,offset);
  const lines=buffer.toString('utf8').split('\n');if(offset)lines.shift();
  return lines.map(line=>{try{return JSON.parse(line)}catch{return null}}).filter(Boolean);
 }finally{fs.closeSync(descriptor);}
}
function strings(content,depth=0){
 if(depth>5)return [];
 if(typeof content==='string'){
  // Tool-output wrappers are JSON. Never traverse image data/base64 strings.
  if((content.startsWith('[')||content.startsWith('{'))&&content.length<=MAX_TRANSCRIPT_BYTES){try{return strings(JSON.parse(content),depth+1)}catch{}}
  return content.length<50000?[content]:[];
 }
 if(Array.isArray(content))return content.slice(0,100).flatMap(item=>strings(item,depth+1));
 if(!content||typeof content!=='object')return [];
 if(['input_image','image','image_url'].includes(content.type))return [];
 return [...strings(content.text,depth+1),...strings(content.content,depth+1)];
}
function candidates(text,sessionId){
 const result=linkedArtifacts(text);
 // The path must occur in actual tool output and include this exact session.
 // Validate realpath, file type, size and provenance again when registering.
 const escaped=sessionId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const expression=new RegExp(`(?:[A-Za-z]:[\\\\/]|/)(?:(?![A-Za-z]:[\\\\/])[^\\r\\n<>"\\x00])*?generated_images[\\\\/]${escaped}[\\\\/][^\\r\\n<>"\\x00]*?\\.(?:png|jpe?g|webp|gif)(?=[\\s"<>)]|$)`,'gi');
 for(const match of text.matchAll(expression))result.push({path:match[0],open:true});
 return result.slice(0,8);
}
export function codexTranscript(sessionId,home){
 // Codex session UUIDv7 embeds creation time. Look only in that UTC day and
 // adjacent timezone-boundary days, never recursively search all rollouts.
 const created=Number.parseInt(sessionId.replaceAll('-','').slice(0,12),16);
 if(!Number.isFinite(created)||created<1577836800000||created>Date.now()+86400000)return null;
 const sessions=path.join(home,'sessions');
 for(const delta of [0,-86400000,86400000]){
  const day=new Date(created+delta).toISOString().slice(0,10).replaceAll('-',path.sep),folder=path.join(sessions,day);
  if(!fs.existsSync(folder))continue;
  const entries=fs.readdirSync(folder);if(entries.length>5000)continue;
  const name=entries.find(name=>name.endsWith(`-${sessionId}.jsonl`));
  if(name)return safeFile(sessions,path.join(folder,name));
 }
 return null;
}

export function captureTranscriptArtifacts({provider,sessionId,turnId,transcriptPath,text,ts},options={}){
 if(!sessionPattern.test(sessionId||''))return [];
 try{
  const home=options.codexHome||process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
  if(provider==='codex'){
   const file=codexTranscript(sessionId,home);if(!file)return [];
   let active=false,found=false;const result=[];
   for(const row of rows(file)){
    const p=row.payload||{};
    if(row.type==='turn_context'||(row.type==='event_msg'&&p.type==='task_started')){
     if(p.turn_id){active=p.turn_id===turnId;found||=active;}continue;
    }
    if(!active||!['custom_tool_call_output','function_call_output'].includes(p.type))continue;
    if(ts&&Date.parse(row.timestamp)>ts+2000)continue;
    for(const value of strings(p.output))result.push(...candidates(value,sessionId));
   }
   return found?result.slice(-8):[];
  }
  if(provider==='claude'&&typeof transcriptPath==='string'){
   const projects=options.claudeProjects||path.join(os.homedir(),'.claude','projects');
   if(path.basename(transcriptPath)!==`${sessionId}.jsonl`)return [];
   const transcript=rows(safeFile(projects,transcriptPath));
   let result=[],matched=false;
   for(const row of transcript){
    if(row.sessionId!==sessionId)continue;
    const message=row.message||{};
    const content=message.content;
    const toolResult=Array.isArray(content)&&content.some(item=>item.type==='tool_result');
    if(row.type==='user'&&!toolResult){result=[];matched=false;continue;}
    if(row.type==='assistant'&&strings(content).join('\n').trim()===String(text||'').trim())matched=true;
    if(toolResult)for(const value of strings(content))result.push(...candidates(value,sessionId));
   }
   return matched?result.slice(-8):[];
  }
 }catch{} // Missing/oversized/truncated transcripts never block completion.
 return [];
}
