// Confirm receipt from the selected CLI's own append-only conversation log.
// This observes one pending paste only; it does not resend input or run a model.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {StringDecoder} from 'node:string_decoder';
import {codexTranscript} from './artifact-transcript.mjs';

const MAX_READ=256*1024,MAX_LINE=256*1024;
const normalize=text=>String(text||'').replace(/\r\n?/g,'\n').trim();
function userText(row){
 const p=row?.payload;
 if(row?.type==='event_msg'&&p?.type==='user_message'&&typeof p.message==='string')return p.message;
 if(row?.type==='response_item'&&p?.type==='message'&&p.role==='user'&&Array.isArray(p.content)){
  return p.content.filter(c=>c?.type==='input_text'||c?.type==='text').map(c=>c.text||'').join('\n');
 }
 return null;
}
export function createCodexDeliveryWatch(sessionId,text,{home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex')}={}){
 let file,identity,offset=0,buffer='',dropping=false,closed=false,confirmed=false;
 const decoder=new StringDecoder('utf8'),expected=normalize(text);
 try{
  if(!/^[a-f0-9-]{36}$/.test(sessionId||'')||!expected)throw Error('Invalid delivery identity');
  file=codexTranscript(sessionId,home);if(!file)throw Error('No existing conversation log');
  identity=fs.statSync(file);if(!identity.isFile())throw Error('No conversation file');offset=identity.size;
  // Ignore a pre-existing partial record rather than matching its continuation.
  if(offset){const fd=fs.openSync(file,'r');try{const last=Buffer.alloc(1);fs.readSync(fd,last,0,1,offset-1);dropping=last[0]!==10;}finally{fs.closeSync(fd)}}
 }catch{closed=true;}
 return {
  poll(){
   if(confirmed)return true;if(closed)return false;
   let fd;
   try{
    if(fs.lstatSync(file).isSymbolicLink()){closed=true;return false;}
    const named=fs.statSync(file);
    if(named.ino!==identity.ino||named.dev!==identity.dev||named.size<offset){closed=true;return false;}
    if(named.size===offset)return false;
    fd=fs.openSync(file,'r');const stat=fs.fstatSync(fd);
    if(stat.ino!==identity.ino||stat.dev!==identity.dev||stat.size<offset){closed=true;return false;}
    const bytes=Buffer.alloc(Math.min(MAX_READ,stat.size-offset));
    const count=fs.readSync(fd,bytes,0,bytes.length,offset);offset+=count;
    const content=decoder.write(bytes.subarray(0,count));
    for(const piece of content.match(/[^\n]*\n|[^\n]+$/g)||[]){
     const ended=piece.endsWith('\n');
     if(dropping){if(ended)dropping=false;continue;}
     if(buffer.length+piece.length>MAX_LINE){buffer='';dropping=!ended;continue;}
     buffer+=piece;
     if(!ended)continue;
     let row;try{row=JSON.parse(buffer)}catch{}buffer='';
     const value=userText(row);
     if(value!==null&&normalize(value)===expected){confirmed=true;closed=true;return true;}
    }
   }catch{closed=true;}
   finally{if(fd!==undefined)fs.closeSync(fd);}
   return false;
  },
  close(){closed=true;buffer='';decoder.end();},
 };
}
