import {requestUrl} from 'obsidian';
import type {VoiceTransport} from '../../shared/voice-session';
import type {App} from 'obsidian';
let tokenReader:(()=>Promise<string>)|undefined;
let cachedToken:string|undefined;
export function configureVoiceTransport(app:App,pluginDirectory:string){
 const adapter=app.vault.adapter as typeof app.vault.adapter & {getBasePath?:()=>string};
 cachedToken=undefined;
 // The browser preview's requestUrl shim supplies its own same-origin authorization.
 tokenReader=adapter.getBasePath?async()=>{
  try{
   const value=JSON.parse(await adapter.read(`${pluginDirectory}/bridge-auth.json`));
   if(value.version===1&&typeof value.token==='string'&&/^[a-f0-9]{64}$/.test(value.token))return value.token;
  }catch{}
  throw new Error('Bridge connection is unavailable. Start the V2 bridge for this vault and try again.');
 }:undefined;
}
async function authorization(refresh=false){
 if(refresh)cachedToken=undefined;
 if(!tokenReader)return undefined;
 return cachedToken??(cachedToken=await tokenReader());
}
export async function assertVoiceVault(app:App){
 const adapter=app.vault.adapter as typeof app.vault.adapter & {getBasePath?:()=>string};
 if(!adapter.getBasePath)return; // Browser preview is served from the bridge's configured vault.
 const r=await requestUrl({url:'http://127.0.0.1:3219/state',throw:false});
 const normalize=(s:string)=>s.replace(/\\/g,'/').toLowerCase();
 if(r.status!==200||normalize(r.json.vault)!==normalize(adapter.getBasePath()))throw new Error('Voice bridge is connected to a different vault. Start V2 for this vault before speaking.');
}
export const v2VoiceTransport:VoiceTransport=async(path,options={})=>{
 const method=(options.method||'GET').toUpperCase(),native=!!tokenReader;
 const send=async(refresh=false)=>{
  options.signal?.throwIfAborted();
  // Native reads carry the same app identity as writes. Work polling must not
  // accidentally restore a bridge-owned web conversation into an Obsidian tab.
  const token=native?await authorization(refresh):undefined;
  // requestUrl cannot cancel an already-sent request, but credential reads and
  // restart retries must never submit new work after the caller cancels.
  options.signal?.throwIfAborted();
  return requestUrl({url:'http://127.0.0.1:3219'+path,method,headers:{'Content-Type':'application/json',...options.headers,...(native?{'X-V2-App':'native'}:{}),...(token?{'X-V2-Token':token}:{})},body:options.body,throw:false});
 };
 let r=await send();
 // A 401 is returned before dispatch, so refreshing a rotated token cannot repeat work.
 if(r.status===401&&native)r=await send(true);
 return r.headers['content-type']?.includes('audio/')?{status:r.status,audio:r.arrayBuffer}:{status:r.status,json:r.json};
};
