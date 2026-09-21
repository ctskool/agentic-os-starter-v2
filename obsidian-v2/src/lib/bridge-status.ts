import {v2VoiceTransport} from './v2-voice';
// Provider controls and the dashboard share a lightweight, short-lived status sample.
let sample:any=null,expires=0,flight:Promise<any>|null=null;
export function readBridgeStatus():Promise<any>{
 if(sample&&Date.now()<expires)return Promise.resolve(sample);
 if(flight)return flight;
 flight=v2VoiceTransport('/status',{}).then(r=>{
  if(r.status!==200)throw new Error('Terminal bridge offline');
  sample=r.json;expires=Date.now()+1000;return sample;
 }).finally(()=>{flight=null});
 return flight;
}
