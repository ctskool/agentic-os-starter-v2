import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {liveAuthorization,readLiveKey} from './key.mjs';
import {LiveRecovery} from './recovery.mjs';
import {LiveUsage,liveEstimate} from './usage.mjs';
import {LiveUpdates} from './updates.mjs';
import {createLiveTransport,LiveCreateRejected,validLiveSessionId} from './transport.mjs';
import {liveHistory,liveSessionBody,liveSnapshot} from './snapshot.mjs';
import {appendParts,APPEND_MAX_BYTES} from './clip.mjs';
import {greetingCue,liveGreeting} from './greeting.mjs';
import {LiveTurns} from './turns.mjs';
import {LiveTaskUpdates} from './task-updates.mjs';
import {LiveAnswers} from './answers.mjs';
import {speechBusy,speechRestarted,speechUpdate} from './speech-mode.mjs';
import {liveCallLog} from './call-log.mjs';
import {liveDebugLog,debugRecord} from './debug-log.mjs';

const defaults={create:10000,attach:5000,ready:10000,close:5000,poll:20000,peer:15000,cooldown:120000,cleanup:7200000,backoff:2000,rollover:60000,idleForRollover:20000,forceRollover:20000,snapshotRefresh:10000};
const positive=new Set(['session.started','session.resumed','session.paused','session.usage.updated','session.input_transcript.delta','session.output_transcript.delta','session.assistant_transcript.delta']);
const transcript=new Set(['session.input_transcript.delta','session.output_transcript.delta','session.assistant_transcript.delta']);
const expiry=value=>{
 if(typeof value==='number'&&Number.isFinite(value)&&value>0)return value<1e12?value*1000:value;
 const parsed=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(parsed)?parsed:null;
};
// The last sentence of Live's reply commits to work ("I'll get that moving", "Gotcha, I'll bake that in"), not an
// offer ("Want me to…?") or a promise to report back ("I'll tell you when it's done", "I'll share details once…").
const TURN_GAP=2500,BACKCHANNEL=/^(?:(?:mm+-?hmm+|mhm|uh-?huh|hmm+|mm+|okay|ok|yeah|yep|yes|right|sure|got it|gotcha)[,.!\s]*)+$/i;
const RESCUE_QUIET=3000,RESCUE_WINDOW=45000,REFRESH_AFTER_TALK=4000;
// Work verbs only (Neon review, 2026-11-26): "Let me explain", "I'll break it down" or "I'll note that" is talk, not work,
// and a rescue that starts a task nobody asked for is the worst way this can fail.
const WORK=String.raw`run|start|kick|spin|pull|check|look(?:\s+(?:that|it|this))?\s+(?:up|into)|research|dig into|draft|write|save|create|build|put together|pull together|make|add|fold|bake|include|update|edit|change|fix|cut|trim|shorten|tighten|rewrite|redo|compare|summari[sz]e|compile|find|search|grab|get (?:that|it|this|on it|started|going|moving)|work on|handle|take care of|set (?:that |it |this )?up|send|prepare|knock|whip|throw together|queue`;
const PROMISE=new RegExp(String.raw`\b(?:I['’]ll|I will|I['’]m going to|I['’]m gonna|let me)\s+(?:just |go |quickly |also |now |then |get to work and |go ahead and )?(?:${WORK})\b|\b(?:getting|starting|kicking|spinning|rolling)\s+(?:that|it|this|on|off|up)\b`,'i');
const REPORT_BACK=/\b(?:let you know|tell you|update you|ping you|hand (?:you|it|them) (?:over|back)|(?:when|once|as soon as) (?:it|that)(?:['’]s| is) (?:done|ready|up|back|finished|complete))\b/i;
export function livePromised(reply){
 const text=String(reply??'').replace(/\s+/g,' ').trim();
 if(!text||/\?["”’']?$/.test(text))return false;
 const last=text.split(/(?<=[.!])\s+/).filter(Boolean).at(-1)||'';
 if(REPORT_BACK.test(last))return false;
 return PROMISE.test(last)||/^(?:(?:sure|okay|ok|got it|yep|yes)[,.!\s]+)*on it[.!]*$/i.test(last);
}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}};
const sectionName=/^(About the user|Today|Work in progress|New vault notes|Numbers|News|Morning brief|Radar) \(/;
function sections(text){
 const blocks=String(text??'').split('\n\n');
 const about=blocks.findIndex(block=>block.startsWith('About the user (')),today=blocks.findLastIndex(block=>block.startsWith('Today ('));
 // Only About me can contain blank lines. Its prose can look like another section header.
 if(about>=0&&today>about)blocks.splice(about,today-about,blocks.slice(about,today).join('\n\n'));
 return blocks.filter(block=>sectionName.test(block));
}
const scheduleTimer=(run,ms)=>{
 const handle=setTimeout(run,ms);
 return ()=>clearTimeout(handle);
};
async function bounded(schedule,ms,message,run){
 const abort=new AbortController(),error=new Error(message);
 let cancel;
 try{return await Promise.race([Promise.resolve().then(()=>run(abort.signal)),new Promise((_,reject)=>{cancel=schedule(()=>{reject(error);abort.abort(error)},ms)})])}
 finally{cancel?.()}
}
export const liveSecret=()=>randomBytes(32).toString('hex');
export function sameLiveSecret(a,b){
 return typeof a==='string'&&typeof b==='string'&&/^[a-f0-9]{64}$/.test(a)&&/^[a-f0-9]{64}$/.test(b)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
}

export class LiveCalls {
 constructor({root,runtimeDir,ownerIsCurrent,prefs,provider,localBusy,holdAudio,releaseAudio,transport=createLiveTransport(),
  snapshot=liveSnapshot,history=liveHistory,tasks=()=>[],greeting=liveGreeting,now=Date.now,schedule=scheduleTimer,limits={},speechMode=null,authorization=()=>liveAuthorization(runtimeDir),key=()=>readLiveKey(runtimeDir),ownerDetail=null,log=runtimeDir?liveCallLog(runtimeDir):()=>{},surfaceAlive=ownerIsCurrent}){
  Object.assign(this,{root,ownerIsCurrent,prefs,provider,localBusy,holdAudio,releaseAudio,transport,snapshot,history,tasks,greeting,now,schedule,authorization,key,speechMode,ownerDetail,log,surfaceAlive});
  this.debugLog=liveDebugLog(runtimeDir);
  this.limits={...defaults,...limits};this.gen=0;this.call=null;this.replacement=null;this.last=null;this.stopping=false;this.recoveryBusy=null;this.closing=new Set();
  try{this.recovery=new LiveRecovery(runtimeDir);this.usage=new LiveUsage(runtimeDir)}catch{this.storageError=true}
 }
 get audioHeld(){return !!this.call?.localHeld}
 current(call){return call.state!=='closing'&&(this.call===call&&this.gen===call.gen||this.replacement===call&&this.call===call.from&&this.call?.state!=='closing')}
 async start({ownerSurface,appScope,sdp}){
  if(this.stopping||this.storageError)throw new Error('Live voice recovery is unavailable.');
  const auth=this.authorization();if(!auth.ready)throw new Error(auth.reason);
  const prefs=this.prefs();if(prefs.voiceMode!=='live')throw new Error('Select Live voice first.');
  if(!this.ownerIsCurrent(ownerSurface,appScope))throw new Error('Select this surface as the voice owner first.');
  if(this.localBusy())throw new Error('A Local voice request is still active.');
  if(this.call||this.replacement||this.recovery.cleanup.length||this.recovery.call?.id||this.recoveryBusy)throw new Error('Still closing the last Live call.');
  if(this.recovery.call?.cooldownUntil>this.now())throw new Error('Live voice is cooling down after an unconfirmed connection.');
  if(this.recovery.call?.attemptId){
   const {attemptId,startedAt}=this.recovery.call;
   this.usage.update(attemptId,startedAt,{seconds:15},'unconfirmed');this.recovery.record(null);
  }
  if(typeof sdp!=='string'||!sdp.trim()||sdp.length>100000)throw new Error('Invalid Live SDP offer.');
  const key=this.key();if(!key)throw new Error('Live voice needs current consent. Run aos openai-key.');
  const call=this.call={gen:++this.gen,ownerSurface,appScope,callSecret:liveSecret(),provider:this.provider(),state:'creating',startedAt:this.now(),
   callId:randomUUID(),life:new AbortController(),updates:new LiveUpdates(this.limits.poll),closed:deferred(),done:deferred(),seen:new Set(),localHeld:true,inputMuted:false};
  this.last=null;this.log({event:'start',call:call.callId.slice(0,8),appScope});
  try{
   await this.holdAudio();
   if(this.speechMode&&this.current(call))call.speechLease=await this.speechMode.acquire(call.life.signal);
   if(!this.current(call))throw new Error('Live call ended before connecting.');
   return await this.connectUpstream(call,sdp,prefs,key);
  }catch(error){
   call.attaching=false;await this.end(call,'Live call could not start.',key);
   const message=error?.message;
   throw new Error(['Live call ended before connecting.','Live connection could not be completed.','Live session creation was unconfirmed. Try again after the cooldown.','Live sideband attach timed out.',speechUpdate,speechBusy,speechRestarted].includes(message)||String(message).startsWith('OpenAI rejected the Live session request')?message:'Live call could not start.');
  }finally{call.done.resolve()}
 }
 readSnapshot(call,now,prefs){return this.snapshot(this.root,{now,tasks:()=>this.tasks(call.appScope),liveShareWork:prefs.liveShareWork,liveShareBrief:prefs.liveShareBrief})}
 async connectUpstream(call,sdp,prefs,key){
   const now=new Date(this.now()),snapshot=await this.readSnapshot(call,now,prefs);
   call.snapshotSections=sections(snapshot);call.refreshAt=this.now()+this.limits.snapshotRefresh;
   call.turns=new LiveTurns(call.startedAt);call.answers=new LiveAnswers(call);call.taskUpdates=new LiveTaskUpdates(call);
   call.requestWake=()=>this.wake(call);call.debugLog=record=>this.debugLog(call,record);call.clock=this.now;
   const history=call.from?call.from.transcriptTail||'':prefs.liveCarryToday?this.history(this.root,call.appScope,now):'';
   if(!this.current(call))throw new Error('Live call ended before connecting.');
   // Persist the cooldown marker before sending. A bridge crash in this
   // window has the same uncertainty as a lost HTTP response.
   call.attemptId='unknown-'+randomUUID();
   this.markUnconfirmedCreate(call,this.limits.create);
   let timedOut=false;
   let created;
   try{
    created=await bounded(this.schedule,this.limits.create,'Live session creation timed out.',signal=>{
     const result=this.transport.create(key,liveSessionBody({sdp,prefs,snapshot,history,continued:!!call.from}),signal);
     void Promise.resolve(result).then(late=>{if(timedOut&&validLiveSessionId(late?.id))void this.lateCreate(call,late.id,key)},()=>{});
     return result;
    });
   }catch(error){
    timedOut=true;
    if(error instanceof LiveCreateRejected)this.clearCreateMarker(call);
    else{this.markUnconfirmedCreate(call);this.usage.update(call.attemptId,call.startedAt,{seconds:15},'unconfirmed')}
    throw error instanceof LiveCreateRejected?new Error(error.message):new Error('Live session creation was unconfirmed. Try again after the cooldown.');
   }
   call.sessionId=created?.id;
   if(!validLiveSessionId(call.sessionId)){
    call.sessionId=null;this.markUnconfirmedCreate(call);this.usage.update(call.attemptId,call.startedAt,{seconds:15},'unconfirmed');throw new Error('Live session creation was unconfirmed. Try again after the cooldown.');
   }
   if(call.from){
    // Journal the replacement before attach while keeping the old ID as the
    // primary recovery record. A restart can close both sessions.
    this.recovery.enqueue({...this.recordFor(call),giveUpAt:this.now()+this.limits.cleanup,retryAt:this.now(),attempts:0});
    this.clearCreateMarker(call);
   }else this.recovery.record(this.recordFor(call));
   this.usage.update(call.sessionId,call.startedAt);
   if(!this.current(call)||typeof created.answerSdp!=='string'||!created.answerSdp.trim()||created.answerSdp.length>100000)throw new Error('Live connection could not be completed.');
   call.attaching=true;
   try{call.socket=await this.attach(call,key)}finally{call.attaching=false}
   if(call.attachLost){call.socket?.close();call.socket=null}
   if(!this.current(call)||call.remoteClosed||call.attachLost)throw new Error('Live call ended before connecting.');
   call.attached=true;call.state='active';
   if(call.from?.inputMuted){this.sendMute(call,true);call.inputMuted=true}
   this.ready(call);
   if(!call.ready)call.readyTimer=this.schedule(()=>{void this.end(call,'Live sideband did not become ready.')},this.limits.ready);
   call.peerTimer=this.schedule(()=>{if(!call.peerConnected)void this.end(call,'Live peer did not connect.')},this.limits.peer);
   return {answerSdp:created.answerSdp,callSecret:call.callSecret,gen:call.gen};
 }
 markUnconfirmedCreate(call,extra=0){
  const marker={cooldownUntil:this.now()+this.limits.cooldown+extra,attemptId:call.attemptId,startedAt:call.startedAt};
  if(call.from&&this.recovery.call?.id===call.from.sessionId)this.recovery.record({...this.recovery.call,replacementAttempt:marker});
  else this.recovery.record(marker);
 }
 clearCreateMarker(call){
  const stored=this.recovery.call;
  if(stored?.replacementAttempt?.attemptId===call.attemptId){const {replacementAttempt,...old}=stored;this.recovery.record(old)}
  else if(stored?.attemptId===call.attemptId)this.recovery.record(null);
 }
 async rollover(call,sdp){
  if(!this.current(call)||this.call!==call||!call.ready||!call.rolloverSent||call.rolloverAttempted||this.replacement)throw new Error('A Live rollover is not available.');
  if(typeof sdp!=='string'||!sdp.trim()||sdp.length>100000)throw new Error('Invalid Live SDP offer.');
  const key=this.key(),prefs=this.prefs();if(!key||prefs.voiceMode!=='live')throw new Error('Live voice is unavailable.');
  call.rolloverAttempted=true;
  const next=this.replacement={from:call,ownerSurface:call.ownerSurface,appScope:call.appScope,callSecret:call.callSecret,provider:call.provider,
   gen:this.gen+1,state:'creating',startedAt:this.now(),callId:call.callId,life:new AbortController(),closed:deferred(),done:deferred(),seen:new Set(),updates:call.updates,inputMuted:false,
   lastTranscriptAt:call.lastTranscriptAt,transcriptTail:call.transcriptTail};
  try{return await this.connectUpstream(next,sdp,prefs,key)}
  catch{await this.end(next,'The Live connection could not be renewed.',key);throw new Error('The Live connection could not be renewed.')}
  finally{next.done.resolve()}
 }
 // A task's news arrived while the call was in standby, which only the caller's voice wakes. Renew the call: the
 // fresh session starts awake and says the held news in Live's voice (task-updates.mjs). True when a renewal is
 // on its way; false sends the news to the caller's screen instead.
 wake(call){
  if(this.replacement?.from===call)return true;
  if(!this.current(call)||this.call!==call||!call.ready||!call.peerConnected||call.rolloverSent||call.from)return false;
  call.rolloverSent=true;call.wakeRollover=this.now();call.updates.push({type:'rollover'});return true;
 }
 // That renewal never came or failed: say the held news on screen, and let the 2-hour renewal run later as usual.
 wakeFailed(call){
  if(!call.wakeRollover)return;
  call.wakeRollover=null;call.rolloverSent=false;call.rolloverAttempted=false;
  call.taskUpdates?.wakeFailed();
 }
 routeGeneration(call,gen){
  if(gen===undefined||gen===call.gen)return call;
  const next=this.replacement;
  if(next?.from===call&&gen===next.gen&&this.current(next))return next;
  throw new Error('Live connection generation changed.');
 }
 peerConnected(call){
  if(!call.peerConnected&&call.turns&&!call.turns.rows.length)call.turns.startedAt=this.now();
  call.peerConnected=true;call.peerTimer?.();this.promote(call);this.greet(call);
 }
 promote(next){
  if(next!==this.replacement||!this.current(next)||!next.ready||!next.peerConnected)return;
  const old=next.from;
  this.recovery.enqueue({...this.recordFor(old),giveUpAt:this.now()+this.limits.cleanup,retryAt:this.now(),attempts:0});
  this.recovery.record(this.recordFor(next));this.recovery.forgetCleanup(next.sessionId);
  next.localHeld=true;old.localHeld=false;
  next.speechLease=old.speechLease;old.speechLease=null;
  for(const path of old.answers.reports)next.answers.reports.add(path);
  next.taskUpdates=old.taskUpdates;next.taskUpdates.call=next;next.taskUpdates.endTurn({});next.taskUpdates.release();
  next.taskUpdates.inputOffset=-Infinity;
  next.answers.held.push(...old.answers.held.filter(event=>event.delegation_id===null));
  next.leaseStartedAt=old.leaseStartedAt??old.startedAt;next.greeted=true;
  next.lastTranscriptAt=Math.max(old.lastTranscriptAt,next.lastTranscriptAt);
  next.previousIds=[...(old.previousIds||[]),old.sessionId];next.from=null;
  this.gen=next.gen;this.call=next;this.replacement=null;
  this.delegations?.clear(old);
  next.updates.push({type:'ready',gen:next.gen,paused:!!next.paused});
  // Media handoff keeps the registered surface and update cursor. The old
  // peer can release only after the new one has both sideband and ICE ready.
  old.state='closing';old.readyTimer?.();old.peerTimer?.();
  void this.end(old,'Live connection renewed.');
 }
 sendMute(call,muted){
  if(!call.socket||call.remoteClosed)throw new Error('Live sideband is unavailable.');
  call.socket.send({type:muted?'session.input_audio.mute':'session.input_audio.unmute'});
 }
 mute(call,muted){
  if(!this.current(call)||typeof muted!=='boolean')throw new Error('Live microphone setting is unavailable.');
  this.sendMute(call,muted);call.inputMuted=muted;
  const next=this.replacement;
  if(next?.from===call&&next.socket&&this.current(next)){
   try{this.sendMute(next,muted);next.inputMuted=muted}
   catch{void this.end(next,'The Live microphone setting could not transfer.')}
  }
 }
 recordFor(call){return {id:call.sessionId,startedAt:call.startedAt,expiresAt:call.expiresAt??null}}
 attach(call,key){
  return bounded(this.schedule,this.limits.attach,'Live sideband attach timed out.',signal=>this.transport.attach(key,call.sessionId,{signal,
   onEvent:event=>{try{this.event(call,event)}catch{if(this.current(call))void this.end(call,'Live call state could not be saved.');else call.closed.resolve(false)}},
   onLoss:()=>{call.socket=null;if(this.current(call)){if(call.attaching)call.attachLost=true;else void this.end(call,'Live sideband disconnected.')}else call.closed.resolve(false)}
  }));
 }
 ready(call){
  if(!this.current(call)||!call.attached||!call.positive||call.ready)return;
  call.readyTimer?.();call.ready=true;call.lastTranscriptAt??=this.now();
  if(call===this.replacement)this.promote(call);
  else{call.updates.push({type:'ready',paused:!!call.paused});this.greet(call)}
 }
 // Once per call the user started, when both the session and the audio are up. Never for a rollover
 // replacement (it has `from`), after standby, or when the user turned the greeting off.
 greet(call){
  if(call.greeted||call.from||call!==this.call||!this.current(call)||!call.ready||!call.peerConnected||call.paused)return;
  call.greeted=true;
  let on=true;try{on=this.prefs().liveGreeting!==false}catch{}
  if(!on)return;
  try{call.answers?.append('commentary',null,greetingCue(this.greeting(this.root)))}catch{}
 }
 event(call,event){
  if(!event||typeof event.event_id!=='string'||!event.event_id||event.event_id.length>256||event.session_id&&event.session_id!==call.sessionId||event.session?.id&&event.session.id!==call.sessionId||call.seen.has(event.event_id))return;
  call.seen.add(event.event_id);
  if(call.seen.size>8192)call.seen.delete(call.seen.values().next().value);
  if(event.type==='session.closed'){
   call.remoteClosed=true;call.closed.resolve(true);
   this.usage.update(call.sessionId,call.startedAt,event.usage,event.usage?'final':'unconfirmed');
   if(this.current(call)&&!call.attaching)void this.end(call,'Live session ended.');
   return;
  }
  if(call.remoteClosed)return;
  {const record=debugRecord(event);if(record)call.debugLog?.(record)}
  call.answers?.acknowledge(event);
  if(event.type==='session.started'){
   const at=expiry(event.expires_at??event.session?.expires_at);
   if(at!==null){
    call.expiresAt=at;
    if(this.recovery.call?.id===call.sessionId)this.recovery.record({...this.recovery.call,expiresAt:at});
    else if(call===this.replacement){
     const row=this.recovery.cleanup.find(item=>item.id===call.sessionId);
     if(row)this.recovery.enqueue({...row,expiresAt:at});
    }
   }
  }
  if(event.type==='session.usage.updated')this.usage.update(call.sessionId,call.startedAt,event.usage);
  if(!this.current(call))return;
  if(transcript.has(event.type)){
   call.lastTranscriptAt=this.now();
   const row=call.turns?.add(event,this.now());
   if(row){call.taskUpdates?.transcript(row);call.transcriptTail=((call.transcriptTail||'')+row.text).slice(-2200);this.heard(call,row);this.delegations?.fragment(call,row)}
  }
  if(event.type==='session.delegation.created'){call.delegatedAt=this.now();call.liveAcked=false;call.ackText=''}
  if(['session.input_transcript.done','session.input_transcript.completed','session.input_audio_buffer.speech_stopped','input_audio_buffer.speech_stopped','session.delegation.created','session.paused'].includes(event.type))call.taskUpdates?.endTurn(event);
  if(event.type==='session.paused'||event.type==='session.resumed'){
   call.paused=event.type==='session.paused';if(!call.from)call.updates.push({type:call.paused?'paused':'resumed'});
   if(!call.paused)call.answers?.resume({tasks:false});
  }
  if(positive.has(event.type)){call.positive=true;this.ready(call)}
  if(!call.from&&event.type==='session.delegation.created'&&typeof event.delegation?.id==='string'&&event.delegation.id.length>0&&event.delegation.id.length<=256){
   const mapKey=JSON.stringify([call.sessionId,event.delegation.id]);
   if(this.recovery.delegations.has(mapKey))return;
   const id=this.recovery.register(call.sessionId,event.delegation.id);
   this.delegations?.receive(call,event,id);
  }
 }
 // Who spoke last, and what Live said back to the caller's latest words: for the promise check below, for holding
 // task news while Live is mid-sentence (task-updates.mjs), and for not doubling Live's own acknowledgement.
 heard(call,row){
  const now=this.now();
  if(row.user){
   if(row.text.trim()){
    // A new turn starts after a quiet gap; words that run on from a hand-off are the same turn (no second rescue for them).
    if(!(now-(call.heardAt??-Infinity)<=TURN_GAP))call.turnStartAt=now;
    call.heardAt=now;call.heardOffset=row.offset;call.liveReply='';call.ackText='';call.liveAcked=false;
   }
   return;
  }
  call.liveSaidAt=now;
  // An acknowledgement is a few words of its own, not a lone "Mm-hmm" while the caller talks (Neon review, 2026-11-26).
  call.ackText=((call.ackText||'')+row.text).slice(-400);
  call.liveAcked=!BACKCHANNEL.test(call.ackText.trim())&&call.ackText.trim().split(/\s+/).length>=2;
  if(call.heardAt!==undefined)call.liveReply=((call.liveReply||'')+row.text).slice(-1200);
 }
 // Live said it would do something and never handed it off (2026-11-26 test calls: "Sure, I'll get that moving", then
 // nothing ran, twice). Once Live has finished that reply and no hand-off came, V2 takes the caller's words itself.
 rescue(call,now){
  if(!this.delegations||call.from||call.heardAt===undefined||call.rescuedFor===call.heardAt||!call.liveReply)return;
  if(call.delegatedAt>=(call.turnStartAt??call.heardAt)||call.commentedAt>=call.heardAt||call.routing||call.staged||call.supersededHandoff||call.taskUpdates?.inputOpen)return;
  if(now-call.liveSaidAt<RESCUE_QUIET||now-call.heardAt>RESCUE_WINDOW||!livePromised(call.liveReply))return;
  call.rescuedFor=call.heardAt;
  this.delegations.rescue(call,call.heardOffset);
 }
 hotkey(){const call=this.call;if(call?.localHeld&&call.ready&&this.current(call))call.updates.push({type:'hotkey'})}
 speechBoot(bootId){
  const call=this.call;
  if(call?.speechLease&&bootId!==call.speechLease.bootId&&this.current(call))void this.invalidate(speechRestarted);
 }
 completion(item){
  const call=this.call;
  if(call?.localHeld&&this.current(call)&&item.appScope===call.appScope&&['completion','completion-error','attention','error'].includes(item.kind))
   call.taskUpdates?.receive(item,this.prefs(),this.now());
 }
 refreshSnapshot(call){
  if(!call.ready||!call.answers||call.routing||call.staged||call.refreshing||this.localBusy()||this.now()<call.refreshAt)return;
  // Not in standby (an update sent then is held, and was refused when the call ended: 2026-11-26), and not while
  // the caller is talking or Live is answering, where it got in the way of a hand-off. The next quiet moment sends it.
  if(call.paused||call.taskUpdates?.inputOpen||this.now()-(call.heardAt??-Infinity)<REFRESH_AFTER_TALK||this.now()-(call.liveSaidAt??-Infinity)<REFRESH_AFTER_TALK)return;
  call.refreshAt=this.now()+this.limits.snapshotRefresh;call.refreshing=true;
  void Promise.resolve().then(()=>this.readSnapshot(call,new Date(this.now()),this.prefs())).then(snapshot=>{
   if(!this.current(call)||call.routing||call.staged||call.paused||this.localBusy())return;
   // The whole brief is too long for one update, so a change to it is reported, not resent.
   // A section counts as changed only for what it says, not for the minutes ticking on a task's age (2026-11-26 test
   // calls: the work list was resent every minute, each update kept the call out of standby, and Live read them out).
   const stable=section=>section.replace(/, \d+ (?:min|h)\)/g,')'),before=new Set(call.snapshotSections.map(stable));
   const next=sections(snapshot),changed=next.filter(section=>!before.has(stable(section)))
    .map(section=>section.startsWith('Morning brief (')?section.split('\n')[0]+'\nThis note changed during the call, so the copy from the start of the call may be out of date.':section);
   for(const name of ['About the user','Work in progress','Morning brief']){
    if(call.snapshotSections.some(section=>section.startsWith(name+' ('))&&!next.some(section=>section.startsWith(name+' (')))
     changed.push(`${name} is no longer in the vault snapshot. Stop using the earlier entries from that section.`);
   }
   call.snapshotSections=next;
   // One update per changed section, each within OpenAI's size limit: an update over it is rejected and Live keeps the old reading.
   // Reference for later questions, not news: Live mentions it only if asked (it was reading these out unprompted).
   const note="Background refresh of the snapshot, for reference only. Don't bring it up unless the user asks about it.\n";
   for(const part of changed.flatMap(section=>appendParts(section,APPEND_MAX_BYTES-Buffer.byteLength(note))))call.answers.append('thinking',null,note+part,APPEND_MAX_BYTES);
  }).catch(()=>{}).finally(()=>{call.refreshing=false});
 }
 renewSpeech(call){
  const lease=call.speechLease;
  if(!lease||lease.renewing||!this.speechMode.due(lease))return;
  lease.renewing=true;
  void this.speechMode.renew(lease).catch(()=>{
   const owner=this.call;if(owner?.speechLease!==lease||!this.current(owner))return;
   void this.invalidate(speechRestarted);
  }).finally(()=>{lease.renewing=false});
 }
 // Live persists across Claude/Codex switches (Chase, 2026-11-22). New hand-offs go to the new provider, work already
 // running finishes where it started, and an action waiting for a yes was planned for the old provider, so it is cancelled.
 switchProvider(call,provider){
  if(!this.current(call)||call.provider===provider)return;
  call.provider=provider;if(this.replacement?.from===call)this.replacement.provider=provider;
  this.delegations?.clear(call,'staged-cancelled');
  call.answers?.append('thinking',null,`The user switched hand-offs to ${provider==='codex'?'Codex':'Claude'}. New requests go there; work already running continues where it started.`);
 }
 invalidate(reason){
  const call=this.call;if(!call||call.state==='closing')return Promise.resolve();
  const wasConnecting=call.state==='creating';
  this.releaseLocal(call,reason);
  const next=this.replacement;
  if(next){
   if(next.state==='creating')this.releaseLocal(next,reason);
   else void this.end(next,reason);
  }
  // An in-flight create or attach is allowed to settle so a late ID/socket
  // can be closed. start() owns cleanup until it returns an SDP.
  return wasConnecting?Promise.resolve():this.end(call,reason);
 }
 // Reasons and timings only (runner/live/call-log.mjs), so a call that ended on its own can be explained afterwards.
 logEnd(call,reason){
  const now=this.now(),seconds=at=>Number.isFinite(at)?Math.round((now-at)/1000):null;
  this.log({event:'end',call:call.callId?.slice(0,8)??null,appScope:call.appScope,reason:String(reason??'unknown'),...(call.from?{replacement:true}:{}),
   secondsIn:seconds(call.startedAt),sinceSpeech:seconds(call.lastTranscriptAt),ready:!!call.ready,paused:!!call.paused,...(call.ownerDetail?{owner:call.ownerDetail}:{})});
 }
 releaseLocal(call,reason){
  if(call.state!=='closing'){call.state='closing';if(this.call===call)this.gen++;this.logEnd(call,reason)}
  call.readyTimer?.();call.peerTimer?.();
  call.life?.abort();this.delegations?.close(call);
  if(call.speechLease){
   // Keep capture suppressed until the upstream mic is muted on teardown.
   if(!call.inputMuted)try{this.sendMute(call,true)}catch{}
   call.speechRelease=this.speechMode.release(call.speechLease);call.speechLease=null;
  }
  if(call.localHeld){call.localHeld=false;call.updates.push({type:'teardown',reason});try{this.releaseAudio()}catch{}}
 }
 end(call,reason,key=this.key()){
  this.releaseLocal(call,reason);
  if(!call.ending)call.ending=this.finish(call,key);
  return call.ending;
 }
 async finish(call,key){
  if(call.sessionId)this.closing.add(call.sessionId);
  try{
   if(call.sessionId){
    const row=this.recordFor(call),existing=this.recovery.cleanup.find(item=>item.id===row.id);
    const saved={...row,giveUpAt:existing?.giveUpAt??this.now()+this.limits.cleanup,retryAt:this.now(),attempts:existing?.attempts??0};
    this.recovery.enqueue(saved);
    await this.closeKnown(call,saved,key);
   }
  }catch{
   // Keep the slot fail-closed if its recovery record could not be written.
   this.storageError=true;
  }finally{
   await call.speechRelease;
   if(call.sessionId)this.closing.delete(call.sessionId);
   call.socket?.close();
   if(this.replacement===call){
    this.replacement=null;
    if(this.call===call.from&&this.current(call.from)){call.updates.push({type:'rollover-failed'});this.wakeFailed(call.from)}
   }
   if(this.call===call){this.call=null;this.last={call,until:this.now()+60000}}
  }
 }
 async closeKnown(call,row,key){
  if(this.expired(call)||call.remoteClosed){this.resolveKnown(row);return}
  try{
   if(!key)throw new Error('Live key unavailable.');
   if(!call.socket){call.closed=deferred();call.socket=await this.attach(call,key)}
   if(!call.remoteClosed){
    call.socket.send({type:'session.close'});
    if(!await bounded(this.schedule,this.limits.close,'Live close timed out.',()=>call.closed.promise))throw new Error('Live sideband disconnected.');
   }
   this.resolveKnown(row);
  }catch{
   const attempts=(row.attempts||0)+1;
   this.recovery.enqueue({...row,expiresAt:call.expiresAt??row.expiresAt,attempts,retryAt:this.now()+Math.min(60000,this.limits.backoff*2**Math.min(attempts-1,10))});
  }finally{call.socket?.close();call.socket=null}
 }
 expired(call){return call.expiresAt!=null&&call.expiresAt<=this.now()}
 resolveKnown(row){
  this.usage.update(row.id,row.startedAt,undefined,'unconfirmed');this.recovery.remove(row.id);
 }
 async lateCreate(call,id,key){
  try{
   const row={id,startedAt:call.startedAt,expiresAt:null,giveUpAt:this.now()+this.limits.cleanup,retryAt:this.now(),attempts:0};
   if(call.from)this.clearCreateMarker(call);
   else if(this.recovery.call?.attemptId===call.attemptId)this.recovery.record(row);
   this.recovery.enqueue(row);
   this.usage.reidentify(call.attemptId,id,call.startedAt);
   this.sweep();
  }catch{this.storageError=true}
 }
 sweep(){
  if(this.storageError)return;
  const call=this.call,now=this.now();
  if(call&&this.current(call)){
   let prefs,ownerCurrent=false;
   // A call ends on End call, on the idle limit the user chose, or when its own window closes (Chase,
   // 2026-11-22); also on a voice-mode switch in settings or a failed renewal. Another window taking voice focus
   // or a late check-in while the user is clearly still working never ends it.
   try{prefs=this.prefs();ownerCurrent=this.surfaceAlive(call.ownerSurface,call.appScope)&&prefs.voiceMode==='live'}catch{}
   if(!ownerCurrent){
    // Which check failed, so the hang-up names its cause in live-calls.jsonl.
    try{call.ownerDetail={...this.ownerDetail?.(call.ownerSurface,call.appScope),voiceMode:prefs?.voiceMode??'unreadable'}}catch{}
    void this.invalidate(prefs?.voiceMode&&prefs.voiceMode!=='live'?'Voice mode changed in settings.':'The call window disconnected.');
   }
   else if(this.expired(call))void this.invalidate('Live session expired.');
   else if(call.ready&&now-call.lastTranscriptAt>=prefs.liveIdleHangupMin*60000)void this.invalidate('Live call ended after inactivity.');
   // Renew before the 2-hour expiry: during a pause when possible, and regardless in the last 20 seconds, so a
   // long conversation is never cut off mid-sentence.
   else if(call.ready&&!call.rolloverSent&&call.expiresAt!=null&&call.expiresAt-now<=this.limits.rollover&&(call.paused||now-call.lastTranscriptAt>=this.limits.idleForRollover||call.expiresAt-now<=this.limits.forceRollover)){
    call.rolloverSent=true;call.updates.push({type:'rollover'});
   }
   if(this.current(call)){
    // A renewal asked for to say task news must be under way within 15 seconds, or the screen says it.
    if(call.wakeRollover&&!this.replacement&&now-call.wakeRollover>=15000)this.wakeFailed(call);
    if(call.ready)call.taskUpdates?.flush(prefs,now,()=>this.tasks(call.appScope));
    if(call.ready&&!call.paused){this.delegations?.retakeSuperseded(call,now);this.rescue(call,now)}
    this.renewSpeech(call);this.refreshSnapshot(call);
   }
  }
  if(this.last?.until<=now)this.last=null;
  if(!this.replacement&&!this.recoveryBusy){
   try{
    const stored=this.recovery.call;
    if(!this.call){
     if(stored?.attemptId)this.usage.update(stored.attemptId,stored.startedAt,{seconds:15},'unconfirmed');
     if(stored?.cooldownUntil<=now)this.recovery.record(null);
     if(stored?.id&&!this.recovery.cleanup.some(row=>row.id===stored.id))this.recovery.enqueue({...stored,giveUpAt:now+this.limits.cleanup,retryAt:now,attempts:0});
    }
    // Retrying a superseded session must neither close the replacement nor
    // race a close already in progress.
    const row=this.recovery.cleanup.find(row=>row.id!==this.call?.sessionId&&!this.closing.has(row.id)&&
     (row.retryAt<=now||row.giveUpAt<=now||row.expiresAt!=null&&row.expiresAt<=now));
    if(row){
     if(row.giveUpAt<=now||row.expiresAt!=null&&row.expiresAt<=now)this.resolveKnown(row);
     else{
      const recovery={sessionId:row.id,startedAt:row.startedAt,expiresAt:row.expiresAt,state:'closing',seen:new Set(),closed:deferred()};
      this.recoveryBusy=this.closeKnown(recovery,row,this.key()).catch(()=>{this.storageError=true}).finally(()=>{this.recoveryBusy=null});
     }
    }
   }catch{this.storageError=true}
  }
  return this.recoveryBusy;
 }
 owner(surface,scope,secret){
  const call=this.call||this.last?.call;
  return call&&call.appScope===scope&&call.ownerSurface===surface&&sameLiveSecret(call.callSecret,secret)?call:null;
 }
 status(call){
  const active=this.call?.localHeld?this.call:null,usage=this.usage?.month(this.now())??null;
  if(call){
   const rows=[...(call.previousIds||[]),call.sessionId].map(id=>this.usage?.rows.get(id)).filter(Boolean);
   return {state:call.state,ready:!!call.ready,paused:!!call.paused,gen:call.gen,startedAt:call.leaseStartedAt??call.startedAt,expiresAt:call.expiresAt??null,
    cost:rows.length?{label:'Live voice session cost, est.',seconds:rows.reduce((sum,row)=>sum+row.seconds,0),usd:rows.reduce((sum,row)=>sum+liveEstimate(row),0)}:null,monthToDate:usage};
  }
  return active?{state:'in-progress',message:`Live call in ${active.appScope==='native'?'Obsidian':'HUD'}`}:{state:'idle',monthToDate:usage};
 }
 async shutdown(){
  this.stopping=true;const call=this.call,next=this.replacement;
  if(!call)return this.recoveryBusy;
  await this.invalidate('Bridge is shutting down.');
  await Promise.all([call.done.promise,next?.done.promise,next?.ending,this.recoveryBusy]);
 }
}
