import path from 'node:path';
import {readPrivate,writePrivate} from './private-store.mjs';
import {TIME_ZONE} from '../../shared/timezone.mjs';

const amount=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export const liveEstimate=row=>amount(row.activeSeconds)&&amount(row.pausedSeconds)?
 (row.activeSeconds*.05+row.pausedSeconds*.02)/60:row.seconds*.05/60;
export class LiveUsage {
 constructor(runtimeDir){
  this.file=path.join(runtimeDir,'live-usage.jsonl');
  this.rows=new Map(readPrivate(this.file,[],text=>text.split('\n').filter(Boolean).map(line=>JSON.parse(line))).map(row=>[row.sessionId,row]));
 }
 update(sessionId,startedAt,usage,state='open'){
  const old=this.rows.get(sessionId);
  if(old?.state==='final')return old;
  if(old?.state==='unconfirmed'&&state==='open')return old;
  const oldSeconds=old?.seconds??0;
  const fresh=amount(usage?.seconds)&&usage.seconds>=oldSeconds,seconds=fresh?usage.seconds:oldSeconds;
  const split=fresh?(amount(usage.active_seconds)&&amount(usage.paused_seconds)?{activeSeconds:usage.active_seconds,pausedSeconds:usage.paused_seconds}:
   seconds===oldSeconds?{activeSeconds:old?.activeSeconds,pausedSeconds:old?.pausedSeconds}:{}):{activeSeconds:old?.activeSeconds,pausedSeconds:old?.pausedSeconds};
  const row={sessionId,startedAt:old?.startedAt??startedAt,state,seconds,...split};
  if(JSON.stringify(old)===JSON.stringify(row))return old;
  const next=new Map(this.rows).set(sessionId,row);
  writePrivate(this.file,[...next.values()].map(value=>JSON.stringify(value)).join('\n')+'\n');this.rows=next;return row;
 }
 month(now){
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit'});
  const month=formatter.format(now),rows=[...this.rows.values()].filter(row=>formatter.format(row.startedAt)===month);
  return {label:'Live voice session cost, est.',usd:rows.reduce((sum,row)=>sum+liveEstimate(row),0),unconfirmed:rows.filter(row=>row.state==='unconfirmed').length};
 }
 reidentify(attemptId,sessionId,startedAt){
  if(!this.rows.has(attemptId))return this.update(sessionId,startedAt);
  const next=new Map(this.rows);next.delete(attemptId);next.set(sessionId,{sessionId,startedAt,state:'open',seconds:0});
  writePrivate(this.file,[...next.values()].map(value=>JSON.stringify(value)).join('\n')+'\n');this.rows=next;
 }
}
