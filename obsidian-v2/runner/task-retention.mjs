import fs from 'node:fs';
import path from 'node:path';

export const TASK_RETENTION_MS=7*24*60*60*1000;
export const TASK_SWEEP_MS=60*60*1000;
const uuid=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const stamp=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):0;

export function migrateTaskRetention(record,mtime,now){
 const normalized=record.state!=='stopped'&&record.state!=='error';
 const activity=stamp(record.lastActivityAt)||Math.max(stamp(record.created),stamp(record.stoppedAt),...record.turns.map(t=>stamp(t.ts)),stamp(mtime));
 record.keep=record.keep===true;
 record.lastActivityAt=normalized?now:Math.min(activity||now,now);
 if(normalized){record.state='stopped';record.stoppedAt=now}
 record.pid=null;
 return record;
}

// Retired IDs contain no conversation content. They permanently prevent a delayed
// start retry from re-running work whose visible record has expired.
export class TaskRetention {
 constructor(directory,root){
  this.directory=path.resolve(directory);this.root=root;
  fs.mkdirSync(this.directory,{recursive:true});
  this.assertBase();
  this.journal=path.join(this.directory,'.retired-task-ids');this.retired=new Set();
  if(fs.existsSync(this.journal)){
   this.assertFile(this.journal);
   for(const id of fs.readFileSync(this.journal,'utf8').split(/\r?\n/))if(uuid(id))this.retired.add(id);
  }
 }
 assertBase(){
  const stat=fs.lstatSync(this.directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||!samePath(fs.realpathSync(this.directory),this.directory))throw new Error('Task storage must be a real, local directory.');
 }
 assertFile(file){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||!samePath(fs.realpathSync(file),file))throw new Error('Unsafe task file');return stat}
 read(id,{retired=false}={}){
  if(!uuid(id))throw new Error('Invalid task ID');this.assertBase();
  const folder=path.join(this.directory,retired?`.retired-${id}`:id),stat=fs.lstatSync(folder);
  if(!stat.isDirectory()||stat.isSymbolicLink()||!samePath(fs.realpathSync(folder),folder))throw new Error('Unsafe task directory');
  const file=path.join(folder,'session.json'),mtime=this.assertFile(file).mtimeMs,record=JSON.parse(fs.readFileSync(file,'utf8'));
  if(record.id!==id||record.vault!==this.root||!Array.isArray(record.turns))throw new Error('Task identity does not match its storage');
  return {record,mtime,folder};
 }
 expiresAt(record,live=false){return record.state==='stopped'&&!live&&!record.pid&&!record.keep&&Number.isFinite(record.lastActivityAt)?record.lastActivityAt+TASK_RETENTION_MS:null}
 assertNew(id){if(this.retired.has(id))throw new Error('This task has expired. Start a new task explicitly.');if(fs.existsSync(path.join(this.directory,id)))throw new Error('Task ID already exists in storage');this.assertBase()}
 remember(id){
  if(this.retired.has(id))return;
  this.assertBase();if(fs.existsSync(this.journal))this.assertFile(this.journal);
  // Flush the tombstone before deleting any task content. A failed journal write
  // leaves the original task intact and eligible for a later sweep.
  const fd=fs.openSync(this.journal,'a');try{fs.writeFileSync(fd,'\n'+id+'\n');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  this.retired.add(id);
 }
 remove(id){
  const current=this.read(id);this.verifyTree(current.folder);
  // A persistent terminal can own several managed run IDs. Keep their small
  // tombstones too, so an expired continuation cannot be retried as new work.
  const workflows=[current.record.workflow,...(Array.isArray(current.record.workflowHistory)?current.record.workflowHistory:[])];
  for(const workflow of workflows)if(uuid(workflow?.job?.id)&&workflow.job.id!==id){
   if(fs.existsSync(path.join(this.directory,workflow.job.id)))throw new Error('Workflow identity belongs to another task directory');
   this.remember(workflow.job.id);
  }
  this.remember(id);
  const retired=path.join(this.directory,`.retired-${id}`);
  fs.renameSync(current.folder,retired);
  this.removeRetired(id);
 }
 verifyTree(folder){
  const stat=fs.lstatSync(folder);
  if(stat.isSymbolicLink()||!stat.isDirectory()||!samePath(fs.realpathSync(folder),folder))throw new Error('Unsafe task directory');
  for(const name of fs.readdirSync(folder)){
   const file=path.join(folder,name),entry=fs.lstatSync(file);
   if(entry.isSymbolicLink())throw new Error('Linked task content cannot be removed');
   if(entry.isDirectory())this.verifyTree(file);else this.assertFile(file);
  }
 }
 removeRetired(id){
  if(!uuid(id)||!this.retired.has(id))return;
  const pending=path.join(this.directory,`.retired-${id}`);
  // If the final rmdir failed after session.json was removed, only an empty,
  // verified real tombstone directory may be retried without its ownership file.
  if(!fs.existsSync(path.join(pending,'session.json'))){this.assertBase();this.verifyTree(pending);if(fs.readdirSync(pending).length===0){fs.rmdirSync(pending);return}}
  const {folder}=this.read(id,{retired:true});this.verifyTree(folder);
  // Keep session.json until all children have gone so interrupted cleanup still
  // has an ownership record to validate on the next sweep. Never follow links.
  const remove=dir=>{this.verifyTree(dir);for(const name of fs.readdirSync(dir).sort((a,b)=>(a==='session.json')-(b==='session.json'))){const file=path.join(dir,name),stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw new Error('Linked task content cannot be removed');if(stat.isDirectory())remove(file);else {this.assertFile(file);fs.unlinkSync(file)}}fs.rmdirSync(dir)};
  remove(folder);
 }
}
