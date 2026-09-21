// Only recorded, validated worker outputs are exposed to dashboard viewers.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const ROOT='system/v2/artifacts';
const TYPES={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.pdf':'application/pdf','.md':'text/markdown','.txt':'text/plain'};
export const MAX_ARTIFACT_BYTES=20*1024*1024;
export const artifactId=id=>typeof id==='string'&&/^[a-f0-9]{40}$/.test(id);
export const artifactContentKey=artifact=>`${/(?:^|\/)([a-f0-9]{64})\.[^/]+$/.exec(artifact.path||'')?.[1]||artifact.path||artifact.id}:${artifact.mime||''}`;
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const within=(root,file)=>file!==root&&!path.relative(root,file).startsWith('..'+path.sep)&&path.relative(root,file)!=='..'&&!path.isAbsolute(path.relative(root,file));

function checkedPath(root,relative,{hidden=false}={}){
 const base=fs.realpathSync(root),candidate=path.resolve(base,relative);
 if(!within(base,candidate)||/[\x00-\x1f]/.test(relative))throw new Error('Artifact path escaped its allowed folder.');
 const parts=path.relative(base,candidate).split(path.sep);
 if(!hidden&&parts.some(part=>part.startsWith('.')))throw new Error('Private configuration is not a displayable artifact.');
 for(let cursor=candidate;cursor!==base;cursor=path.dirname(cursor)){
  if(fs.existsSync(cursor)&&fs.lstatSync(cursor).isSymbolicLink())throw new Error('Linked artifact paths are not allowed.');
 }
 if(fs.existsSync(candidate)&&!within(base,fs.realpathSync(candidate)))throw new Error('Artifact path escaped its allowed folder.');
 return candidate;
}

function fileBytes(absolute){
 const stat=fs.statSync(absolute);
 if(!stat.isFile()||stat.size<1||stat.size>MAX_ARTIFACT_BYTES)throw new Error('Artifact is missing, empty, or too large to preview.');
 const ext=path.extname(absolute).toLowerCase(),mime=TYPES[ext];
 if(!mime)throw new Error('This artifact type is not supported for preview.');
 const descriptor=fs.openSync(absolute,'r');let bytes;
 try{
  const opened=fs.fstatSync(descriptor);
  if(!opened.isFile()||opened.size!==stat.size||opened.ino!==stat.ino||opened.dev!==stat.dev)throw new Error('Artifact changed while it was being read.');
  bytes=Buffer.alloc(stat.size);let offset=0;
  while(offset<bytes.length){const read=fs.readSync(descriptor,bytes,offset,bytes.length-offset,offset);if(!read)throw new Error('Artifact changed while it was being read.');offset+=read;}
  const after=fs.fstatSync(descriptor),named=fs.lstatSync(absolute);
  if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||named.isSymbolicLink()||named.ino!==after.ino||named.dev!==after.dev)throw new Error('Artifact changed while it was being read.');
 }finally{fs.closeSync(descriptor);}
 const header=bytes.subarray(0,16);
 const valid=ext==='.png'?header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
  ['.jpg','.jpeg'].includes(ext)?header[0]===255&&header[1]===216&&header[2]===255:
  ext==='.webp'?header.toString('ascii',0,4)==='RIFF'&&header.toString('ascii',8,12)==='WEBP':
  ext==='.gif'?/^GIF8[79]a/.test(header.toString('ascii')):
  ext==='.pdf'?header.toString('ascii',0,5)==='%PDF-':!bytes.includes(0)&&bytes.length<=2*1024*1024;
 if(!valid)throw new Error('Artifact contents do not match its file type.');
 return {bytes,mime,ext,sha256:digest(bytes)};
}

function sourcePath(root,source,{sessionId,encoded=false,codexHome=process.env.CODEX_HOME||path.join(os.homedir(),'.codex')}={}){
 if(typeof source!=='string'||source.length>2048||/^(?:https?|data|javascript):/i.test(source))throw new Error('A local artifact file is required.');
 if(source.startsWith('file:'))throw new Error('Use a local file path, not a file URL.');
 // Helpers and tool results supply literal filesystem paths. A percent sign is
 // valid in a filename; URL decoding must never silently select another file.
 // Only actual Markdown destinations opt into a decoded fallback, and an
 // existing, independently validated literal path always takes precedence.
 if(encoded){
  const literal=sourcePath(root,source,{sessionId,codexHome});
  if(fs.existsSync(literal))return literal;
  let decoded;try{decoded=decodeURIComponent(source)}catch{throw new Error('Invalid encoded artifact link.');}
  return sourcePath(root,decoded,{sessionId,codexHome});
 }
 const absolute=path.resolve(root,source);
 if(within(fs.realpathSync(root),absolute))return checkedPath(root,source);
 if(!/^[a-f0-9-]{36}$/.test(sessionId||''))throw new Error('External artifact does not belong to this conversation.');
 const generated=path.join(codexHome,'generated_images',sessionId);
 // Never allow a configurable symlink to turn the exact-session exception into
 // general filesystem access. The generated root and each descendant are checked.
 const home=fs.realpathSync(codexHome);
 checkedPath(home,path.relative(home,generated),{hidden:true});
 if(!within(path.resolve(generated),absolute))throw new Error('External artifact does not belong to this conversation.');
 return checkedPath(generated,path.relative(generated,absolute),{hidden:true});
}

export function registerArtifact(root,{taskId,turnId,sessionId,path:source,label,open=false,encoded=false,isFinal=true},options={}){
 if(typeof taskId!=='string'||!/^[a-f0-9-]{36}$/.test(taskId)||typeof turnId!=='string'||!turnId||turnId.length>100)throw new Error('Artifact has no owning conversation turn.');
 const absolute=sourcePath(root,source,{sessionId,encoded,...options});
 const {bytes,mime,ext,sha256}=fileBytes(absolute);
 const id=digest(JSON.stringify([taskId,turnId,absolute,sha256])).slice(0,40);
 // Keep an immutable copy: later edits or cleanup of the original must not make
 // a saved conversation accidentally show a different file under the same ID.
 // References identify task turns; immutable bytes identify content. Reopening
 // the same image gets a new reference without copying the image again.
 const relative=`${ROOT}/files/${sha256}${ext}`,copy=checkedPath(root,relative);
 fs.mkdirSync(path.dirname(copy),{recursive:true});
 try{fs.writeFileSync(copy,bytes,{flag:'wx'})}catch(error){if(error.code!=='EEXIST')throw error;if(fileBytes(copy).sha256!==sha256)throw new Error('Saved artifact was changed.');}
 const artifact={id,taskId,turnId,path:relative,label:String(label||path.basename(absolute)).replace(/[\x00-\x1f]/g,' ').slice(0,160),mime,bytes:bytes.length,open:open===true,isFinal:isFinal===true};
 const record=checkedPath(root,`${ROOT}/${id}.json`);
 if(fs.existsSync(record)&&fs.statSync(record).size>16000)throw new Error('Invalid artifact record.');
 const temp=record+'.'+crypto.randomUUID()+'.tmp';
 fs.writeFileSync(temp,JSON.stringify({version:1,artifact,sha256}));
 fs.renameSync(temp,record);
 return artifact;
}

export function readArtifact(root,id){
 if(!artifactId(id))throw new Error('Invalid artifact ID.');
 const record=checkedPath(root,`${ROOT}/${id}.json`);
 if(fs.statSync(record).size>16000)throw new Error('Invalid artifact record.');
 const saved=JSON.parse(fs.readFileSync(record,'utf8')),artifact=saved.artifact;
 if(saved.version!==1||artifact?.id!==id||typeof artifact.path!=='string'||
  artifact.path!==`${ROOT}/files/${saved.sha256}${path.extname(artifact.path)}`||
  !/^[a-f0-9-]{36}$/.test(artifact.taskId||'')||typeof artifact.turnId!=='string'||!artifact.turnId||artifact.turnId.length>100||
  typeof artifact.label!=='string'||artifact.label.length>160||typeof artifact.open!=='boolean'||artifact.isFinal!==undefined&&typeof artifact.isFinal!=='boolean'||
  !Number.isInteger(artifact.bytes)||artifact.bytes<1||artifact.bytes>MAX_ARTIFACT_BYTES||!/^[a-f0-9]{64}$/.test(saved.sha256||''))throw new Error('Invalid artifact record.');
 const absolutePath=checkedPath(root,artifact.path);
 const result=fileBytes(absolutePath);
 if(result.sha256!==saved.sha256||result.bytes.length!==artifact.bytes||result.mime!==artifact.mime)throw new Error('Saved artifact changed.');
 return {artifact,absolutePath,bytes:result.bytes};
}

export function linkedArtifacts(text){
 const candidates=[];
 // Parse actual Markdown destinations only, never paths invented from prose.
 for(const match of String(text||'').matchAll(/(!?)\[([^\]\r\n]*)\]\((?:<([^>\r\n]+)>|([^\s)]+))(?:\s+"[^"\r\n]*")?\)/g)){
  const target=match[3]||match[4];
  if(!/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)||/^[A-Za-z]:[\\/]/.test(target))candidates.push({path:target,label:match[2],open:match[1]==='!',...(target.includes('%')?{encoded:true}:{})});
  if(candidates.length===8)break;
 }
 return candidates;
}

export function captureTurnArtifacts(root,record,event,{candidates=[],...options}={}){
 const final=linkedArtifacts(event.text),helpers=candidates.slice(-8),discovered=(Array.isArray(event.artifactCandidates)?event.artifactCandidates:[]).slice(-8);
 const groups=new Map(),errors=[];
 // Final-answer links identify the deliverable set. Earlier image-generation
 // passes are provenance, not separate requests to open every draft.
 const inputs=[...final.map(value=>({value,kind:'final'})),...helpers.map((value,index)=>({value,kind:'helper',index})),...discovered.map((value,index)=>({value,kind:'discovered',index}))];
 for(const {value:candidate,kind,index} of inputs.slice(0,24)){
  try{
   const item=registerArtifact(root,{...candidate,open:false,isFinal:false,taskId:record.id,turnId:event.turnId,sessionId:record.sessionId},options);
   const key=artifactContentKey(item),group=groups.get(key)||{artifact:item,candidate,final:false,inline:false,helperOpen:-1,discovered:-1};
   if(kind==='final'){group.final=true;group.inline||=candidate.open===true;}
   if(kind==='helper'&&candidate.open===true)group.helperOpen=Math.max(group.helperOpen,index);
   if(kind==='discovered')group.discovered=Math.max(group.discovered,index);
   groups.set(key,group);
  }catch(error){errors.push(String(error.message||error).slice(0,200));}
 }
 const values=[...groups.values()];let selected=[];
 if(final.length)selected=values.filter(group=>group.final&&(group.artifact.mime.startsWith('image/')||group.inline||group.helperOpen>=0));
 else if(helpers.some(value=>value.open===true)){
  // No written final set: the last explicit presentation is authoritative.
  // Do not substitute a draft if that requested file failed validation.
  const last=helpers.findLastIndex(value=>value.open===true);selected=values.filter(group=>group.helperOpen===last);
 }else{
  const last=discovered.findLastIndex(value=>/\.(?:png|jpe?g|webp|gif)$/i.test(value.path||''));
  const latest=values.find(group=>group.artifact.mime.startsWith('image/')&&last>=0&&group.discovered===last);
  if(latest)selected=[latest];
 }
 for(const group of values.filter(group=>group.final||selected.includes(group))){
  try{group.artifact=registerArtifact(root,{...group.candidate,open:selected.includes(group),isFinal:true,taskId:record.id,turnId:event.turnId,sessionId:record.sessionId},options)}
  catch(error){errors.push(String(error.message||error).slice(0,200));}
 }
 // Keep the final set in the retained context even if a tool made many drafts.
 const ordered=[...selected,...values.filter(group=>!selected.includes(group))];
 return {artifacts:ordered.slice(0,8).map(group=>group.artifact),errors:errors.slice(0,3)};
}

// A spoken "open it when it's done" is honoured even if the worker omitted
// --open: one final output is promoted, and a set that already opens something
// is returned unchanged.
export function promiseOpen(artifacts){
 if(!Array.isArray(artifacts)||!artifacts.length||artifacts.some(item=>item?.open===true))return artifacts;
 const promised=artifacts.find(item=>item?.isFinal!==false);
 if(!promised)return artifacts;
 return artifacts.map(item=>item===promised?{...item,open:true,isFinal:true}:item);
}
