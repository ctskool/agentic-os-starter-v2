import fs from 'node:fs';import crypto from 'node:crypto';
import {vaultPath,atomicRename} from './core.mjs';
import {localDate} from './brief-voice.mjs';
export function replaceDaily(root,{path,before,after},beforeWrite){
 if(typeof path!=='string'||!/^daily-notes\/\d{4}-\d{2}-\d{2}\.md$/.test(path)||typeof before!=='string'||typeof after!=='string'||after.length>500000)throw new Error('Invalid daily-note edit');
 const file=vaultPath(root,path);
 if(fs.readFileSync(file,'utf8')!==before)throw new Error('This note changed since it was loaded. Refresh and try again; newer edits were preserved.');
 beforeWrite?.();
 const temporary=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temporary,after);atomicRename(temporary,file);return {ok:true};
}

const checkbox=/^(?:\d+\.|-)\s+\[( |x)\]\s+(.*)/;
function dailyCheckboxes(lines){
 let section='',position=0;const items=[];
 for(const [index,line] of lines.entries()){
  const heading=/^##\s+(.*)/.exec(line);
  if(heading){section=heading[1].trim();position=0}
  const match=checkbox.exec(line);
  if(match)items.push({section,text:match[2].trim(),line,position:position++,index});
 }
 return items;
}
export function dailyCheckboxEdit(lines,index,replacement){
 const {index:_index,...item}=dailyCheckboxes(lines).find(item=>item.index===index);
 return {kind:'checkbox',item,replacement};
}
export function appendDailyDriver(raw,text){
 const marker='## Daily Drivers',idx=raw.indexOf(marker);
 if(idx<0)return null;
 const eol=raw.includes('\r\n')?'\r\n':'\n',afterHeading=idx+marker.length,nextSection=raw.indexOf('\n## ',afterHeading);
 const insertAt=nextSection<0?raw.length:nextSection,sectionContent=raw.slice(afterHeading,insertAt).replace(/\s+$/,'');
 return raw.slice(0,afterHeading)+`${sectionContent}${eol}- [ ] ${text}${eol}`+raw.slice(insertAt);
}
export function resolveDailyEdit(root,{path,edit}){
 const changed=()=>new Error('The planned daily-note item or its location changed. Say the request again.');
 if(path!==`daily-notes/${localDate()}.md`)throw changed();
 let before;try{before=fs.readFileSync(vaultPath(root,path),'utf8')}catch{throw changed()}
 if(edit.kind==='add'){
  const after=appendDailyDriver(before,edit.text);
  if(after===null)throw changed();
  return {path,before,after};
 }
 const eol=before.includes('\r\n')?'\r\n':'\n',lines=before.split(/\r?\n/);
 const matches=dailyCheckboxes(lines).filter(item=>item.section===edit.item.section&&item.line===edit.item.line&&item.text===edit.item.text);
 // Daily notes have no item IDs. The exact checkbox identifies the item, and
 // its section order detects a move. Identical checkboxes are ambiguous.
 if(matches.length!==1||matches[0].position!==edit.item.position)throw changed();
 lines[matches[0].index]=edit.replacement;
 return {path,before,after:lines.join(eol)};
}
