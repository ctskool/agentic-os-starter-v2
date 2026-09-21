import {randomUUID} from 'node:crypto';

const attentionState=record=>['needs input','error'].includes(record.state)?record.state:null;
const attentionReason=record=>String(record.inputReason||record.error||(record.state==='needs input'?'permission':''));

// Repeated saves of one blocked state are one announcement. After the worker
// continues, the same approval can happen again and needs a new delivery ID.
// Boot seeding avoids replaying already-recorded states after a bridge restart;
// VoiceHub retains ownership of all previously queued/delivered receipts.
export class WorkAttentionEpisodes {
 constructor(records=[],{epoch=randomUUID()}={}){
  this.epoch=epoch;this.records=new Map();
  for(const record of records)this.records.set(record.id,{state:attentionState(record),reason:attentionReason(record),sequence:0});
 }
 remove(id){this.records.delete(id);}
 next(record){
  const state=attentionState(record),reason=attentionReason(record),previous=this.records.get(record.id);
  const changed=state&&(state!==previous?.state||reason!==previous?.reason);
  const sequence=(previous?.sequence||0)+(changed?1:0);
  this.records.set(record.id,{state,reason,sequence});
  if(!changed)return null;
  return {id:`attention:${this.epoch}:${record.id}:${sequence}`,state,reason};
 }
}
