export const VOICE_MIC_CONSTRAINTS:MediaStreamConstraints={audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}};

// A click, breath or keyboard tap must not turn a silent activation into a request.
// Keep the established trailing pause, but only after a short run of real input.
export class VoiceCaptureGate {
 private candidate:number|null=null;private lastCandidate:number|null=null;private lastSpeech:number|null=null;private quietObserved=false;
 constructor(private started:number,private minimumSpeechMs=160){}
 get heardSpeech(){return this.lastSpeech!==null}
 acceptSpeech(now:number){this.lastSpeech=now}
 update(level:number,now:number):'quiet'|'finish'|null{
  if(level>0.018){
   // A gap between loud samples breaks the run only when a quiet sample was
   // actually observed. A throttled or stalled sampler (hidden window, busy
   // renderer) must not turn continuous speech into silence.
   if(this.lastCandidate===null||(this.quietObserved&&now-this.lastCandidate>160))this.candidate=now;
   this.lastCandidate=now;this.quietObserved=false;
   if(this.heardSpeech||now-this.candidate!>=this.minimumSpeechMs)this.lastSpeech=now;
  }else{this.quietObserved=true;if(this.lastCandidate!==null&&now-this.lastCandidate>160)this.candidate=null}
  if(this.lastSpeech!==null&&now-this.lastSpeech>=1600)return 'finish';
  if(this.lastSpeech===null&&now-this.started>=5000)return 'quiet';
  return null;
 }
}

function rms(values:Float32Array){let sum=0;for(const v of values)sum+=v*v;return Math.sqrt(sum/Math.max(1,values.length))}
function downsample(values:Float32Array,sampleRate:number,target=1000){
 const length=Math.floor(values.length*target/sampleRate),result=new Float32Array(length);
 for(let i=0;i<length;i++){const start=Math.floor(i*sampleRate/target),end=Math.min(values.length,Math.floor((i+1)*sampleRate/target));let sum=0;for(let j=start;j<end;j++)sum+=values[j]!;result[i]=sum/Math.max(1,end-start)}
 return result;
}
function append(history:number[],next:Float32Array,max:number){for(const value of next)history.push(value);if(history.length>max)history.splice(0,history.length-max)}

// Compare residual microphone input with the actual outgoing samples, including
// short speaker/room delays. This is a conservative gate, not a voice recognizer:
// browser AEC does the acoustic cancellation, and a loud/echoing room may still
// need click-to-interrupt. No cloud classifier or idle microphone is involved.
export class PlaybackSpeechGate {
 private mic:number[]=[];private reference:number[]=[];private candidate:number|null=null;
 private began:number|null=null;private lastFrame:number|null=null;private echoRatio=0;private noise=0.002;
 private levels:number[]=[];private candidateLevels:number[]=[];
 onset=0;
 update(input:Float32Array,output:Float32Array,sampleRate:number,now:number){
  this.began??=now;
  if(this.lastFrame!==null&&now-this.lastFrame>220){this.candidate=null;this.candidateLevels=[];this.levels=[]}
  this.lastFrame=now;
  append(this.mic,downsample(input,sampleRate),180);append(this.reference,downsample(output,sampleRate),380);
  const level=rms(input),referenceLevel=rms(output),count=Math.min(160,this.mic.length);
  this.levels.push(level);if(this.levels.length>8)this.levels.shift();
  let correlation=0;
  if(count>=100){
   let xx=0;for(let i=0;i<count;i++)xx+=this.mic[this.mic.length-count+i]!**2;
   if(xx>0.00001)for(let lag=0;lag<=180&&this.reference.length>=count+lag;lag++){
    let xy=0,yy=0;for(let i=0;i<count;i++){const a=this.mic[this.mic.length-count+i]!,b=this.reference[this.reference.length-count-lag+i]!;xy+=a*b;yy+=b*b}
    if(yy>0.00001)correlation=Math.max(correlation,Math.abs(xy)/Math.sqrt(xx*yy));
   }
  }
  const echo=correlation>0.64;
  if(referenceLevel>0.008&&echo)this.echoRatio=Math.max(this.echoRatio*0.985,Math.min(1.5,level/referenceLevel));
  // A steady fan, hum or room tone is not an invitation to take a turn. Learn
  // a stationary floor even when it is louder than the usual quiet-room cutoff.
  const low=Math.min(...this.levels),high=Math.max(...this.levels);
  if(level<0.012)this.noise=this.noise*0.95+level*0.05;
  else if(this.levels.length===8&&high-low<Math.max(0.002,high*0.1))this.noise=this.noise*0.85+low*0.15;
  const threshold=Math.max(0.02,this.noise*2.2,referenceLevel*this.echoRatio*2.5);
  const speech=now-this.began>=400&&!echo&&level>threshold;
  if(!speech){this.candidate=null;this.candidateLevels=[];return false}
  this.candidate??=now;
  this.candidateLevels.push(level);if(this.candidateLevels.length>8)this.candidateLevels.shift();
  if(now-this.candidate<320)return false;
  // Natural syllables vary. A sudden but sustained pure tone or stationary
  // broadband noise must not pass merely because its onset was loud enough.
  if(this.candidateLevels.length<4||Math.max(...this.candidateLevels)-Math.min(...this.candidateLevels)<Math.max(...this.candidateLevels)*0.18)return false;
  this.onset=this.candidate;return true;
 }
}

// Bounded PCM avoids broken WebM headers when old MediaRecorder chunks are
// discarded. Before interruption keep only 1.2 seconds locally; after it keep
// the user's utterance for at most 60 seconds and send one ordinary WAV request.
export class VoicePcmWindow {
 private parts:Float32Array[]=[];private length=0;
 constructor(private sampleRate:number,private seconds:number){}
 add(part:Float32Array){this.parts.push(part);this.length+=part.length;const cap=Math.ceil(this.sampleRate*this.seconds);while(this.parts.length&&this.length-this.parts[0]!.length>=cap)this.length-=this.parts.shift()!.length;if(this.length>cap){this.parts[0]=this.parts[0]!.slice(this.length-cap);this.length=cap}}
 tail(seconds=this.seconds){const keep=Math.min(this.length,Math.ceil(this.sampleRate*seconds)),result=new Float32Array(keep);let skip=this.length-keep,at=0;for(const part of this.parts){if(skip>=part.length){skip-=part.length;continue}const chunk=part.subarray(skip);skip=0;result.set(chunk,at);at+=chunk.length}return result}
 clear(){this.parts=[];this.length=0}
}
export function voiceWav(parts:Float32Array[],sampleRate=16000){
 const length=parts.reduce((n,p)=>n+p.length,0),buffer=new ArrayBuffer(44+length*2),view=new DataView(buffer);
 const write=(at:number,text:string)=>{for(let i=0;i<text.length;i++)view.setUint8(at+i,text.charCodeAt(i))};
 write(0,'RIFF');view.setUint32(4,36+length*2,true);write(8,'WAVE');write(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,length*2,true);
 let at=44;for(const part of parts)for(const sample of part){view.setInt16(at,Math.round(Math.max(-1,Math.min(1,sample))*(sample<0?32768:32767)),true);at+=2}return new Blob([buffer],{type:'audio/wav'});
}

export class PlaybackCapture {
 private stream:MediaStream|null=null;private mic:MediaStreamAudioSourceNode|null=null;private merger:ChannelMergerNode|null=null;
 private processor:ScriptProcessorNode|null=null;private mute:GainNode|null=null;private closed=false;
 private timer:ReturnType<typeof setTimeout>|null=null;private idleTimer:ReturnType<typeof setTimeout>|null=null;
 private gate=new PlaybackSpeechGate();private speech:VoiceCaptureGate|null=null;private ring=new VoicePcmWindow(16000,1.2);private parts:Float32Array[]=[];private sampleCount=0;
 private inputEnded=()=>{if(!this.closed){this.close();this.onError()}};
 interrupted=false;
 constructor(private context:AudioContext,private reference:AnalyserNode,private onInterrupt:()=>void,private onFinish:(blob:Blob)=>void,private onError:()=>void){}
 async start(){
  try{
   const stream=await navigator.mediaDevices.getUserMedia(VOICE_MIC_CONSTRAINTS);
   if(this.closed){stream.getTracks().forEach(track=>track.stop());return}this.stream=stream;for(const track of stream.getTracks())track.addEventListener?.('ended',this.inputEnded);
   this.mic=this.context.createMediaStreamSource(stream);this.merger=this.context.createChannelMerger(2);
   // ScriptProcessor is supported by both Electron and the browser HUD. The
   // callback only reduces/buffers PCM; its output is always muted. If unavailable
   // playback continues and the existing click/hotkey interruption still works.
   this.processor=this.context.createScriptProcessor(4096,2,1);this.mute=this.context.createGain();this.mute.gain.value=0;
   this.mic.connect(this.merger,0,0);this.reference.connect(this.merger,0,1);this.merger.connect(this.processor);this.processor.connect(this.mute);this.mute.connect(this.context.destination);
   this.processor.onaudioprocess=event=>{
    if(this.closed)return;const now=performance.now(),input=event.inputBuffer.getChannelData(0),output=event.inputBuffer.getChannelData(1),part=downsample(input,this.context.sampleRate,16000);
    if(this.interrupted){const remaining=Math.max(0,16000*60-this.sampleCount),piece=part.length>remaining?part.slice(0,remaining):part;if(piece.length){this.parts.push(piece);this.sampleCount+=piece.length}if(this.sampleCount>=16000*60||this.speech!.update(rms(input),now)==='finish')this.finish();return}
    this.ring.add(part);
    if(this.gate.update(input,output,this.context.sampleRate,now)){
     this.interrupted=true;const beginning=this.ring.tail((now-this.gate.onset+200)/1000);this.parts=[beginning];this.sampleCount=beginning.length;this.ring.clear();this.speech=new VoiceCaptureGate(now);this.speech.acceptSpeech(now);
     if(this.idleTimer)clearTimeout(this.idleTimer);this.idleTimer=null;
     this.timer=setTimeout(()=>this.finish(),60000);this.onInterrupt();
    }
   };
   // A suspended graph or disappearing device must not retain an open mic.
   this.idleTimer=setTimeout(()=>this.close(),95000);
  }catch{if(!this.closed){this.close();this.onError()}}
 }
 finish(){if(this.closed||!this.interrupted)return;const parts=this.parts;this.parts=[];this.close();this.onFinish(voiceWav(parts))}
 close(){if(this.closed)return;this.closed=true;if(this.timer)clearTimeout(this.timer);if(this.idleTimer)clearTimeout(this.idleTimer);this.timer=null;this.idleTimer=null;
  if(this.processor)this.processor.onaudioprocess=null;try{if(this.merger)this.reference.disconnect(this.merger)}catch{}
  this.mic?.disconnect();this.merger?.disconnect();this.processor?.disconnect();this.mute?.disconnect();this.stream?.getTracks().forEach(track=>{track.removeEventListener?.('ended',this.inputEnded);track.stop()});this.stream=null;this.mic=null;this.merger=null;this.processor=null;this.mute=null;this.ring.clear();this.parts=[];this.sampleCount=0;
 }
}
