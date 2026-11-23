import path from 'node:path';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {readPrivate,writePrivate} from './private-store.mjs';
import {validLiveSessionId} from './transport.mjs';

const time=value=>Number.isFinite(value)&&value>=0;
const recognized=row=>row&&validLiveSessionId(row.id)&&time(row.startedAt)&&(row.expiresAt==null||time(row.expiresAt));
const unconfirmed=row=>row&&time(row.cooldownUntil)&&time(row.startedAt)&&typeof row.attemptId==='string'&&row.attemptId.startsWith('unknown-');
export class LiveRecovery {
 constructor(dir){
  this.callFile=path.join(dir,'live-call.json');this.cleanupFile=path.join(dir,'live-cleanup.json');this.delegationFile=path.join(dir,'live-delegations.json');
  this.call=readPrivate(this.callFile,null);this.cleanup=readPrivate(this.cleanupFile,[]);
  if((this.call&&!recognized(this.call)&&!unconfirmed(this.call))||!Array.isArray(this.cleanup)||this.cleanup.some(row=>!recognized(row)||!time(row.giveUpAt)||!time(row.retryAt)))throw new Error('Invalid saved Live call state.');
  this.delegations=new Map(readPrivate(this.delegationFile,[]));
 }
 record(row){
  if(row)writePrivate(this.callFile,JSON.stringify(row));
  else try{fs.unlinkSync(this.callFile)}catch(error){if(error.code!=='ENOENT')throw error}
  this.call=row;
 }
 enqueue(row){
  const next=[...this.cleanup.filter(item=>item.id!==row.id),row];
  writePrivate(this.cleanupFile,JSON.stringify(next));this.cleanup=next;
 }
 forgetCleanup(id){
  if(!this.cleanup.some(row=>row.id===id))return;
  const next=this.cleanup.filter(row=>row.id!==id);writePrivate(this.cleanupFile,JSON.stringify(next));this.cleanup=next;
 }
 remove(id){
  this.forgetCleanup(id);
  if(this.call?.id===id)this.record(this.call.replacementAttempt||null);
  const entries=[...this.delegations].filter(([key])=>JSON.parse(key)[0]!==id);
  if(entries.length!==this.delegations.size){
   writePrivate(this.delegationFile,JSON.stringify(entries));this.delegations=new Map(entries);
  }
 }
 register(sessionId,delegationId){
  const key=JSON.stringify([sessionId,delegationId]);
  if(this.delegations.has(key))return this.delegations.get(key);
  const id=randomUUID(),next=new Map(this.delegations).set(key,id);
  writePrivate(this.delegationFile,JSON.stringify([...next]));this.delegations=next;
  return id;
 }
}
