import {randomUUID} from 'node:crypto';
import {localDate} from '../brief-voice.mjs';

export function liveText(value,limit=500){
 const text=String(value??'').trim();
 if(Buffer.byteLength(text)<=limit)return text;
 // Too long: end on a whole sentence, or at least a whole word, so Live never says half a word.
 const cut=Buffer.from(text).subarray(0,limit).toString('utf8').replace(/\uFFFD$/,'');
 const sentence=cut.match(/^[\s\S]*[.!?](?=\s|$)/)?.[0];
 if(sentence&&sentence.length>=cut.length/2)return sentence.trimEnd();
 const word=cut.replace(/\s+\S*$/,'');
 return (word&&word!==cut?word:cut).trimEnd();
}
export const revealedReports=reply=>new Set([reply.deliverable,reply.briefSource,reply.obsidian?.op==='open-note'&&reply.obsidian.query,
 reply.obsidian?.op==='daily-note'&&`daily-notes/${localDate()}.md`,
 ...(reply.reveals||[]).filter(item=>item.kind==='doc').map(item=>item.target)].filter(path=>typeof path==='string'&&path));

// Closes a hand-off nothing more will be said on. On the real API Live stays quiet and standby follows (probe, 2026-11-26).
export const LIVE_SUPERSEDED='Superseded: what the user said next replaces this request and is handled on its own. There is nothing to say about this one; say nothing.';
export class LiveAnswers {
 constructor(call){this.call=call;this.held=[];this.attempts=new Map();this.reports=new Set();this.answered=new Set();this.spoken=new Map();this.tools=new Map()}
 // Tool hand-offs (tools.mjs): the first line said on a tool call is its result, which the backend model words and
 // Live says. A tool call takes no appends of its own, so anything after that, and anything silent, is a plain line.
 tool(key,callId){this.tools.set(key,{callId,done:false,extra:{}});if(this.tools.size>256)this.tools.delete(this.tools.keys().next().value)}
 toolExtra(key,extra){const tool=this.tools.get(key);if(tool)Object.assign(tool.extra,extra)}
 // Every tool call is answered, even one V2 has nothing to say on: an unanswered one blocks every later hand-off.
 // Asks the backend model to look at the conversation now (a promise Live made without handing it off).
 kick(){
  if(this.call.state==='closing'||!this.call.socket)return;
  this.call.debugLog?.({sent:'kick',delegation:null,text:'response.create'});
  try{this.call.socket.send({type:'response.create',event_id:'evt_'+randomUUID().replace(/-/g,'')})}catch{}
 }
 closeTool(key){const tool=this.tools.get(key);if(tool&&!tool.done)this.toolOutput(tool,'',{note:'Nothing to report on this one; say nothing.'})}
 toolOutput(tool,say,more={}){
  tool.done=true;
  if(this.call.state==='closing'||!this.call.socket)return;
  const id=()=>'evt_'+randomUUID().replace(/-/g,'');
  this.call.debugLog?.({sent:'tool-output',delegation:null,text:say});
  if(say&&this.call.clock)this.call.commentedAt=this.call.clock();
  try{
   this.call.socket.send({type:'response.item.create',event_id:id(),item:{type:'function_call_output',call_id:tool.callId,output:JSON.stringify({ok:true,say,...tool.extra,...more})}});
   this.call.socket.send({type:'response.create',event_id:id()});
  }catch{}
 }
 append(kind,id,value,limit){
  const tool=this.tools.get(id);
  if(tool){
   if(kind==='commentary'&&!tool.done){const say=liveText(value,limit);if(say&&this.call.state!=='closing')this.toolOutput(tool,say);return}
   id=null;
  }
  const text=liveText(value,limit);if(!text||this.call.state==='closing')return;
  // GPT-Live wire shape (checked against the API 2026-11-22): event_id, and content as a plain string.
  const event={type:'session.'+kind+'.append',delegation_id:id,event_id:'evt_'+randomUUID().replace(/-/g,''),content:text};
  // A commentary on a hand-off answers it (real calls, 2026-11-26); only an unanswered one can be held open.
  if(kind==='commentary'&&id){this.answered.add(id);this.spoken.set(event.event_id,event);if(this.spoken.size>64)this.spoken.delete(this.spoken.keys().next().value)}
  if(kind==='commentary'&&(this.call.paused||!this.call.socket)){this.held.push(event);return}
  this.send(event);
 }
 isOpen(id){return typeof id==='string'&&!!id&&!this.answered.has(id)&&!this.tools.has(id)}
 send(event){
  if(this.call.state==='closing'||!this.call.socket)return;
  // Record the attempt before send, including a send which throws after the
  // frame may have gone out. A reconnect never replays an uncertain append.
  this.attempts.set(event.event_id,'unknown');
  this.call.debugLog?.({sent:event.type.replace(/^session\.|\.append$/g,''),delegation:event.delegation_id,text:event.content});
  // Two lines for Live to say, sent within a second or so, and Live said only the second (2026-11-26): task news waits on this.
  if(event.type==='session.commentary.append'&&this.call.clock)this.call.commentedAt=this.call.clock();
  if(this.attempts.size>2048)this.attempts.delete(this.attempts.keys().next().value);
  try{this.call.socket.send(event)}catch{}
 }
 acknowledge(event){
  // OpenAI echoes our event_id as error.client_event_id on a rejected append.
  const id=event.error?.client_event_id??event.client_event_id;
  if(this.attempts.has(id))this.attempts.set(id,event.type==='error'?'rejected':'acknowledged');
  // A line refused on its hand-off (for example one OpenAI no longer holds open) is still said, as a plain line.
  const refused=event.type==='error'&&this.spoken.get(id);this.spoken.delete(id);
  if(refused&&refused.delegation_id)this.append('commentary',null,refused.content);
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
 result(id,reply,view=reply,{speak=true,keepOpen=false}={}){
  if(this.call.state==='closing')return;
  // Work that started a task: everything said now goes as plain lines, and the hand-off itself gets only a silent
  // note, so it stays open until the task's news is said on it (task-updates.mjs).
  if(keepOpen&&this.isOpen(id)){
   this.append('thinking',id,'V2 started this as a background task. Its result will be said on this hand-off when it finishes; keep talking with the user meanwhile.');
   id=null;
  }
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
