export interface LivePeerOptions {
 stream:MediaStream;
 connection:RTCPeerConnection;
 context:AudioContext;
 audio:HTMLAudioElement;
 onPlaying:()=>void;
 onError:(message:string)=>void;
 onState:()=>void;
 onStandby:(paused:boolean)=>void;
}
const wait=(signal:AbortSignal,target:RTCPeerConnection,property:'icegatheringstatechange',ready:()=>boolean)=>new Promise<void>((resolve,reject)=>{
 const close=()=>{target.removeEventListener(property,change);signal.removeEventListener('abort',abort)};
 const abort=()=>{close();reject(new Error('Live voice connection was interrupted.'))};
 const change=()=>{if(ready()){close();resolve()}};
 target.addEventListener(property,change);signal.addEventListener('abort',abort,{once:true});
 if(signal.aborted)abort();else change();
});

export class LivePeer {
 readonly track:MediaStreamTrack;
 private channel:RTCDataChannel;
 private analyser:AnalyserNode|null=null;
 private samples:Uint8Array<ArrayBuffer>|null=null;
 private source:MediaStreamAudioSourceNode|null=null;
 private silent:GainNode|null=null;
 private closed=false;
 private selected=false;
 private remote:MediaStream|null=null;
 constructor(private options:LivePeerOptions){
  const track=options.stream.getAudioTracks()[0];if(!track)throw new Error('No microphone track is available.');
  this.track=track;this.track.enabled=false;
  options.connection.addTrack(track,options.stream);
  this.channel=options.connection.createDataChannel('oai-events');
  this.channel.onmessage=({data})=>{
   if(!this.selected||typeof data!=='string')return;
   let event;try{event=JSON.parse(data)}catch{return}
   if(event?.type==='session.paused'||event?.type==='session.resumed')options.onStandby(event.type==='session.paused');
  };
  options.connection.ontrack=event=>{
   if(this.closed)return;
   this.remote=event.streams[0]??new MediaStream([event.track]);
   if(this.selected)this.play();
  };
  options.connection.onconnectionstatechange=options.onState;
 }
 get state(){return this.options.connection.connectionState}
 async offer(signal:AbortSignal){
  const pc=this.options.connection;signal.throwIfAborted();
  await pc.setLocalDescription(await pc.createOffer());signal.throwIfAborted();
  const deadline=AbortSignal.any([signal,AbortSignal.timeout(12000)]);
  await wait(deadline,pc,'icegatheringstatechange',()=>pc.iceGatheringState==='complete');
  signal.throwIfAborted();
  const sdp=pc.localDescription?.sdp;if(!sdp)throw new Error('Could not prepare the Live audio connection.');
  return sdp;
 }
 answer(sdp:string){return this.options.connection.setRemoteDescription({type:'answer',sdp})}
 select(){this.selected=true;if(this.remote)this.play()}
 private play(){
  const {audio,context,onPlaying,onError}=this.options;
  const remote=this.remote;if(!remote||audio.srcObject===remote)return;
  this.source?.disconnect();this.analyser?.disconnect();this.silent?.disconnect();
  audio.srcObject=remote;
  try{
   this.source=context.createMediaStreamSource(remote);this.analyser=context.createAnalyser();this.analyser.fftSize=256;
   this.samples=new Uint8Array(this.analyser.fftSize);
   // The element is the audible output. A silent analyser branch stays active
   // without playing a second copy of the remote stream.
   this.silent=context.createGain();this.silent.gain.value=0;
   this.source.connect(this.analyser);this.analyser.connect(this.silent);this.silent.connect(context.destination);
  }catch{}
  void audio.play().then(()=>{if(!this.closed&&this.remote===remote)onPlaying()},()=>{if(!this.closed&&this.remote===remote)onError('Live audio playback was blocked. Check autoplay permissions, then start the call again.')});
 }
 getLevel(){
  if(!this.analyser||!this.samples)return null;
  this.analyser.getByteTimeDomainData(this.samples);
  let sum=0;for(const value of this.samples)sum+=((value-128)/128)**2;
  return Math.min(1,Math.sqrt(sum/this.samples.length)*3.2);
 }
 close(){
  if(this.closed)return;this.closed=true;this.track.enabled=false;
  this.options.stream.getTracks().forEach(track=>track.stop());
  this.options.connection.ontrack=null;this.options.connection.onconnectionstatechange=null;
  this.channel.onmessage=null;this.channel.close();this.options.connection.close();
  this.source?.disconnect();this.analyser?.disconnect();this.silent?.disconnect();
  if(this.remote&&this.options.audio.srcObject===this.remote){this.options.audio.pause();this.options.audio.srcObject=null}
 }
}
