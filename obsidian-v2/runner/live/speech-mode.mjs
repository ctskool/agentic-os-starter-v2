import {randomUUID} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import {readPrivate} from './private-store.mjs';

export const speechUpdate='Update the voice service before starting Live voice.';
export const speechBusy='The voice service is still capturing. Try Live voice again in a moment.';
export const speechRestarted='The voice service restarted. Start a new Live call.';
const boot=value=>typeof value==='string'&&value.length>0;

export function liveSpeechMode({speech,authFile,fetchImpl=fetch,readAuth=()=>readPrivate(authFile,null),now=Date.now,enabled=process.platform==='win32',
 startMs=25000,renewMs=20000,retryMs=220,requestMs=1500,
 timeout=ms=>AbortSignal.timeout(ms),sleep=(ms,signal)=>wait(ms,undefined,{signal})}={}){
 if(!enabled)return null;
 const json=async(path,signal,options={})=>{
  const response=await fetchImpl(speech+path,{...options,redirect:'error',signal:AbortSignal.any([signal,timeout(requestMs)])});
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw new Error(speechRestarted)}
  return response.json();
 };
 const mode=(lease,capture,signal,renew=false)=>json('/mode',signal,{method:'POST',headers:{'Content-Type':'application/json','X-V2-Mode-Secret':lease.secret},
  body:JSON.stringify({capture,lease:lease.id,ttl:60,...(renew?{renew:true}:{})})});
 const acquire=async(ownerSignal)=>{
  const signal=AbortSignal.any([ownerSignal,timeout(startMs)]);
  const health=await json('/health',signal).catch(()=>null);
  if(health?.mode!==true||!boot(health.bootId))throw new Error(speechUpdate);
  const auth=readAuth();
  if(typeof auth?.modeSecret!=='string'||!auth.modeSecret||auth.bootId!==health.bootId)throw new Error(speechRestarted);
  const lease={id:randomUUID(),secret:auth.modeSecret,bootId:health.bootId,renewAt:0,abort:new AbortController()};
  try{
   while(!signal.aborted){
    const result=await mode(lease,'off',signal);
    if(result.bootId!==lease.bootId)throw new Error(speechRestarted);
    if(result.state==='idle'){lease.renewAt=now()+renewMs;return lease}
    if(result.state!=='busy')throw new Error(speechRestarted);
    await sleep(retryMs,signal);
   }
  }catch(error){
   await mode(lease,'on',timeout(requestMs)).catch(()=>{});
   if(!signal.aborted)throw error;
  }
  throw new Error(speechBusy);
 };
 return {
  acquire,
  async renew(lease){
   const result=await mode(lease,'off',lease.abort.signal,true);
   if(result.state!=='idle'||result.bootId!==lease.bootId)throw new Error(speechRestarted);
   lease.renewAt=now()+renewMs;
  },
  due:lease=>lease.renewAt<=now(),
  release(lease){lease.abort.abort();return mode(lease,'on',timeout(requestMs)).catch(()=>{})}
 };
}
