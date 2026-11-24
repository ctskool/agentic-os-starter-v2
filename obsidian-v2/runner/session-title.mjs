// The short name Claude Code gives a conversation.
//
// A task started by voice is named after the first words that were said ("Yeah, can you do some research on…").
// Claude Code writes its own short title for every session a second or two after the first request
// ("Riemann hypothesis one-pager"), as `ai-title` rows in the session file. That title is read here and becomes the
// task's name, so the tab, the card beside the core and a spoken status all say what the task is. Nothing is asked of
// any model: the title is already on disk. Codex writes no such row, so a Codex task keeps the words it was asked in.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';

const MAX_READ=4*1024*1024,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const claudeProjects=(env=process.env)=>path.join(env.CLAUDE_CONFIG_DIR?path.resolve(env.CLAUDE_CONFIG_DIR):path.join(os.homedir(),'.claude'),'projects');
// Claude Code keeps a folder's sessions under the folder's path with every character that is not a letter or a
// digit replaced by a dash. A folder it names differently is simply not found, and the task keeps its first name.
export const claudeProjectFolder=(projects,cwd)=>path.join(projects,String(cwd).replace(/[^a-zA-Z0-9]/g,'-'));

export function cleanSessionTitle(value){
 if(typeof value!=='string')return null;
 const title=value.replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().replace(/^["'“‘]+|["'”’]+$/g,'').trim();
 return title.length>=3&&title.length<=80&&/[\p{L}\p{N}]/u.test(title)?title:null;
}

// The latest title in the session file, or null. Reads at most the last few megabytes: the row is written again
// throughout a session, so the newest one is near the end.
export function claudeSessionTitle(sessionId,cwd,{projects=claudeProjects()}={}){
 if(!UUID.test(String(sessionId||''))||!cwd)return null;
 let fd;
 try{
  const file=path.join(claudeProjectFolder(projects,cwd),sessionId+'.jsonl');
  fd=fs.openSync(file,'r');const stat=fs.fstatSync(fd);if(!stat.isFile())return null;
  const start=Math.max(0,stat.size-MAX_READ),buffer=Buffer.alloc(stat.size-start);fs.readSync(fd,buffer,0,buffer.length,start);
  const lines=buffer.toString('utf8').split('\n');if(start)lines.shift();
  for(let index=lines.length-1;index>=0;index--){
   const line=lines[index];if(line.length>4000||!line.includes('"ai-title"'))continue;
   let row;try{row=JSON.parse(line)}catch{continue}
   if(row?.type==='ai-title'&&row.sessionId===sessionId){const title=cleanSessionTitle(row.aiTitle);if(title)return title}
  }
 }catch{}finally{if(fd!==undefined)try{fs.closeSync(fd)}catch{}}
 return null;
}
