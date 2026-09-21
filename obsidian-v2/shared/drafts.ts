export interface DraftStorage {getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void}
export function draftKey(surface:string,vault:string,task:string|null){return `aos-v2-draft:${surface}:${encodeURIComponent(vault.toLowerCase().replace(/\\/g,'/'))}:${task||'new'}`}
export function readDraft(storage:DraftStorage,key:string){try{return (storage.getItem(key)||'').slice(0,12000)}catch{return ''}}
export function saveDraft(storage:DraftStorage,key:string,text:string){try{if(text)storage.setItem(key,text);else storage.removeItem(key);return true}catch{return false}}
// Copy explicitly after a task expires. Never replace another new-task draft or
// workflow's saved selection, and keep the original draft until the user sends it.
export function copyDraftToNewTask(storage:DraftStorage,surface:string,vault:string,text:string){
 if(!text.trim())throw new Error('There is no draft to copy.');
 const key=draftKey(surface,vault,null),existing=storage.getItem(key);
 if(storage.getItem(key+':selection')||existing?.trim()&&existing!==text)throw new Error('A new-task draft is already saved. Copy this text before opening it.');
 if(!saveDraft(storage,key,text))throw new Error('Could not save the new-task draft. Copy this text before closing it.');
 return key;
}
