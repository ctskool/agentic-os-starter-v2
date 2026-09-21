import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const built=await build({entryPoints:['shared/drafts.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {copyDraftToNewTask,draftKey}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
function storage(){const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}}
test('expired task draft can be explicitly copied without destroying the original',()=>{
 const s=storage(),old=draftKey('obsidian','vault','expired');s.setItem(old,'My unsent follow-up');
 const next=copyDraftToNewTask(s,'obsidian','vault',s.getItem(old));
 assert.equal(s.getItem(old),'My unsent follow-up');assert.equal(s.getItem(next),'My unsent follow-up');
 assert.equal(copyDraftToNewTask(s,'obsidian','vault',s.getItem(old)),next);
});
test('copying an expired draft never overwrites another request or recovered workflow',()=>{
 const s=storage(),key=draftKey('obsidian','vault',null);s.setItem(key,'A different request');
 assert.throws(()=>copyDraftToNewTask(s,'obsidian','vault','My follow-up'),/already saved/);assert.equal(s.getItem(key),'A different request');
 s.removeItem(key);s.setItem(key+':selection','saved workflow');
 assert.throws(()=>copyDraftToNewTask(s,'obsidian','vault','My follow-up'),/already saved/);assert.equal(s.getItem(key+':selection'),'saved workflow');assert.equal(s.getItem(key),null);
});
test('failed storage and empty drafts fail visibly without deleting anything',()=>{
 assert.throws(()=>copyDraftToNewTask(storage(),'obsidian','vault',' '),/no draft/);
 const s=storage();s.setItem=()=>{throw new Error('Full')};
 assert.throws(()=>copyDraftToNewTask(s,'obsidian','vault','Keep this text'),/Could not save/);
 s.getItem=()=>{throw new Error('Storage unavailable')};
 assert.throws(()=>copyDraftToNewTask(s,'obsidian','vault','Keep this text'),/Storage unavailable/);
});
