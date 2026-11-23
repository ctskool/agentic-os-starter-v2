import fs from 'node:fs';
import {vaultPath} from '../core.mjs';
import {clip} from './clip.mjs';

export const ABOUT_MAX_BYTES=2000;
const FILE_MAX_BYTES=256*1024;
const frontMatter=/(?<![\s\S])\uFEFF?---[\t ]*\r?\n[\s\S]*?^(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/m;
const comments=/<!--[\s\S]*?-->/g;
export const aboutHeading=/^## About me[\t ]*(?:\r?\n|$)/im;
export const agentsImport=text=>text.replace(comments,'').trim()==='@AGENTS.md';
const mask=text=>text.replace(/[^\r\n]/g,' ');
export const visibleMarkdown=text=>text.replace(frontMatter,mask).replace(comments,mask);
export const frontMatterEnd=text=>frontMatter.exec(text)?.[0].length??0;

export function aboutSection(raw){
 // Keep source offsets so the writer can preserve the untouched bytes.
 const visible=visibleMarkdown(raw);
 const heading=Array.from(visible.matchAll(new RegExp(aboutHeading,'gim'))).find(match=>aboutHeading.test(raw.slice(match.index,match.index+match[0].length)));
 if(!heading)return null;
 const start=heading.index,bodyStart=start+heading[0].length;
 const boundary=/^## /m.exec(visible.slice(bodyStart).replace(frontMatter,mask));
 return {start,bodyStart,end:boundary?bodyStart+boundary.index:raw.length};
}

function readFile(root,source){
 let fd;
 try{
  const file=vaultPath(root,source),info=fs.lstatSync(file);
  if(!info.isFile()||info.size>FILE_MAX_BYTES)return null;
  fd=fs.openSync(file,'r');
  const size=fs.fstatSync(fd).size;
  if(size>FILE_MAX_BYTES)return null;
  const data=Buffer.alloc(size+1);
  const read=fs.readSync(fd,data,0,data.length,null);
  return read>size?null:data.toString('utf8',0,read).replace(/^\uFEFF/,'');
 }catch{return null}
 finally{if(fd!==undefined)try{fs.closeSync(fd)}catch{}}
}

export function readAboutMe(root){
 for(const source of ['AGENTS.md','CLAUDE.md']){
  const raw=readFile(root,source);
  // An import points back to the file we have already checked.
  if(!raw||(source==='CLAUDE.md'&&agentsImport(raw)))continue;
  const section=aboutSection(raw);
  if(!section)continue;
  const clean=raw.slice(section.bodyStart,section.end).replace(frontMatter,'')
   .replace(comments,'').replace(/\[\[([^\]|\r\n]+)(?:\|([^\]\r\n]+))?\]\]/g,(_match,target,label)=>label??target)
   .replace(/\r\n/g,'\n').replace(/[\t ]+$/gm,'').replace(/\n{3,}/g,'\n\n').trim();
  const total=Buffer.byteLength(clean);
  let text=clean;
  if(total>ABOUT_MAX_BYTES){
   const lines=clean.split('\n'),kept=[];
   let bytes=0;
   for(const line of lines){
    bytes+=Buffer.byteLength(line)+Number(kept.length>0);
    if(bytes>ABOUT_MAX_BYTES)break;
    kept.push(line);
   }
   text=kept.length?kept.join('\n').trimEnd():clip(lines[0],ABOUT_MAX_BYTES);
  }
  const bytes=Buffer.byteLength(text);
  return {text,source,bytes,dropped:total-bytes};
 }
 return null;
}
