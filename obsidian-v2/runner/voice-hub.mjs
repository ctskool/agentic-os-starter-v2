// One speaking surface and durable, acknowledged completion delivery per bridge.
import {createHash} from 'node:crypto';
const priority=item=>['error','completion-error'].includes(item.kind)?2:item.kind==='attention'||(!item.kind&&/^(?:attention|input):/.test(item.id))?1:0;
// Existing task announcements came from bridge-owned web terminals. Leave raw
// system notices neutral, but never replay legacy task completions in native.
const itemScope=item=>['web','native'].includes(item.appScope)?item.appScope:item.taskId||item.members?.length?'web':null;
const visibleTo=(item,kind)=>!itemScope(item)||itemScope(item)===kind;
const plainLabel=value=>typeof value==='string'&&value.length<=80&&!/[\n\r<>`{}]/.test(value)?value.trim():'';
function spokenUpdate(item){
 const label=plainLabel(item.label);
 if(!label||item.kind!=='completion'||item.text.toLowerCase().includes(label.toLowerCase()))return item.text;
 return `An update on ${label}: ${item.text}`;
}
function groupedText(items){
 const tasks=new Map();for(const item of items)if(!tasks.has(item.taskId))tasks.set(item.taskId,plainLabel(item.label));
 const labels=[...new Set([...tasks.values()].filter(Boolean))];
 const named=labels.length===tasks.size&&labels.length<=3?`: ${labels.length===2?labels.join(' and '):labels.slice(0,-1).join(', ')+', and '+labels.at(-1)}`:'';
 return `There are updates from ${tasks.size} tasks${named}. The written replies have the details.`;
}
const traceStages=new Set(['capture-start','accepted','ownership-ready','selection-ready','request-start','reply','audio-resume','audio-ready','stream-start','stream-playing','stream-fallback','buffered-start','buffered-ready','buffered-playing','idle','error','cancelled','recording-start','speech-detected','no-speech','remote-start','remote-timeout','remote-empty','owner-change','connection-lost','provider-change']);
function sanitizedTrace(value){
 if(!value||typeof value!=='object'||typeof value.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.requestId)||!Number.isFinite(value.startedAt)||value.startedAt<0||!Array.isArray(value.points))return null;
 const points=[];let previous=-1;
 for(const point of value.points.slice(0,20)){if(!point||!traceStages.has(point.stage)||!Number.isFinite(point.ms)||point.ms<0||point.ms>86400000||point.ms<previous)continue;previous=point.ms;points.push({stage:point.stage,ms:Math.round(point.ms)})}
 return {requestId:value.requestId,startedAt:Math.round(value.startedAt),points};
}
export class VoiceHub {
 constructor({load=()=>[],save=()=>{},now=Date.now,emit=()=>{},leaseMs=180000,nativeLivenessMs=90000,announcementMs=300000}={}){
  this.now=now;this.save=save;this.emit=emit;this.items=load();this.clients=new Map();this.owner=null;this.captureOwner=null;this.captureEvents=[];this.leaseMs=leaseMs;this.nativeLivenessMs=nativeLivenessMs;this.announcementMs=announcementMs;
 }
 finish(item,reason){
  item.delivered=this.now()||1;if(reason)item.retiredReason=reason;
  delete item.lease;delete item.leasedAt;
  for(const id of item.members||[]){const member=this.items.find(value=>value.id===id);if(member){member.delivered=item.delivered;member.retiredReason=reason||'group-delivered';delete member.groupedInto}}
 }
 dissolve(item){
  if(!item.members||item.delivered||item.lease)return false;
  item.delivered=this.now()||1;item.retiredReason='regrouped';
  for(const id of item.members){const member=this.items.find(value=>value.id===id);if(member?.groupedInto===item.id)delete member.groupedInto}
  return true;
 }
 expire(){
  let changed=false;
  const expired=item=>!priority(item)&&Number.isFinite(item.ts)&&this.now()-item.ts>=this.announcementMs;
  for(const item of this.items)if(!item.delivered&&!item.lease&&item.members?.some(id=>{const member=this.items.find(value=>value.id===id);return member&&expired(member)}))changed=this.dissolve(item)||changed;
  for(const item of this.items)if(!item.delivered&&!item.lease&&!item.groupedInto&&expired(item)){this.finish(item,'expired');changed=true}
  return changed;
 }
 resolveTaskAttention(taskId){
  let changed=false;for(const item of this.items)if(!item.delivered&&!item.lease&&item.taskId===taskId&&['attention','error'].includes(item.kind)){this.finish(item,'resolved');changed=true}
  if(changed)this.save(this.items);
 }
 coalesce(){
  const latest=new Map();let changed=false;
  for(const item of this.items)if(!item.delivered&&!item.lease&&!item.groupedInto&&item.kind==='completion'&&item.taskId){
   const key=`${itemScope(item)}:${item.taskId}`,previous=latest.get(key);if(previous){this.finish(previous,'superseded');previous.supersededBy=item.id;changed=true}latest.set(key,item);
  }
  return changed;
 }
 live(){return [...this.clients.values()].filter(c=>this.now()-c.ts<(c.kind==='native'?this.nativeLivenessMs:15000))}
 preferred(hotkey=false){const live=this.live().filter(c=>hotkey||(c.mode==='idle'&&c.canPlay));return live.find(c=>c.id===this.owner&&(c.visible||c.kind==='native'))||
  (hotkey?live.find(c=>c.kind==='native'):null)||live.filter(c=>c.visible).sort((a,b)=>b.focus-a.focus)[0]||null}
 presence({id,kind,visible,mode,focus=false,version,canPlay=true,claim=true,playbackId,playbackStarted=false,timingTrace}){
  if(typeof id!=='string'||id.length>80||!['web','native'].includes(kind))throw new Error('Invalid voice surface');
  const old=this.clients.get(id),loadedVersion=typeof version==='string'&&version.length<=64&&/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)?version:null;
  const c={id,kind,version:loadedVersion,visible:!!visible,mode,canPlay:!!canPlay,timingTrace:sanitizedTrace(timingTrace),ts:this.now(),modeSince:!focus&&old?.mode===mode?old.modeSince:this.now(),focus:focus?this.now():old?.focus||0};this.clients.set(id,c);
  for(const [key,value] of this.clients)if(this.now()-value.ts>Math.max(60000,value.kind==='native'?this.nativeLivenessMs:0))this.leave(key);
  if(focus){this.owner=id;this.emit({type:'owner',id})}
  let changed=false;const live=this.live();
  for(const item of this.items){
   if(item.delivered||!item.lease)continue;
   if(item.lease===id&&item.id===playbackId&&playbackStarted&&!item.started){item.started=true;changed=true}
   if(!live.some(client=>client.id===item.lease)||this.now()-(item.leasedAt??item.ts)>=this.leaseMs){
    // A started attempt is never automatically spoken again after handoff,
    // disconnection or expiry. Its written result remains available.
    if(item.started)this.finish(item,'attempted');
    delete item.lease;delete item.leasedAt;changed=true;
   }
  }
  changed=this.expire()||changed;if(changed)this.save(this.items);
  const preferred=this.preferred();
  if(!claim||preferred?.id!==id||mode!=='idle'||!canPlay||live.some(c=>['working','listening','speaking'].includes(c.mode)&&this.now()-c.modeSince<this.leaseMs))return null;
  if(this.items.some(i=>!i.delivered&&i.lease&&this.live().some(c=>c.id===i.lease)))return null;
  const regroupScopes=new Set(this.items.filter(i=>!i.delivered&&!i.lease&&!i.groupedInto&&i.kind==='completion'&&i.taskId&&visibleTo(i,kind)).map(itemScope));
  for(const group of this.items)if(group.members&&regroupScopes.has(itemScope(group)))this.dissolve(group);
  this.coalesce();
  const pending=this.items.filter(i=>!i.delivered&&!i.groupedInto&&!i.lease&&visibleTo(i,kind)).sort((a,b)=>priority(b)-priority(a)||a.ts-b.ts);
  let item=pending[0];if(!item)return null;
  if(!priority(item)){
   const completions=pending.filter(value=>value.kind==='completion'&&value.taskId&&!value.members);
   if(completions.length>1){
    // A durable group has one lease and an exact member set. A failed attempt
    // retries that same set; once audio starts, none of its members replay.
    const members=completions.map(value=>value.id);
    const appScope=kind,groupId=`batch:${createHash('sha256').update(JSON.stringify({appScope,members})).digest('hex')}`;
    item={id:groupId,text:groupedText(completions),ts:this.now(),kind:'completion-group',members,appScope};
    for(const member of completions)member.groupedInto=groupId;
    this.items.push(item);
   }
  }
  item.lease=id;item.leasedAt=this.now();delete item.started;this.save(this.items);return {id:item.id,text:spokenUpdate(item)};
 }
 retireCompletion(id){
  const item=this.items.find(item=>item.id===id);
  if(!item||item.delivered||item.lease)return false;
  const group=item.groupedInto&&this.items.find(value=>value.id===item.groupedInto);
  if(group?.lease)return false;
  if(group)this.dissolve(group);
  this.finish(item,'artifact-confirmed');this.save(this.items);return true;
 }
 publish(id,text,metadata={}){
  if(!text?.trim()||this.items.some(i=>i.id===id))return;
  this.expire();
  const kind=['completion','completion-error','attention','error','artifact-confirmation'].includes(metadata.kind)?metadata.kind:null;
  const taskId=typeof metadata.taskId==='string'&&metadata.taskId.length<=160?metadata.taskId:null,label=plainLabel(metadata.label);
  const appScope=['web','native'].includes(metadata.appScope)?metadata.appScope:taskId?'web':null;
  if(kind==='completion'&&taskId){
   for(const group of this.items)if(group.members&&itemScope(group)===appScope)this.dissolve(group);
  }
  this.items.push({id,text,ts:this.now(),...(kind?{kind}:{}),...(taskId?{taskId}:{}),...(label?{label}:{}),...(appScope?{appScope}:{})});
  if(kind==='completion'&&taskId)this.coalesce();
  // Audio expiry never touches a task's written result. Retain receipts so a
  // repeated hook cannot recreate retired audio; bound receipt storage as before.
  const done=this.items.filter(i=>i.delivered).slice(-500);this.items=[...done,...this.items.filter(i=>!i.delivered)];
  this.save(this.items);this.emit({type:'pending'});
 }
 ack(id,client,ok){const item=this.items.find(i=>i.id===id);if(item?.lease!==client)return;
  delete item.lease;delete item.leasedAt;if(ok||item.started)this.finish(item,ok?'acknowledged':'attempted');this.save(this.items);
 }
 captureDiagnostics(){return this.captureEvents.map(event=>({...event}))}
 recordCapture(type,event={},client=this.captureOwner){
  const kind=this.clients.get(client)?.kind||null;
  // Bounded, in-memory metadata only: no audio, transcript, or raw error text.
  this.captureEvents.push({at:this.now(),type,client,kind,...(type==='transcript'?{characters:Math.min(20000,typeof event.text==='string'?event.text.trim().length:0)}:{})});
  if(this.captureEvents.length>12)this.captureEvents.splice(0,this.captureEvents.length-12);
 }
 leave(id){if(this.captureOwner===id)this.recordCapture('surface-left');this.clients.delete(id);if(this.owner===id)this.owner=null;if(this.captureOwner===id)this.captureOwner=null}
 capture(event){
  if(!event||typeof event!=='object')return;
  if(event.type==='capture-request'){
   // Mac microphone permission belongs to the selected app's capture API,
   // not the background Python service. The selected surface owns this turn.
   const client=this.preferred(true)?.id||null;this.captureOwner=null;
   this.recordCapture('capture-request',{},client);
   if(client){this.owner=client;this.emit({type:'owner',id:client});this.emit({type:'capture-request',client})}
   return;
  }
  if(event.type==='wake'){this.captureOwner=this.preferred(true)?.id||null;if(this.captureOwner){this.owner=this.captureOwner;this.emit({type:'owner',id:this.owner})}}
  if(['wake','transcript','wake_timeout','wake_error'].includes(event.type))this.recordCapture(event.type,event);
  if(this.captureOwner&&['wake','transcript','wake_timeout','wake_error'].includes(event.type))this.emit({...event,client:this.captureOwner});
  if(['transcript','wake_timeout','wake_error'].includes(event.type))this.captureOwner=null;
 }
}
