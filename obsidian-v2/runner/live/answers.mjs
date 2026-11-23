import {randomUUID} from 'node:crypto';
import {localDate} from '../brief-voice.mjs';

export function liveText(value,limit=500){
 return Buffer.from(String(value??'').trim()).subarray(0,limit).toString('utf8').replace(/\uFFFD$/,'').trimEnd();
}
export const revealedReports=reply=>new Set([reply.deliverable,reply.briefSource,reply.obsidian?.op==='open-note'&&reply.obsidian.query,
 reply.obsidian?.op==='daily-note'&&`daily-notes/${localDate()}.md`,
 ...(reply.reveals||[]).filter(item=>item.kind==='doc').map(item=>item.target)].filter(path=>typeof path==='string'&&path));

export class LiveAnswers {
 constructor(call){this.call=call;this.held=[];this.attempts=new Map();this.reports=new Set()}
 append(kind,id,value,limit){
  const text=liveText(value,limit);if(!text||this.call.state==='closing')return;
  // GPT-Live wire shape (checked against the API 2026-11-22): event_id, and content as a plain string.
  const event={type:'session.'+kind+'.append',delegation_id:id,event_id:'evt_'+randomUUID().replace(/-/g,''),content:text};
  if(kind==='commentary'&&(this.call.paused||!this.call.socket)){this.held.push(event);return}
  this.send(event);
 }
 send(event){
  if(this.call.state==='closing'||!this.call.socket)return;
  // Record the attempt before send, including a send which throws after the
  // frame may have gone out. A reconnect never replays an uncertain append.
  this.attempts.set(event.event_id,'unknown');
  if(this.attempts.size>2048)this.attempts.delete(this.attempts.keys().next().value);
  try{this.call.socket.send(event)}catch{}
 }
 acknowledge(event){
  // OpenAI echoes our event_id as error.client_event_id on a rejected append.
  const id=event.error?.client_event_id??event.client_event_id;
  if(this.attempts.has(id))this.attempts.set(id,event.type==='error'?'rejected':'acknowledged');
 }
 resume({tasks=true,recentInput=false}={}){
  if(this.call.paused||!this.call.socket)return;
  for(const event of this.held.splice(0)){
   if(!tasks&&event.delegation_id===null)this.held.push(event);
   else if(recentInput&&event.delegation_id===null&&!event.content.startsWith('By the way, '))this.send({...event,content:liveText('By the way, '+event.content)});
   else this.send(event);
  }
 }
 close(){this.held.length=0}
 speak(id,reply){this.append('commentary',id,reply)}
 result(id,reply,view=reply,{speak=true}={}){
  if(this.call.state==='closing')return;
  for(const path of revealedReports(reply))this.reports.add(path);
  for(const path of revealedReports(view))this.reports.add(path);
  const {panels,reveals,deliverable,obsidian,workIds,action,queued,reply:text,reveal,current,currentRevision,conversationSuperseded}=view;
  this.call.updates.push({type:'effect',reply:{panels,reveals,deliverable,obsidian,workIds,action,queued,reply:text,reveal,current,currentRevision,conversationSuperseded}});
  if(!speak)return;
  const spoken=String(reply.spokenReply??reply.reply??'').trim(),spokenPart=liveText(spoken);
  this.speak(id,spokenPart);
  const written=String(reply.reply??'').trim();
  const remainder=written.startsWith(spokenPart)?written.slice(spokenPart.length).trim():
   [spoken.slice(spokenPart.length).trim(),written&&written!==spoken&&!spoken.startsWith(written)?written:''].filter(Boolean).join('\n');
  // Excerpts already selected by a Live read are safe here. Raw reports and
  // worker completions are never fetched into sideband payloads.
  if(remainder)this.append('thinking',id,remainder);
 }
}
