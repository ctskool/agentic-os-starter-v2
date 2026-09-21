import fs from 'node:fs';import crypto from 'node:crypto';
import {vaultPath,atomicRename} from './core.mjs';
export function replaceDaily(root,{path,before,after}){
 if(typeof path!=='string'||!/^daily-notes\/\d{4}-\d{2}-\d{2}\.md$/.test(path)||typeof before!=='string'||typeof after!=='string'||after.length>500000)throw new Error('Invalid daily-note edit');
 const file=vaultPath(root,path);
 if(fs.readFileSync(file,'utf8')!==before)throw new Error('This note changed since it was loaded. Refresh and try again; newer edits were preserved.');
 const temporary=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temporary,after);atomicRename(temporary,file);return {ok:true};
}
