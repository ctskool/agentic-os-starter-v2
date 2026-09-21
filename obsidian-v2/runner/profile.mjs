import fs from 'node:fs';
import path from 'node:path';
// Optional per-vault preferences in system/v2/profile.json. A missing or
// malformed file means the built-in defaults, so nothing changes without one.
export const DEFAULT_DRIVERS=Object.freeze(['Skool post','YouTube recording','Inbox triage','Daily review']);
const valid=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=60&&!/[\r\n\[\]`]/.test(value);
export function dailyDrivers(root){
 try{
  const list=JSON.parse(fs.readFileSync(path.join(root,'system/v2/profile.json'),'utf8').replace(/^\uFEFF/,'')).dailyDrivers;
  if(Array.isArray(list)&&list.length>=1&&list.length<=8&&list.every(valid)&&new Set(list).size===list.length)return list;
 }catch{}
 return DEFAULT_DRIVERS;
}
// The two planning rubrics name the defaults in prose; a vault with its own
// list gets the same sentences with its own labels.
const RUBRIC_DRIVERS=[
 ['Default new-note drivers are Skool post, YouTube recording, Inbox triage and Daily review.',list=>`Default new-note drivers are ${list.length>1?list.slice(0,-1).join(', ')+' and '+list.at(-1):list[0]}.`],
 ['Driver defaults: Skool post, YouTube recording, Inbox triage, Daily review;',list=>`Driver defaults: ${list.join(', ')};`]
];
export function rubricWithDrivers(text,list){
 if(list===DEFAULT_DRIVERS)return text;
 for(const [before,after] of RUBRIC_DRIVERS)text=text.split(before).join(after(list));
 return text;
}
