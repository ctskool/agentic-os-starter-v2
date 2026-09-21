import fs from 'node:fs';
import path from 'node:path';
import {vaultPath} from './core.mjs';
const indexes=new Map();
export function resolveVoiceNote(root,query){
 const clean=query.replaceAll('\\','/');
 if(clean.startsWith('/')||clean.split('/').some(p=>p.startsWith('.'))||/^[a-z]:/i.test(clean))return null;
 try{if(clean.endsWith('.md')&&fs.statSync(vaultPath(root,clean)).isFile())return clean}catch{}
 let index=indexes.get(root);
 if(!index||Date.now()-index.ts>60000){
  const files=[],walk=(dir,relative='')=>{for(const item of fs.readdirSync(dir,{withFileTypes:true})){
   if(item.name.startsWith('.')||item.name==='node_modules'||item.isSymbolicLink())continue;
   const rel=relative+item.name;if(item.isDirectory())walk(vaultPath(root,rel),rel+'/');else if(item.isFile()&&item.name.endsWith('.md'))files.push(rel);
  }};walk(root);index={ts:Date.now(),files};indexes.set(root,index);
 }
 const words=query.toLowerCase().split(/\s+/).filter(w=>w.length>2);
 const scored=index.files.map(file=>({file,score:words.reduce((s,w)=>s+(path.basename(file).toLowerCase().includes(w)?2:file.toLowerCase().includes(w)?1:0),0)})).sort((a,b)=>b.score-a.score);
 const top=scored[0];return top&&top.score>=Math.max(1,words.length)&&top.score!==scored[1]?.score?top.file:null;
}
export function readVoiceReport(root,relative,runs,receipts){
 const known=runs.some(r=>r.deliverable_path===relative||r.artifact_path===relative)||receipts.some(r=>r.deliverable===relative||r.briefSource===relative||r.obsidian?.op==='open-note'&&r.obsidian.query===relative||r.reveals?.some(v=>v.kind==='doc'&&v.target===relative));
 const daily=/^daily-notes\/\d{4}-\d{2}-\d{2}\.md$/.test(relative);
 if(!known&&!daily)throw new Error('Only referenced notes and recorded outputs can be opened');
 const file=vaultPath(root,relative),stat=fs.statSync(file);
 if(!stat.isFile()||stat.size>2000000)throw new Error('This report is too large to open here.');
 return {path:relative,content:fs.readFileSync(file,'utf8')};
}
