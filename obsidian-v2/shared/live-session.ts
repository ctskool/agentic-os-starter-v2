import {VOICE_MIC_CONSTRAINTS} from './voice-turn-taking';
import {LivePeer} from './live-peer';
import {jsonPost,liveJSON,LiveHttpError,readSurfaceEvents,registeredStream,type LiveFetch,type LiveScope,type LiveSurfaceLease} from './live-surface';
import type {VoicePrefs} from './voice-prefs';
import type {VoiceReply,VoiceSelection} from './voice-session';
import {ArtifactDelivery,type ArtifactOpener} from './artifact-delivery';

export type LiveState='idle'|'connecting'|'listening'|'speaking'|'standby'|'muted';
// The output level dips to near zero between words. Holding "speaking" for a moment after the last loud
// sample keeps the orb from flipping to "listening" several times a second while Live talks.
export const SPEAKING_LEVEL=.045,SPEAKING_HOLD_MS=800;
export function speakingHold(until:number,level:number,now:number){
 const next=level>SPEAKING_LEVEL?now+SPEAKING_HOLD_MS:until;
 return {until:next,speaking:now<next};
}
export interface StagedAction {actionId:string;description:string;mode:'auto'|'voice'|'click';expiresAt:number}
export interface LiveCompletion {seq:number;taskId:string|null;label:string;text:string}
export interface LiveSnapshot {
 state:LiveState; ready:boolean; unavailable:string|null; occupied:string|null;
 startedAt:number|null; cost:number|null; staged:StagedAction|null;micMuted:boolean;
 completions?:LiveCompletion[];
}
export const initialLive:LiveSnapshot={state:'idle',ready:false,unavailable:null,occupied:null,startedAt:null,cost:null,staged:null,micMuted:false};
type PeerStage={peer:LivePeer;gen:number|null;connected:boolean;ready:boolean;timer?:ReturnType<typeof setTimeout>};
type Options={
 scope:LiveScope;fetch:LiveFetch;getSelection:()=>Promise<VoiceSelection>;heartbeat?:(tick:()=>void)=>()=>void;
 media?:(constraints:MediaStreamConstraints)=>Promise<MediaStream>;peer?:()=>RTCPeerConnection;
 audio?:()=>HTMLAudioElement;audioContext?:()=>AudioContext;visible?:()=>boolean;
 wait?:(ms:number,signal:AbortSignal)=>Promise<void>;
};
type Call={abort:AbortController;stream:AbortController;lease:LiveSurfaceLease|null;reader:ReadableStreamDefaultReader<Uint8Array>|null;
 secret:string|null;gen:number|null;peer:PeerStage|null;next:PeerStage|null;audio:HTMLAudioElement|null;audioContext:AudioContext|null;
 cursor:number;muted:boolean;standbyMuted:boolean;standbyWake:boolean;muteRevision:number;mutePending:boolean;dirty:boolean;context:Promise<void>|null;lastContext:string|null;lastBeat:number;
 artifacts?:ArtifactDelivery;artifactBusy?:boolean;speakingUntil?:number};
function delay(ms:number,signal:AbortSignal){
 return new Promise<void>(resolve=>{
  const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve()};
  const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();
 });
}
const inBrowser=()=>typeof window!=='undefined'&&typeof document!=='undefined';
const runtimeOK=()=>typeof RTCPeerConnection!=='undefined'&&Boolean(globalThis.navigator?.mediaDevices?.getUserMedia);

export class LiveSession {
 private snapshot:LiveSnapshot=initialLive;
 private listeners=new Set<(value:LiveSnapshot)=>void>();
 private prefs:Partial<VoicePrefs>={};
 private call:Call|null=null;
 private disposed=false;
 private stopTimer:(()=>void)|null=null;
 private statusBusy=false;
 private heartbeatBusy=false;
 private paused=false;
 private stageTimer:ReturnType<typeof setTimeout>|undefined;
 private levelTimer:ReturnType<typeof setInterval>|undefined;
 private muteQueue=Promise.resolve();
 onError:(message:string)=>void=()=>{};
 onEffect:(reply:Partial<VoiceReply>)=>void|Promise<void>=()=>{};
 onStopLocalAudio:()=>void=()=>{};
 // What a hand-off is doing, for a surface that shows it beside the call.
 onActivity:(item:LiveActivity)=>void=()=>{};
 onArtifact?:ArtifactOpener;
 constructor(private options:Options){}
 getSnapshot=()=>this.snapshot;
 subscribe=(fn:(value:LiveSnapshot)=>void)=>{this.listeners.add(fn);fn(this.snapshot);return()=>{this.listeners.delete(fn)}};
 getLevel=()=>this.call?.peer?.peer.getLevel()??null;
 isActive=()=>this.call!==null;
 surfaceHeaders(){
  const call=this.call;if(!call?.lease||!call.secret||!this.snapshot.ready)return undefined;
  return {'X-V2-Surface':call.lease.surfaceId,'X-V2-Surface-Secret':call.lease.surfaceSecret};
 }
 private publish(changes:Partial<LiveSnapshot>){
  const next={...this.snapshot,...changes};
  if((Object.keys(changes) as (keyof LiveSnapshot)[]).every(key=>next[key]===this.snapshot[key]))return;
  this.snapshot=next;for(const fn of this.listeners)fn(next);
 }
 configure(prefs:Partial<VoicePrefs>){
  const changed=prefs.voiceMode!==this.prefs.voiceMode,idleChanged=prefs.liveIdleMic!==this.prefs.liveIdleMic;this.prefs=prefs;
  if(this.call&&prefs.voiceMode!=='live')void this.stop(false,'voice mode changed to '+(prefs.voiceMode||'unknown'));
  else if(this.call?.secret&&this.paused&&idleChanged&&!this.call.standbyWake){
   this.call.standbyMuted=prefs.liveIdleMic==='muted'&&!this.call.muted;void this.syncMute(this.call);
  }
  if(changed&&prefs.voiceMode)void this.refreshStatus();
 }
 connect(){
  if(this.stopTimer||!inBrowser())return;
  if(this.options.heartbeat)this.stopTimer=this.options.heartbeat(this.tick);
  else{const timer=setInterval(this.tick,4000);this.stopTimer=()=>clearInterval(timer)}
  document.addEventListener('visibilitychange',this.tick);window.addEventListener('focus',this.tick);
  window.addEventListener('pagehide',this.pagehide);
  this.tick();
 }
 private pagehide=()=>{void this.stop(true,'page closed or reloaded')};
 private tick=()=>{void this.refreshStatus();if(this.call?.lease)void this.heartbeat(this.call)};
 async refreshStatus(){
  if(this.statusBusy||this.disposed||!this.prefs.voiceMode)return;
  this.statusBusy=true;const call=this.call;
  try{
   const value=await liveJSON(this.options.fetch,'/voice/live/status',{headers:this.auth(call),signal:AbortSignal.timeout(5000)});
   if(this.disposed||this.call!==call)return;
   const capable=this.options.media||runtimeOK();
   this.publish({occupied:!call&&value?.state==='in-progress'?String(value.message):null,
    unavailable:!capable?'Live voice needs WebRTC and microphone access in this window.':value?.authorization?.ready===false?String(value.authorization.reason||'Live voice is unavailable.'):null,
    ...(call&&typeof value?.cost?.usd==='number'?{cost:value.cost.usd}:{})});
   if(call?.secret&&['idle','in-progress'].includes(value?.state))this.lost(call,'The bridge ended this Live call.');
  }catch(error){
   if(!this.disposed&&!this.call)this.publish({occupied:null,unavailable:'Live voice status is unavailable.'});
  }finally{this.statusBusy=false}
 }
 private visible(){return this.options.visible?.()??(!inBrowser()||!document.hidden)}
 private auth(call:Call|null){
  if(!call?.lease)return {};
  return {'X-V2-Surface':call.lease.surfaceId,'X-V2-Surface-Secret':call.lease.surfaceSecret,...(call.secret?{'X-V2-Call':call.secret}:{})};
 }
 private active(call:Call){return this.call===call&&!call.abort.signal.aborted}
 private check(call:Call){if(!this.active(call))throw new Error('Live voice was interrupted.')}
 private request(call:Call,path:string,body?:unknown){
  const timeout=path.startsWith('/voice/live/updates?')?26000:path==='/voice/live/start'?52000:path==='/voice/live/rollover'?35000:5000;
  const signal=AbortSignal.any([call.abort.signal,AbortSignal.timeout(timeout)]);
  const options={headers:this.auth(call),signal};
  return liveJSON(this.options.fetch,path,body===undefined?options:jsonPost(body,options));
 }
 private async register(call:Call){
  const signal=call.abort.signal,wait=this.options.wait??delay;
  for(let attempt=0;attempt<4;attempt++){
   this.check(call);
   try{
    const lease=await liveJSON(this.options.fetch,'/voice/surface/register',jsonPost({},{signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])}));
    if(typeof lease?.surfaceId!=='string'||typeof lease?.surfaceSecret!=='string')throw new Error('Invalid Live surface registration.');
    this.check(call);call.lease=lease;
    // Its own signal: on hang-up the stream closes only after the stop request, so the bridge logs the real reason.
    call.reader=await registeredStream(this.options.fetch,lease,call.stream.signal);
    this.check(call);
    void readSurfaceEvents(call.reader,event=>this.surfaceEvent(call,event)).then(
     ()=>this.lost(call,'Live voice connection was lost.'),()=>this.lost(call,'Live voice connection was lost.'));
    return;
   }catch(error){
    const lease=call.lease;call.lease=null;
    if(lease)void this.leave(lease);
    if(!this.active(call)||attempt===3)throw error;
    // A 401 or a closed stream invalidates the surface lease. Every retry
    // registers anew so it cannot accidentally act as a Local surface.
    await wait(250*2**attempt,signal);
   }
  }
 }
 private surfaceEvent(call:Call,event:any){
  if(!this.active(call))return;
  if(event?.type==='stop-audio')this.onStopLocalAudio();
  if(event?.type==='capture-request'&&event.client===call.lease?.surfaceId&&call.standbyMuted)void this.setMuted(false);
  if(event?.type==='pending')void this.artifactTick(call);
  // Another window taking voice focus no longer ends a call: only End call does (Chase, 2026-11-22).
 }
 private presence(call:Call,focus=false){
  return this.request(call,'/voice/surface',{id:call.lease?.surfaceId,kind:this.options.scope,visible:this.visible(),mode:'live',liveState:this.snapshot.state,focus,claim:false,canPlay:false});
 }
 private async heartbeat(call:Call){
  // A late check-in (a background tab, a busy machine) never ends the call; it just checks in again. Only a
  // bridge that no longer knows the call (401/403) or this surface (400) does.
  if(!this.active(call)||!call.lease||!call.lastBeat)return;
  if(this.heartbeatBusy)return;
  this.heartbeatBusy=true;
  try{await this.presence(call);if(this.active(call)){call.lastBeat=Date.now();void this.artifactTick(call)}}
  catch(error){if(error instanceof LiveHttpError&&[400,401,403].includes(error.status))this.lost(call,'Live voice connection was lost.')}
  finally{this.heartbeatBusy=false}
 }
 // The orb and the voice hotkey start a call or wake a muted one. They never end it: only End call (stop) does.
 async toggle(){
  if(this.call?.standbyMuted){await this.setMuted(false);return}
  if(this.call)return;
  await this.start();
 }
 async start(){
  if(this.disposed||this.call||!this.visible()||this.prefs.voiceMode!=='live'||this.snapshot.occupied)return;
  if(this.snapshot.unavailable){this.onError(this.snapshot.unavailable);return}
  const call:Call={abort:new AbortController(),stream:new AbortController(),lease:null,reader:null,secret:null,gen:null,peer:null,next:null,audio:null,audioContext:null,cursor:0,
   muted:false,standbyMuted:false,standbyWake:false,muteRevision:0,mutePending:false,dirty:false,context:null,lastContext:null,lastBeat:0};
  this.call=call;this.paused=false;this.publish({state:'connecting',ready:false,startedAt:Date.now(),cost:null,staged:null,completions:undefined});
  try{
   const context=call.audioContext=this.options.audioContext?.()??new AudioContext();
   void context.resume().catch(()=>{});
   call.audio=this.options.audio?.()??document.createElement('audio');
   call.audio.autoplay=true;call.audio.setAttribute('playsinline','');
   this.onStopLocalAudio();
   const mic=await (this.options.media?.(VOICE_MIC_CONSTRAINTS)??navigator.mediaDevices.getUserMedia(VOICE_MIC_CONSTRAINTS));
   mic.getAudioTracks().forEach(track=>{track.enabled=false});
   if(!this.active(call)){mic.getTracks().forEach(track=>track.stop());return}
   call.peer=this.makePeer(call,mic);
   await this.options.getSelection();this.check(call); // Native vault identity and pending selection are checked before start.
   await this.register(call);this.check(call);
   const open=this.onArtifact;
   if(open&&call.lease)call.artifacts=new ArtifactDelivery((path,body)=>this.request(call,path,body),call.lease.surfaceId,
    ()=>this.active(call)&&this.snapshot.ready&&this.visible(),open,this.onError);
   await this.presence(call,true);call.lastBeat=Date.now();
   await this.connectPeer(call,call.peer);
   void this.updates(call);
  }catch(error){
   if(!this.active(call))return;
   const named=error as {name?:string;message?:string};
   this.lost(call,named.name==='NotAllowedError'?'Microphone access was denied. Allow it for this app and try again.':named.message||'Live voice could not start.');
  }
 }
 private async artifactTick(call:Call){
  if(!this.active(call)||!call.artifacts||call.artifactBusy)return;
  call.artifactBusy=true;
  try{await call.artifacts.tick({visible:this.visible(),mode:'idle'})}catch{}
  finally{call.artifactBusy=false}
 }
 private makePeer(call:Call,stream:MediaStream){
  let stage:PeerStage;let connection:RTCPeerConnection|undefined;
  try{
   connection=this.options.peer?.()??new RTCPeerConnection();
   const peer=new LivePeer({stream,connection,context:call.audioContext!,audio:call.audio!,
    onPlaying:()=>this.measure(call),onError:message=>this.lost(call,message),
    onState:()=>void this.peerState(call,stage),
    onStandby:paused=>{if(this.active(call)&&call.peer===stage&&stage.ready)this.standby(call,paused)}});
   return stage={peer,gen:null,connected:false,ready:false};
  }catch(error){connection?.close();stream.getTracks().forEach(track=>track.stop());throw error}
 }
 private async connectPeer(call:Call,stage:PeerStage,rollover=false){
  const sdp=await stage.peer.offer(call.abort.signal);this.check(call);
  const lease=call.lease!;
  const reply=await this.request(call,rollover?'/voice/live/rollover':'/voice/live/start',{...lease,sdp});this.check(call);
  if(typeof reply?.answerSdp!=='string'||typeof reply?.callSecret!=='string'||!Number.isSafeInteger(reply.gen))throw new Error('The bridge returned an invalid Live answer.');
  stage.gen=reply.gen;call.secret=reply.callSecret;if(!rollover)call.gen=stage.gen;
  await stage.peer.answer(reply.answerSdp);this.check(call);
  if(!rollover){stage.peer.select();this.pushContext()}
  await this.peerState(call,stage);
 }
 private async peerState(call:Call,stage:PeerStage){
  if(!stage||!this.active(call)||stage.gen===null||stage!==call.peer&&stage!==call.next)return;
  const state=stage.peer.state;
  if(state==='failed'||state==='closed'){
   if(stage===call.next){this.dropReplacement(call);this.onError('The Live audio connection could not be renewed.');return}
   if(!call.next?.connected){this.lost(call,'Live audio connection was lost.');return}
  }
  if(state==='disconnected'||state==='failed'||state==='closed'){stage.timer??=setTimeout(()=>{
   if(stage===call.next){this.dropReplacement(call);this.onError('The Live audio connection could not be renewed.')}
   else if(stage===call.peer)this.lost(call,'Live audio connection was lost.');
  },5000);return}
  clearTimeout(stage.timer);stage.timer=undefined;
  if(state!=='connected'||stage.connected)return;
  stage.connected=true;
  if(stage===call.peer)this.pushContext();
  else try{await this.sendContext(call,stage)}catch(error){if(this.active(call)&&stage===call.next)this.lost(call,(error as Error).message)}
 }
 pushContext(){
  const call=this.call;if(!call?.secret)return;
  call.dirty=true;if(call.context)return;
  call.context=(async()=>{
   while(this.active(call)&&call.dirty&&call.peer){
    call.dirty=false;const stage=call.peer;
    try{
     const sent=await this.sendContext(call,stage);
     if(sent&&this.active(call)&&call.peer===stage)this.refreshMic(call);
    }catch(error){if(this.active(call)&&!call.dirty&&stage===call.peer)this.lost(call,(error as Error).message)}
   }
  })().finally(()=>{call.context=null;if(this.active(call)&&call.dirty)this.pushContext()});
 }
 private async sendContext(call:Call,stage:PeerStage){
  const chosen=await this.options.getSelection();this.check(call);
  if(stage===call.peer&&call.dirty)return false;
  const {conversationEpoch}=await this.request(call,'/voice/live/context');this.check(call);
  if(stage===call.peer&&call.dirty)return false;
  const context={selection:{provider:chosen.provider,model:chosen.model},workTarget:chosen.targetId??null,appScope:this.options.scope,
   conversationEpoch,gen:stage.gen,...(stage.connected?{peerConnected:true}:{})};
  const serialized=JSON.stringify(context);
  if(serialized!==call.lastContext){await this.request(call,'/voice/live/context',context);call.lastContext=serialized}
  return true;
 }
 private async updates(call:Call){
  const wait=this.options.wait??delay;let backoff=250,lastSuccess=Date.now();
  while(this.active(call)){
   try{
    const result=await this.request(call,`/voice/live/updates?cursor=${call.cursor}`);this.check(call);
    for(const event of Array.isArray(result?.events)?result.events:[]){
     if(!Number.isSafeInteger(event?.seq)||event.seq<=call.cursor)continue;
     if(event.seq!==call.cursor+1)throw new Error('A Live update was missing.');
     call.cursor=event.seq;this.event(call,event);
     if(!this.active(call))return;
    }
    backoff=250;lastSuccess=Date.now();
   }catch(error){
    if(!this.active(call))return;
    if(error instanceof LiveHttpError&&[401,403].includes(error.status)||Date.now()-lastSuccess>45000){this.lost(call,'Live voice connection was lost.');return}
    await wait(backoff,call.abort.signal);backoff=Math.min(4000,backoff*2);
   }
  }
 }
 private event(call:Call,event:any){
  if(event.type==='teardown'){
   const reason=typeof event.reason==='string'?event.reason:'Live call ended.';
   this.lost(call,reason,/voice service restarted/i.test(reason));return;
  }
  if(event.type==='hotkey'){if(call.standbyMuted)void this.setMuted(false);return}
  if(event.type==='completion'&&typeof event.label==='string'&&typeof event.text==='string'){
   const card={seq:event.seq,label:event.label,text:event.text,taskId:typeof event.taskId==='string'?event.taskId:null};
   this.publish({completions:[...(this.snapshot.completions||[]).slice(-3),card]});if(event.chime===true)this.chime(call);return;
  }
  if(event.type==='rollover'){if(!call.next)void this.rollover(call);return}
  if(event.type==='rollover-failed'){
   this.dropReplacement(call);
   this.onError('The Live connection could not be renewed.');return;
  }
  if(typeof event.gen==='number'&&event.gen!==call.gen&&event.gen!==call.next?.gen)return;
  if(event.type==='ready'){
   if(call.next&&event.gen===call.next.gen){
    const old=call.peer;call.peer=call.next;call.next=null;call.gen=call.peer.gen;
    clearTimeout(old?.timer);old?.peer.close();call.peer.peer.select();
    this.pushContext();
   }
   if(call.peer){call.peer.ready=true;this.standby(call,!!event.paused);this.refreshMic(call)}
   void this.artifactTick(call);
  }else if(event.type==='paused'||event.type==='resumed')this.standby(call,event.type==='paused');
  else if(event.type==='staged'&&typeof event.actionId==='string'&&typeof event.description==='string'&&['auto','voice','click'].includes(event.mode)&&Number.isFinite(event.expiresAt)){
   clearTimeout(this.stageTimer);
   if(event.expiresAt<=Date.now())return;
   this.publish({staged:{actionId:event.actionId,description:event.description,mode:event.mode,expiresAt:event.expiresAt}});
   this.stageTimer=setTimeout(()=>this.publish({staged:null}),Math.min(2147483647,event.expiresAt-Date.now()));
  }else if(['staged-cleared','staged-cancelled','staged-expired'].includes(event.type)){clearTimeout(this.stageTimer);this.publish({staged:null})}
  else if(event.type==='activity'){
   if(typeof event.key==='string'&&LIVE_ACTIVITY_PHASES.includes(event.phase)&&this.active(call))this.onActivity({key:event.key,phase:event.phase,label:typeof event.label==='string'?event.label:''});
  }else{
   const effect=event.reply&&typeof event.reply==='object'?event.reply:event;
   if(event.type==='effect'||event.type==='reply'||effect.panels||effect.reveals||effect.deliverable||effect.obsidian||effect.workIds){
    void Promise.resolve().then(()=>this.active(call)&&this.onEffect(effect)).catch(()=>this.onError('The Live reply could not be displayed.'));
   }
  }
 }
 private chime(call:Call){
  const context=call.audioContext;if(!context||context.state!=='running')return;
  try{
   const tone=context.createOscillator(),gain=context.createGain(),now=context.currentTime;
   tone.type='sine';tone.frequency.setValueAtTime(880,now);tone.frequency.setValueAtTime(1100,now+.075);
   gain.gain.setValueAtTime(.04,now);gain.gain.exponentialRampToValueAtTime(.0001,now+.18);
   tone.connect(gain);gain.connect(context.destination);tone.onended=()=>{tone.disconnect();gain.disconnect()};
   tone.start(now);tone.stop(now+.18);
  }catch{}
 }
 private async rollover(call:Call){
  if(!call.peer?.ready)return;
  try{
   const track=call.peer.peer.track.clone();track.enabled=false;
   call.next=this.makePeer(call,new MediaStream([track]));
   await this.connectPeer(call,call.next,true);
  }catch(error){
   if(!this.active(call))return;
   this.dropReplacement(call);
   this.onError((error as Error).message||'The Live connection could not be renewed.');
  }
 }
 private dropReplacement(call:Call){
  const next=call.next;if(!next)return;call.next=null;clearTimeout(next.timer);next.peer.close();this.pushContext();
 }
 private standby(call:Call,paused:boolean){
  if(this.paused===paused)return;this.paused=paused;
  if(!paused)call.standbyWake=false;
  const shouldMute=paused&&this.prefs.liveIdleMic==='muted'&&!call.muted;
  if(call.standbyMuted!==shouldMute){
   call.standbyMuted=shouldMute;void this.syncMute(call);
  }else this.refreshMic(call);
 }
 private refreshMic(call:Call){
  if(!this.active(call)||!call.peer)return;
  const ready=call.peer.ready&&call.peer.connected&&!!call.lastContext;
  const micMuted=call.muted||call.standbyMuted;
  call.peer.peer.track.enabled=ready&&!micMuted&&!call.mutePending;
  const voice=speakingHold(call.speakingUntil??0,call.peer.peer.getLevel()??0,Date.now());call.speakingUntil=voice.until;
  const state=!ready?'connecting':call.muted?'muted':this.paused&&!call.standbyWake?'standby':voice.speaking?'speaking':'listening';
  this.publish({state,ready,micMuted});
 }
 private measure(call:Call){
  clearInterval(this.levelTimer);
  this.levelTimer=setInterval(()=>this.refreshMic(call),125);
 }
 private syncMute(call:Call){
  const muted=call.muted||call.standbyMuted;
  const revision=++call.muteRevision;call.mutePending=true;this.refreshMic(call);
  const previous=this.muteQueue;
  const run=previous.then(async()=>{
   if(!this.active(call)||!call.secret)return;
   await this.request(call,'/voice/live/mute',{muted});
   if(!this.active(call)||revision!==call.muteRevision)return;
   call.mutePending=false;
   this.refreshMic(call);
  });
  this.muteQueue=run.catch(error=>{if(this.active(call))this.lost(call,(error as Error).message)});
  return this.muteQueue;
 }
 async setMuted(muted:boolean){
  const call=this.call;if(!call?.secret)return;
  call.muted=muted;call.standbyMuted=false;
  if(!muted)call.standbyWake=this.paused;
  await this.syncMute(call);
 }
 async action(confirm:boolean){
  const call=this.call,staged=this.snapshot.staged;
  if(!call?.secret||!staged||staged.expiresAt<=Date.now()||confirm&&staged.mode!=='click')return;
  try{await this.request(call,confirm?'/voice/live/confirm':'/voice/live/cancel',{actionId:staged.actionId});
   if(this.snapshot.staged===staged)this.publish({staged:null});
  }catch(error){if(!confirm&&this.snapshot.staged===staged)this.publish({staged:null});this.onError((error as Error).message)}
 }
 async report(path:string):Promise<{path:string;content:string}>{
  const call=this.call;if(!call?.secret)throw new Error('This Live call has ended.');
  return this.request(call,'/voice/live/report?path='+encodeURIComponent(path));
 }
 dismissCompletion(seq:number){this.publish({completions:this.snapshot.completions?.filter(card=>card.seq!==seq)})}
 private leave(lease:LiveSurfaceLease){
  return this.options.fetch('/voice/leave',jsonPost({id:lease.surfaceId},{keepalive:true,headers:{'X-V2-Surface-Secret':lease.surfaceSecret},signal:AbortSignal.timeout(3000)})).catch(()=>{});
 }
 private lost(call:Call,message:string,error=true){
  if(!this.active(call))return;void this.stop(false,message);if(error)this.onError(message);
 }
 // The reason goes to the bridge's call log (live-calls.jsonl); no reason means the user hung up.
 stop(keepalive=false,reason?:string){
  const call=this.call;if(!call)return false;
  const stopped=call.secret?this.options.fetch('/voice/live/stop',jsonPost(reason?{reason}:{},{headers:this.auth(call),keepalive,signal:AbortSignal.timeout(3000)})).catch(()=>{}):Promise.resolve();
  // The surface's event stream closes after the stop request settles: closed first, the bridge would log
  // "Voice surface disconnected." instead of why the window hung up (2026-11-22).
  this.call=null;call.abort.abort();void stopped.finally(()=>{call.stream.abort();void call.reader?.cancel().catch(()=>{})});
  call.artifacts?.destroy();
  clearInterval(this.levelTimer);clearTimeout(this.stageTimer);
  for(const stage of [call.peer,call.next])if(stage){clearTimeout(stage.timer);stage.peer.close()}
  if(call.audio){call.audio.pause();call.audio.srcObject=null}
  void call.audioContext?.close().catch(()=>{});
  if(call.lease)void stopped.finally(()=>this.leave(call.lease!));
  this.publish({state:'idle',ready:false,startedAt:null,cost:null,staged:null,micMuted:false,completions:undefined});
  void this.refreshStatus();return true;
 }
 destroy(){
  this.disposed=true;this.stop(true,'window closed');this.stopTimer?.();this.stopTimer=null;
  if(inBrowser()){document.removeEventListener('visibilitychange',this.tick);window.removeEventListener('focus',this.tick);window.removeEventListener('pagehide',this.pagehide)}
  this.listeners.clear();
 }
}

export const LIVE_ACTIVITY_PHASES=['handoff','starting','answered','started','dropped'] as const;
export interface LiveActivity {key:string;phase:typeof LIVE_ACTIVITY_PHASES[number];label:string}
