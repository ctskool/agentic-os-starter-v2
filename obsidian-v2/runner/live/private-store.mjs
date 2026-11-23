import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function writePrivate(file,text){
 fs.mkdirSync(path.dirname(file),{recursive:true});
 const temp=file+'.'+randomUUID()+'.tmp';
 try{fs.writeFileSync(temp,text,{flag:'wx',mode:0o600,flush:true});fs.renameSync(temp,file)}
 finally{try{fs.unlinkSync(temp)}catch{}}
}
export function readPrivate(file,fallback,parse=JSON.parse){
 try{return parse(fs.readFileSync(file,'utf8'))}catch(error){if(error.code==='ENOENT')return fallback;throw error}
}
