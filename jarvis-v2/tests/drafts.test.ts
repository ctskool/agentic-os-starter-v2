import test from 'node:test';import assert from 'node:assert/strict';
import {draftKey,readDraft,saveDraft} from '../../obsidian-v2/shared/drafts';
test('drafts survive reload and stay separate across tasks, vaults and interfaces',()=>{
 const values=new Map<string,string>();const storage={getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>{values.set(key,value)},removeItem:(key:string)=>{values.delete(key)}};
 const a=draftKey('jarvis','C:/Vault','a'),b=draftKey('jarvis','C:/Vault','b');
 saveDraft(storage,a,'Unsent A');saveDraft(storage,b,'Unsent B');assert.equal(readDraft(storage,a),'Unsent A');assert.equal(readDraft(storage,b),'Unsent B');
 assert.equal(readDraft(storage,draftKey('obsidian','C:/Vault','a')),'');assert.equal(readDraft(storage,draftKey('jarvis','C:/Other','a')),'');
 saveDraft(storage,a,'');assert.equal(readDraft(storage,a),'');assert.equal(readDraft(storage,b),'Unsent B');
 assert.equal(saveDraft({ ...storage,setItem(){throw new Error('Full')}},a,'unsaved'),false);
});
