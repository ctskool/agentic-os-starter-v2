import type {VoiceTransport,VoiceMode,VoiceTrace} from './voice-session';
import {ArtifactDelivery,type ArtifactOpener} from './artifact-delivery';
export interface VoiceSurfaceInfo {version?:string;heartbeat?:(tick:()=>void)=>()=>void}
const INITIAL_RECONNECT_MS=1000,MAX_RECONNECT_MS=30000,STALE_STREAM_MS=30000,COORDINATION_TIMEOUT_MS=5000;
const canShowArtifact=()=>typeof document==='undefined'||!document.hidden&&(typeof document.hasFocus!=='function'||document.hasFocus());
export class VoiceSurface {
 readonly id=crypto.randomUUID(); private stopHeartbeat:(()=>void)|null=null;private stream:EventSource|null=null;private busy=false;private presenceBusy=false;private disposed=false;private pendingAck:{id:string;client:string;ok:boolean}|null=null;private active:{id:string;started:boolean}|null=null;
 private reconnectAt:number|null=null;private reconnectDelay=INITIAL_RECONNECT_MS;private reconnectTimer:ReturnType<typeof setTimeout>|null=null;private reconnectGeneration=0;
 private lastStreamEventAt:number|null=null;private connectionWaiters=new Set<()=>void>();
 private refresh=()=>void this.tick();
 private artifacts:ArtifactDelivery|null=null;
 constructor(private transport:VoiceTransport,private kind:'web'|'native',private mode:()=>VoiceMode,private play:(text:string)=>Promise<boolean|{ok:boolean;started:boolean}>,private event:(e:any)=>void,private info:VoiceSurfaceInfo={},private canPlay:()=>boolean=()=>true,private timingTrace:()=>VoiceTrace|null=()=>null,openArtifact?:ArtifactOpener){
  if(openArtifact)this.artifacts=new ArtifactDelivery((path,body)=>this.request(path,body),this.id,()=>!this.disposed&&this.mode()==='idle'&&canShowArtifact(),openArtifact,message=>this.event({type:'artifact-error',client:this.id,message}));
  if(typeof window==='undefined')return;
  this.connectStream();
  if(this.kind==='native'&&this.info.heartbeat)this.stopHeartbeat=this.info.heartbeat(this.refresh);
  else {const timer=setInterval(this.refresh,4000);this.stopHeartbeat=()=>clearInterval(timer)}
  document.addEventListener?.('visibilitychange',this.refresh);window.addEventListener?.('focus',this.refresh);window.addEventListener?.('blur',this.refresh);void this.tick();
 }
 private clearReconnect(){this.reconnectGeneration++;if(this.reconnectTimer!==null)clearTimeout(this.reconnectTimer);this.reconnectTimer=null;this.reconnectAt=null}
 private scheduleReconnect(){
  if(this.disposed||this.reconnectAt!==null)return;
  const delay=this.reconnectDelay,generation=++this.reconnectGeneration;this.reconnectDelay=Math.min(delay*2,MAX_RECONNECT_MS);this.reconnectAt=Date.now()+delay;
  this.reconnectTimer=setTimeout(()=>{if(this.disposed||this.reconnectGeneration!==generation)return;this.reconnectTimer=null;this.reconnectIfDue()},delay);
 }
 private reconnectIfDue(){
  if(this.disposed||this.reconnectAt===null||Date.now()<this.reconnectAt)return;
  this.clearReconnect();
  // CONNECTING already has the browser's retry. Only replace a permanently CLOSED stream.
  if(this.stream&&this.stream.readyState!==2)return;
  this.connectStream();
 }
 private recoverStaleStream(){
  // Sleep can leave Chromium reporting OPEN for a socket which no longer
  // delivers events. Wall time also advances while renderer timers are paused.
  if(this.stream?.readyState!==1||this.lastStreamEventAt===null||Date.now()-this.lastStreamEventAt<=STALE_STREAM_MS)return;
  this.clearReconnect();this.connectStream();
 }
 private retireStream(stream:EventSource|null){
  if(!stream||this.stream!==stream||this.disposed)return;
  this.stream=null;this.lastStreamEventAt=null;stream.close();this.scheduleReconnect();
 }
 private async connectionReady(){
  if(typeof window==='undefined')return;
  this.recoverStaleStream();
  if(this.stream?.readyState===2)this.scheduleReconnect();this.reconnectIfDue();
  const ready=()=>!!this.stream&&this.stream.readyState!==0&&this.stream.readyState!==2;
  if(this.disposed)throw new Error('Voice was interrupted.');if(ready())return;
  await new Promise<void>((resolve,reject)=>{
   const stream=this.stream;let settled=false;
   const finish=()=>{if(settled||!this.disposed&&!ready())return;settled=true;clearTimeout(timer);this.connectionWaiters.delete(finish);this.disposed?reject(new Error('Voice was interrupted.')):resolve()};
   const timer=setTimeout(()=>{if(settled)return;settled=true;this.connectionWaiters.delete(finish);this.retireStream(stream);reject(new Error('Voice connection is reconnecting. Try again.'))},COORDINATION_TIMEOUT_MS);
   this.connectionWaiters.add(finish);finish();
  });
 }
 private connectStream(){
  if(this.disposed)return;
  const previous=this.stream;this.stream=null;this.lastStreamEventAt=null;previous?.close();
  try{
   const stream=new EventSource(`http://127.0.0.1:3219/voice/events?client=${this.id}`);this.stream=stream;
   const current=()=>!this.disposed&&this.stream===stream;
   stream.onopen=()=>{if(!current()||stream.readyState===2)return;this.lastStreamEventAt=Date.now();this.clearReconnect();this.reconnectDelay=INITIAL_RECONNECT_MS;for(const ready of this.connectionWaiters)ready();this.refresh()};
   stream.onerror=()=>{if(!current())return;if(stream.readyState===2)this.scheduleReconnect();this.event({type:'disconnected'})};
   stream.onmessage=e=>{if(!current()||stream.readyState===2)return;try{const data=JSON.parse(e.data);this.lastStreamEventAt=Date.now();if(data.type==='heartbeat')return;if(data.type==='pending')void this.tick();else this.event(data)}catch{}};
  }catch{this.scheduleReconnect();this.event({type:'disconnected'})}
 }
 private async request(path:string,body:any){const controller=new AbortController(),stream=this.stream;let settled=false,timer:ReturnType<typeof setTimeout>|undefined;try{const r=await Promise.race([this.transport(path,{method:'POST',body:JSON.stringify(body),signal:controller.signal}),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{if(settled)return;settled=true;controller.abort();this.retireStream(stream);reject(new Error('Voice coordination timed out'))},COORDINATION_TIMEOUT_MS)})]);if(r.status!==200)throw new Error(r.json?.error||'Voice coordination unavailable');return r.json}finally{settled=true;clearTimeout(timer)}}
 async focus(){
  const mode=this.mode(),trace=this.timingTrace()?.requestId;
  await this.connectionReady();
  // Waiting for a connection may outlive a cancelled turn. It must not take
  // ownership later or initiate any request on behalf of that old turn.
  if(this.disposed||this.mode()!==mode||this.timingTrace()?.requestId!==trace)throw new Error('Voice was interrupted.');
  await this.request('/voice/surface',{id:this.id,kind:this.kind,version:this.info.version,visible:true,mode:'working',focus:true,timingTrace:this.timingTrace()});
 }
 async tick(){
  if(this.disposed)return;
  if(this.mode()!=='idle'||!canShowArtifact())this.artifacts?.cancel();
  // The native heartbeat uses Node timers, so recovery also progresses while Chromium is hidden.
  this.recoverStaleStream();if(this.stream?.readyState===2)this.scheduleReconnect();this.reconnectIfDue();
  const presence=(claim=true)=>({id:this.id,kind:this.kind,version:this.info.version,visible:typeof document==='undefined'||!document.hidden,mode:this.mode(),canPlay:this.canPlay(),claim,timingTrace:this.timingTrace(),...(this.active?{playbackId:this.active.id,playbackStarted:this.active.started}: {})});
  if(this.busy){if(this.active&&this.mode()==='speaking')this.active.started=true;if(this.presenceBusy)return;this.presenceBusy=true;try{await this.request('/voice/surface',presence(false))}catch{}finally{this.presenceBusy=false}return}this.busy=true;
  try{
   if(this.pendingAck){await this.request('/voice/ack',this.pendingAck);this.pendingAck=null}
   // Delivery is independent of audio unlock and expiration. Its ACK must reach
   // the bridge before a completion can claim that the result is on screen.
   try{await this.artifacts?.tick({visible:typeof document==='undefined'||!document.hidden,mode:this.mode()})}catch{}
   if(this.disposed)return;
   const item=await this.request('/voice/surface',presence());
   if(item?.id){let ok=false;this.active={id:item.id,started:false};try{if(!this.disposed&&this.mode()==='idle'&&this.canPlay()){const result=await this.play(item.text);ok=typeof result==='boolean'?result:result.ok;this.active.started ||= typeof result==='object'&&result.started}}finally{this.pendingAck={id:item.id,client:this.id,ok:ok||this.active.started};this.active=null;await this.request('/voice/ack',this.pendingAck);this.pendingAck=null}}

  }catch{}finally{this.busy=false}
 }
 announce(id:string,text:string){return this.request('/voice/announce',{id,text})}
 cancelArtifact(){this.artifacts?.cancel()}
 destroy(){if(this.disposed)return;this.disposed=true;for(const ready of this.connectionWaiters)ready();this.artifacts?.destroy();this.clearReconnect();this.stopHeartbeat?.();this.stopHeartbeat=null;if(typeof document!=='undefined')document.removeEventListener?.('visibilitychange',this.refresh);if(typeof window!=='undefined'){window.removeEventListener?.('focus',this.refresh);window.removeEventListener?.('blur',this.refresh)}this.stream?.close();this.stream=null;void this.request('/voice/leave',{id:this.id}).catch(()=>{})}
}
