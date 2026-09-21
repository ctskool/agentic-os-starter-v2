import {speechText} from './speech-text';
import {VoiceCaptureGate,PlaybackCapture,VOICE_MIC_CONSTRAINTS} from './voice-turn-taking';
import {VoiceSurface,type VoiceSurfaceInfo} from './voice-surface';
import {authorizedBridgeFetch,type BridgeAuthorization} from './bridge-auth';
import type {ObsidianAction} from "./voice-actions";
import type {ArtifactOpener} from './artifact-delivery';
export interface VoiceReveal {kind:"doc"|"link";target:string;label:string;at:number}
export type VoiceMode = 'idle'|'listening'|'working'|'speaking'|'error';
export type VoiceCancelReason='cancelled'|'owner-change'|'connection-lost'|'provider-change';
export type VoiceTraceStage='capture-start'|'accepted'|'ownership-ready'|'selection-ready'|'recording-start'|'speech-detected'|'no-speech'|'remote-start'|'remote-timeout'|'remote-empty'|'request-start'|'reply'|'audio-resume'|'audio-ready'|'stream-start'|'stream-playing'|'stream-fallback'|'buffered-start'|'buffered-ready'|'buffered-playing'|'idle'|'error'|VoiceCancelReason;
export interface VoiceTrace {requestId:string;startedAt:number;points:{stage:VoiceTraceStage;ms:number}[]}
export interface VoiceSelection {provider:'codex'|'claude';model:string;terminalMode?:boolean;targetId?:string|null}
export interface VoiceReply {id:string;provider:string;model:string|null;reply:string;spokenReply?:string;action:string;queued:string|null;skill:string|null;transcript:string;workIds?:string[];current?:{codex:string|null;claude:string|null};currentRevision?:number;currentReset?:boolean;conversationSuperseded?:boolean;panels?:string[];deliverable?:string|null;reveal?:"open"|null;reveals?:VoiceReveal[];obsidian?:ObsidianAction|null}
export type VoiceTransport = (path:string,options?:{method?:string;headers?:Record<string,string>;body?:string|ArrayBuffer;signal?:AbortSignal})=>Promise<{status:number;json?:any;audio?:ArrayBuffer}>;
function audioWait<T>(promise:Promise<T>,milliseconds:number,signal?:AbortSignal):Promise<T>{return new Promise((resolve,reject)=>{
 let settled=false;const finish=(error:unknown,value?:T)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error)reject(error);else resolve(value as T)};
 const abort=()=>finish(new Error('Audio was interrupted.')),timer=setTimeout(()=>finish(new Error('Audio did not become ready in time.')),milliseconds);
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();promise.then(value=>finish(null,value),error=>finish(error));
})}
// Shared by the native plugin and web HUD. A generation token prevents late microphone,
// routing, or TTS responses from restarting an interrupted session.
export class VoiceSession {
 mode:VoiceMode='idle'; private generation=0; private recorder:MediaRecorder|null=null;
 private stream:MediaStream|null=null; private context:AudioContext|null=null; private source:AudioBufferSourceNode|null=null;
 private analyser:AnalyserNode|null=null; private samples:Uint8Array|null=null;
 private request:AbortController|null=null; private id:string|null=null; private chosen:VoiceSelection|null=null;
 private surface:VoiceSurface|null=null; private media:HTMLAudioElement|null=null; private mediaNode:MediaElementAudioSourceNode|null=null; private endPlayback:((ok:boolean)=>void)|null=null;
 private silenceTimer:ReturnType<typeof setInterval>|null=null;private micNode:MediaStreamAudioSourceNode|null=null;private micAnalyser:AnalyserNode|null=null;private localQueue:string[]=[];private draining=false;
 private revealTimers:ReturnType<typeof setTimeout>[]=[];
 private timer:ReturnType<typeof setTimeout>|null=null; private destroyed=false;
 private quietTimer:ReturnType<typeof setTimeout>|null=null;private captureGate:VoiceCaptureGate|null=null;private barge:PlaybackCapture|null=null;
 private errorTimer:ReturnType<typeof setTimeout>|null=null;private playback:AbortController|null=null;
 private unlockInstalled=false;
 private remoteCapture=false;
 private progressTimer:ReturnType<typeof setTimeout>|null=null;
 private trace:VoiceTrace|null=null;private traceStart=0;private traceGeneration=-1;
 onState:(mode:VoiceMode)=>void=()=>{}; onMessage:(text:string,error?:boolean)=>void=()=>{}; onReply:(reply:VoiceReply)=>void|Promise<void>=()=>{}; onReveal:(reveal:VoiceReveal)=>void=()=>{};
 onArtifact?:ArtifactOpener;
 constructor(private transport:VoiceTransport,private getSelection:()=>Promise<VoiceSelection>,private kind?:'web'|'native',private surfaceInfo?:VoiceSurfaceInfo){}
 connect(){
  this.primeAudio();
  if(this.kind==='web'&&!this.unlockInstalled&&typeof window!=='undefined'){this.unlockInstalled=true;window.addEventListener('pointerdown',this.unlockAudio);window.addEventListener('keydown',this.unlockAudio)}
  if(this.kind&&!this.surface)this.surface=new VoiceSurface(this.transport,this.kind,()=>this.mode,async text=>{const attempt={started:false};const ok=await this.speak(text,this.generation,[],attempt);return {ok,started:attempt.started}},e=>{
   if(e.type==='disconnected'){const active=this.mode!=='idle';this.cancel('connection-lost');if(active)this.onMessage('Voice connection interrupted. Try again.',true);return}
   if(e.type==='owner'&&e.id!==this.surface?.id&&this.mode!=='idle')this.cancel('owner-change');
   if(e.client!==this.surface?.id)return;
   if(e.type==='artifact-error'){this.onMessage(e.message||'The file could not be opened.',true);return}
   if(e.type==='wake'){this.primeAudio();this.cancel();this.remoteCapture=true;this.beginTrace(crypto.randomUUID(),'remote-start');this.set('listening');this.onMessage('Listening…')}
   else if(e.type==='transcript'&&this.remoteCapture){this.remoteCapture=false;const text=String(e.text||'').trim();if(!text)this.mark('remote-empty');if(!text||/^(stop|never ?mind|cancel|no)[.!]?$/i.test(text))this.cancel();else void this.sendText(text)}
   else if((e.type==='wake_timeout'||e.type==='wake_error')&&this.remoteCapture){this.mark(e.type==='wake_timeout'?'remote-timeout':'error');this.cancel();if(e.type==='wake_error'){this.onMessage('Voice capture failed. Try again.',true);this.set('error')}else this.onMessage('')}
  },this.surfaceInfo,()=>this.kind!=='web'||this.context?.state==='running',()=>this.getTimingTrace(),async(artifact,signal)=>{if(this.destroyed||signal?.aborted)throw new Error('Opening was cancelled.');if(!this.onArtifact)throw new Error('The file is saved, but this window cannot display it.');await this.onArtifact(artifact,signal)});
 }
 getTimingTrace():VoiceTrace|null{return this.trace?{...this.trace,points:this.trace.points.map(point=>({...point}))}:null}
 private beginTrace(requestId:string,stage:VoiceTraceStage){this.trace={requestId,startedAt:Date.now(),points:[]};this.traceStart=performance.now();this.traceGeneration=this.generation;this.mark(stage)}
 private mark(stage:VoiceTraceStage){if(!this.trace||this.traceGeneration!==this.generation||this.trace.points.length>=20)return;this.trace.points.push({stage,ms:Math.max(0,Math.round(performance.now()-this.traceStart))})}
 private cue(mode:VoiceMode):(()=>void)|null{try{if(!this.context||!['listening','working','error'].includes(mode))return null;const ctx=this.context,o=ctx.createOscillator(),g=ctx.createGain();let ended=false;const stop=()=>{if(ended)return;ended=true;o.onended=null;try{o.stop()}catch{}o.disconnect();g.disconnect()};o.frequency.value=mode==='listening'?660:mode==='error'?220:440;g.gain.setValueAtTime(0.025,ctx.currentTime);g.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+0.09);o.connect(g);g.connect(ctx.destination);o.onended=stop;o.start();o.stop(ctx.currentTime+0.1);return stop}catch{return null}}
 // Request acceptance is visual only. Fast answers must own the audio output
 // immediately, without cached receipt speech or background TTS warmup.
 private clearRequestFeedback(){if(this.progressTimer)clearTimeout(this.progressTimer);this.progressTimer=null}
 private beginRequestFeedback(token:number){
  this.clearRequestFeedback();
  if(token!==this.generation||this.mode!=='working'||!this.id)return;
  this.progressTimer=setTimeout(()=>{this.progressTimer=null;if(token===this.generation&&this.mode==='working'&&this.id)this.onMessage('Still working on your request…')},4000);
 }
 announce(id:string,text:string){return this.surface?.announce(id,speechText(text,700))??Promise.resolve()}
 cancelArtifact(){this.surface?.cancelArtifact()}
 enqueue(text:string){this.localQueue.push(text);void this.drain()}
 private async drain(){if(this.draining||this.mode!=='idle'||this.destroyed)return;this.draining=true;try{while(this.localQueue.length&&this.mode==='idle')await this.speak(this.localQueue.shift()!)}finally{this.draining=false}}

 private primeAudio(){if(typeof AudioContext==='undefined')return;try{this.context??=new AudioContext();void this.context.resume().catch(()=>{})}catch{}}
 private unlockAudio=()=>{if(this.destroyed)return;this.primeAudio();if(!this.context)return;void audioWait(this.context.resume(),2500).then(()=>{if(!this.destroyed&&this.context?.state==='running'){if(this.mode==='error')this.set('idle');void this.surface?.tick()}},()=>{})};
 private set(mode:VoiceMode,withCue=true){if(this.errorTimer)clearTimeout(this.errorTimer);this.errorTimer=null;if(this.mode!==mode&&withCue)this.cue(mode);if((mode==='idle'||mode==='error')&&this.mode!==mode){this.mark(mode);this.traceGeneration=-1}this.mode=mode;this.onState(mode);if(mode==='error')this.errorTimer=setTimeout(()=>{this.errorTimer=null;if(!this.destroyed&&this.mode==='error')this.set('idle')},4000);void this.surface?.tick();if(mode==='idle')queueMicrotask(()=>void this.drain())}
 private release(){if(this.silenceTimer)clearInterval(this.silenceTimer);this.silenceTimer=null;if(this.quietTimer)clearTimeout(this.quietTimer);this.quietTimer=null;this.captureGate=null;this.micNode?.disconnect();this.micNode=null;this.micAnalyser?.disconnect();this.micAnalyser=null;this.stream?.getTracks().forEach(t=>t.stop());this.stream=null;if(this.timer)clearTimeout(this.timer);this.timer=null}
 private stopOutput(){this.playback?.abort();this.playback=null;this.endPlayback?.(false);this.endPlayback=null;if(this.media){this.media.pause();this.media.removeAttribute('src');this.media.load();this.media=null}this.mediaNode?.disconnect();this.mediaNode=null;this.revealTimers.forEach(clearTimeout);this.revealTimers=[];try{this.source?.stop()}catch{}this.source=null}
 private quiet(){this.mark('no-speech');this.id=null;this.cancel();this.onMessage('')}
 cancel(reason:VoiceCancelReason='cancelled'){if(this.mode!=='idle')this.mark(reason);this.clearRequestFeedback();this.surface?.cancelArtifact();this.remoteCapture=false;this.localQueue=[];const was=this.mode!=='idle';++this.generation;this.barge?.close();this.barge=null;this.stopOutput();this.request?.abort();this.request=null;
  if(this.id)void this.transport('/voice/cancel',{method:'POST',body:JSON.stringify({id:this.id})}).catch(()=>{});
  this.id=null;const r=this.recorder;this.recorder=null;if(r?.state==='recording')r.stop();this.release();
  this.set('idle');return was;
 }
 async destroy(){this.surface?.destroy();this.cancel();this.destroyed=true;if(this.unlockInstalled&&typeof window!=='undefined'){window.removeEventListener('pointerdown',this.unlockAudio);window.removeEventListener('keydown',this.unlockAudio)}this.unlockInstalled=false;await this.context?.close().catch(()=>{});this.context=null}
 getLevel=():number|null=>{if(this.mode!=='speaking'||!this.analyser||!this.samples)return null;this.analyser.getByteTimeDomainData(this.samples as Uint8Array<ArrayBuffer>);let sum=0;for(const v of this.samples)sum+=((v-128)/128)**2;return Math.min(1,Math.sqrt(sum/this.samples.length)*3.2)};
 private async checked(path:string,options:Parameters<VoiceTransport>[1]={}){
  if(path!=='/voice/audio'&&path!=='/voice/text'){
   const r=await this.transport(path,options);if(r.status!==200)throw new Error(r.json?.error||'V2 voice service is unavailable');return r;
  }
  const deadline=new AbortController(),signal=options.signal?AbortSignal.any([options.signal,deadline.signal]):deadline.signal;
  signal.throwIfAborted();
  let timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{};
  const interrupted=new Promise<never>((_,reject)=>{
   abort=()=>reject(signal.reason||new Error('Voice request cancelled'));signal.addEventListener('abort',abort,{once:true});
   if(signal.aborted){abort();return}
   timer=setTimeout(()=>{
    deadline.abort(new Error('Voice request timed out. Try again.'));
    // Native requestUrl cannot abort an already-sent HTTP request. Cancel by
    // its captured ID too, without cancelling a newer request or retrying it.
    const id=options.headers?.['X-V2-Request'];if(id)void this.transport('/voice/cancel',{method:'POST',body:JSON.stringify({id})}).catch(()=>{});
   },120000);
  });
  try{
   const r=await Promise.race([this.transport(path,{...options,signal}),interrupted]);
   if(r.status!==200)throw new Error(r.json?.error||'V2 voice service is unavailable');return r;
  }finally{if(timer!==undefined)clearTimeout(timer);signal.removeEventListener('abort',abort)}
 }
 async toggle(){if(this.mode==='listening')return this.finish();if(this.mode==='working'){this.cancel();this.onMessage('Request cancelled. Tasks already queued keep running.');return;}return this.start()}
 async start(){
  this.primeAudio();
  this.cancel();if(this.destroyed)return;const token=this.generation;this.beginTrace(crypto.randomUUID(),'capture-start');this.set('working');this.onMessage('Preparing voice…');
  try{
   await this.surface?.focus();if(token!==this.generation)return;this.mark('ownership-ready');const chosen=await this.getSelection();if(token!==this.generation)return;this.mark('selection-ready');const health=await this.checked('/voice/health');
   if(token!==this.generation)return;if(!health.json?.ok)throw new Error('Local speech is offline. Start the V2 speech service.');
   if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined')throw new Error('Microphone recording is unavailable in this window. Open V2 in a browser or Obsidian with microphone support.');
   const stream=await navigator.mediaDevices.getUserMedia(VOICE_MIC_CONSTRAINTS);
   if(token!==this.generation){stream.getTracks().forEach(t=>t.stop());return}
   this.stream=stream;this.chosen={...chosen};this.id=this.trace!.requestId;
   this.context??=new AudioContext();await audioWait(this.context.resume(),2500);if(token!==this.generation){if(this.stream===stream)this.release();return}
   const chunks:BlobPart[]=[];const rec=new MediaRecorder(stream);this.recorder=rec;
   rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
   rec.onerror=()=>{if(token===this.generation){this.cancel();this.set('error');this.onMessage('Microphone recording failed. Try again.',true)}};
   rec.onstop=()=>{
    if(token!==this.generation)return;
    // A device ending its own stream is not a user acceptance. Only finish()
    // clears the owned recorder before stop, after qualifying real speech.
    if(this.recorder===rec){this.recorder=null;this.id=null;this.release();this.set('error');this.onMessage('Microphone recording stopped. Try again.',true);return}
    void this.sendAudio(new Blob(chunks,{type:rec.mimeType}),chosen,token);
   };
   // A separate input analyser detects silence without playing the microphone
   // through the speakers or reusing the output-level meter.
   const input=this.context.createAnalyser();input.fftSize=512;this.micAnalyser=input;
   this.micNode=this.context.createMediaStreamSource(stream);this.micNode.connect(input);
   const samples=new Uint8Array(input.fftSize),gate=new VoiceCaptureGate(performance.now());this.captureGate=gate;
   rec.start();this.mark('recording-start');this.set('listening');this.onMessage('Listening · Pause to send · Click again to send · Escape to cancel');
   this.silenceTimer=setInterval(()=>{
    if(token!==this.generation||this.recorder!==rec||rec.state!=='recording')return;
    input.getByteTimeDomainData(samples);let sum=0;for(const value of samples)sum+=((value-128)/128)**2;
    const heardSpeech=gate.heardSpeech,result=gate.update(Math.sqrt(sum/samples.length),performance.now());if(!heardSpeech&&gate.heardSpeech)this.mark('speech-detected');if(result==='quiet')this.quiet();else if(result==='finish')void this.finish();
   },80);
   this.quietTimer=setTimeout(()=>{if(token===this.generation&&!gate.heardSpeech)this.quiet()},5000);
   this.timer=setTimeout(()=>{if(token===this.generation)void this.finish()},60000);
  }catch(e){if(token!==this.generation)return;this.release();this.set('error');this.onMessage(e instanceof Error?e.message:String(e),true)}
 }
 async finish(){if(this.barge?.interrupted){this.barge.finish();return}const r=this.recorder;if(!r)return;if(!this.captureGate?.heardSpeech){this.quiet();return}this.recorder=null;this.mark('accepted');this.set('working',false);r.stop();this.release();this.beginRequestFeedback(this.generation)}
 private async sendAudio(blob:Blob,chosen:VoiceSelection,token:number){
  try{if(blob.size<1000)throw new Error('Recording was too short. Try speaking for a little longer.');await this.dispatch('/voice/audio',await blob.arrayBuffer(),chosen,token,blob.type)}
  catch(e){this.fail(e,token)}
 }
 async sendText(transcript:string){this.primeAudio();this.cancel();const token=this.generation;this.id=crypto.randomUUID();this.beginTrace(this.id,'accepted');this.set('working',false);this.beginRequestFeedback(token);try{await this.surface?.focus();if(token!==this.generation)return;this.mark('ownership-ready');const chosen=await this.getSelection();if(token!==this.generation)return;this.mark('selection-ready');await this.dispatch('/voice/text',JSON.stringify({transcript}),chosen,token,'application/json')}catch(e){this.fail(e,token)}}
 private async dispatch(path:string,body:string|ArrayBuffer,chosen:VoiceSelection,token:number,mime:string){
  if(token!==this.generation)return;this.request=new AbortController();this.mark('request-start');
  const r=await this.checked(path,{method:'POST',body,headers:{'Content-Type':mime,'X-V2-Request':this.id!,'X-V2-Selection':JSON.stringify(chosen),...(this.surface?{'X-V2-Surface':this.surface.id}:{}),...(chosen.terminalMode?{'X-V2-Work':JSON.stringify({targetId:chosen.targetId||null})}:{})},signal:this.request.signal});
  if(token!==this.generation)return;this.mark('reply');this.clearRequestFeedback();this.id=null;await this.onReply(r.json);if(token!==this.generation)return;
  if(r.json.reply?.trim()){
   this.onMessage(r.json.reply);
   // The bridge selects speech before Markdown is flattened for TTS. Keep the
   // complete written reply for display and older bridge responses compatible.
   const spoken=typeof r.json.spokenReply==='string'&&r.json.spokenReply.trim()?r.json.spokenReply:r.json.reply;
   await this.speak(spoken,token,r.json.reveals||[]);
  }else this.set('idle');
 }
 private fail(e:unknown,token:number){if(token!==this.generation)return;this.clearRequestFeedback();this.id=null;this.release();this.set('error');this.onMessage(e instanceof Error?e.message:String(e),true)}
 private listenDuringPlayback(token:number,reference:AnalyserNode){
  if(token!==this.generation||this.barge||!this.context||reference!==this.analyser||typeof navigator==='undefined'||!navigator.mediaDevices?.getUserMedia||typeof this.context.createScriptProcessor!=='function')return;
  let captureToken=token,selection:Promise<VoiceSelection>|null=null;
  const capture=new PlaybackCapture(this.context,reference,()=>{
   if(this.destroyed||this.barge!==capture||captureToken!==this.generation){capture.close();return}
   // Advance ownership before stopping the audio. Its completion/fallback can
   // no longer change the new listening turn, or replay a started announcement.
   captureToken=++this.generation;this.stopOutput();this.request?.abort();this.request=null;
   this.id=crypto.randomUUID();this.beginTrace(this.id,'capture-start');this.set('listening',false);this.onMessage('Listening…');
   selection=(async()=>{await this.surface?.focus();if(captureToken!==this.generation)throw new Error('Voice was interrupted');this.mark('ownership-ready');const chosen=await this.getSelection();if(captureToken!==this.generation)throw new Error('Voice was interrupted');this.mark('selection-ready');return chosen})();
   // Capture keeps the beginning while current conversation ownership resolves.
   void selection.catch(error=>{if(this.barge===capture&&captureToken===this.generation){this.barge=null;capture.close();this.fail(error,captureToken)}});
  },blob=>{
   if(this.destroyed||this.barge!==capture||captureToken!==this.generation)return;
   this.barge=null;this.mark('accepted');this.set('working',false);this.beginRequestFeedback(captureToken);
   void (async()=>{try{const chosen=await selection!;if(captureToken===this.generation)await this.sendAudio(blob,chosen,captureToken)}catch(error){this.fail(error,captureToken)}})();
  },()=>{
   if(this.barge!==capture)return;this.barge=null;
   // Microphone permission is optional for playback. An unavailable input must
   // never silence a spoken answer or create an error loop on the other surface.
   if(capture.interrupted&&captureToken===this.generation)this.fail(new Error('Microphone recording failed. Try again.'),captureToken);
  });
  this.barge=capture;void capture.start();
 }
 async speak(input:string,token=this.generation,reveals:VoiceReveal[]=[],attempt={started:false}):Promise<boolean>{
  if(this.destroyed||token!==this.generation)return false;
  if(this.playback){this.cancel();token=this.generation}
  this.clearRequestFeedback();
  const text=speechText(input);if(!text){this.set('idle');return true}
  this.primeAudio();
  if(this.kind==='web'&&this.context?.state!=='running'){this.onMessage(`${input}\n\nClick or press a key to enable audio.`,true);this.set('error');return false}
  const playback=new AbortController();this.playback=playback;this.set('working');
  try{
   this.mark('audio-resume');if(this.context){await audioWait(this.context.resume(),2500,playback.signal);if(this.context.state&&this.context.state!=='running')throw new Error('Audio is suspended.')}if(token===this.generation)this.mark('audio-ready');
   if(token!==this.generation)return false;
   // Native and web use streaming first; buffering is a compatibility fallback.
   if(typeof Audio!=='undefined'){
    let began=false;
    try{
     const ok=await new Promise<boolean>((resolve,reject)=>{
      const audio=new Audio();audio.crossOrigin='anonymous';audio.preload='auto';audio.src=`http://127.0.0.1:3219/voice/speak?text=${encodeURIComponent(text)}`;this.media=audio;
      // Configure CORS and the output graph before loading/starting media, as in V1.
      let outputReference:AnalyserNode|null=null;
      try{this.analyser??=this.context!.createAnalyser();this.analyser.fftSize=512;this.samples=new Uint8Array(512);this.mediaNode=this.context!.createMediaElementSource(audio);this.mediaNode.connect(this.analyser);this.analyser.disconnect();this.analyser.connect(this.context!.destination);outputReference=this.analyser}catch{}
      this.mark('stream-start');
      let settled=false;const finish=(ok:boolean)=>{if(settled)return;settled=true;clearTimeout(timeout);clearTimeout(firstAudio);audio.onended=null;audio.onerror=null;audio.onplaying=null;this.endPlayback=null;audio.pause();audio.removeAttribute('src');audio.load();this.media=null;audio.ontimeupdate=null;this.mediaNode?.disconnect();this.mediaNode=null;resolve(ok)};
      this.endPlayback=finish;const firstAudio=setTimeout(()=>{if(!began)finish(false)},8000);const timeout=setTimeout(()=>{if(began)finish(false);else{finish(false);}},90000);
      audio.onplaying=()=>{if(token!==this.generation){finish(false);return}began=true;attempt.started=true;this.mark('stream-playing');clearTimeout(firstAudio);this.set('speaking');if(outputReference)this.listenDuringPlayback(token,outputReference)};
      const pending=new Set(reveals);audio.ontimeupdate=()=>{if(!began||token!==this.generation)return;for(const r of pending)if(audio.currentTime>=r.at/15){pending.delete(r);this.onReveal(r)}};
      audio.onended=()=>{for(const r of pending)if(token===this.generation)this.onReveal(r);finish(true)};
      audio.onerror=()=>finish(false);try{void audio.play().catch(()=>finish(false))}catch{finish(false)};
     });
     if(token!==this.generation)return false;if(ok){this.set('idle');return true}
     if(began)throw new Error('Audio was interrupted.');
    }catch(e){if(began)throw e}this.mark('stream-fallback');
   }
   if(token!==this.generation)return false;
   this.context??=new AudioContext();await audioWait(this.context.resume(),2500,playback.signal);
   if(this.context.state&&this.context.state!=='running')throw new Error('Audio is suspended.');
   if(token!==this.generation)return false;
   this.request=new AbortController();this.mark('buffered-start');const r=await audioWait(this.checked('/voice/speak',{method:'POST',body:JSON.stringify({text}),signal:this.request.signal}),20000,playback.signal);
   if(token!==this.generation)return false;
   this.mark('buffered-ready');const buffer=await audioWait(this.context.decodeAudioData(r.audio!.slice(0)),5000,playback.signal);if(token!==this.generation)return false;
   this.analyser??=this.context.createAnalyser();this.analyser.fftSize=512;this.samples=new Uint8Array(512);this.analyser.disconnect();this.analyser.connect(this.context.destination);
   const source=this.context.createBufferSource();this.source=source;source.buffer=buffer;source.connect(this.analyser);
   const pending=new Set(reveals);const reveal=(r:VoiceReveal)=>{if(token===this.generation&&pending.delete(r))this.onReveal(r)};
   this.revealTimers=reveals.map(r=>setTimeout(()=>reveal(r),Math.max(0,Math.min(1,r.at/Math.max(1,input.length)))*buffer.duration*1000));
   const ok=await new Promise<boolean>((resolve,reject)=>{let settled=false;const finish=(ok:boolean)=>{if(settled)return;settled=true;clearTimeout(timeout);source.onended=null;try{source.stop()}catch{}source.disconnect();this.endPlayback=null;resolve(ok)};
    const timeout=setTimeout(()=>finish(false),Math.min(90000,Math.max(5000,buffer.duration*1000+5000)));this.endPlayback=finish;
    source.onended=()=>{if(token===this.generation)pending.forEach(reveal);finish(token===this.generation)};
    try{source.start();attempt.started=true;this.mark('buffered-playing');this.set('speaking');this.listenDuringPlayback(token,this.analyser!)}catch(error){finish(false);reject(error)}
   });
   this.endPlayback=null;this.revealTimers.forEach(clearTimeout);this.revealTimers=[];
   if(token!==this.generation)return false;this.source=null;if(!ok)throw new Error('Audio was interrupted.');this.set('idle');return true;
  }catch(e){if(token===this.generation){this.request?.abort();this.set('error');this.onMessage(`${input}\n\nSpoken playback failed. The written result is still available.`,true)}return false}
  finally{if(token===this.generation){this.barge?.close();this.barge=null}if(this.playback===playback)this.playback=null}
 }

}
export const browserVoiceTransport=(base='http://127.0.0.1:3219',authorize?:BridgeAuthorization):VoiceTransport=>async(path,options={})=>{
 const r=await authorizedBridgeFetch(base+path,{...options,headers:{'Content-Type':'application/json',...options.headers},cache:'no-store'},authorize);
 return r.headers.get('content-type')?.includes('audio/')?{status:r.status,audio:await r.arrayBuffer()}:{status:r.status,json:await r.json()};
};
