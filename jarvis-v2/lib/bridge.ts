import {authorizedBridgeFetch} from '../../obsidian-v2/shared/bridge-auth';
import {authorizeBridge} from './bridge-auth';
export async function bridge(path:string,body?:unknown,timeoutMs=5000){
 const r=await authorizedBridgeFetch('http://127.0.0.1:3219'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(timeoutMs)},authorizeBridge);
 const result=await r.json();if(!r.ok)throw Object.assign(new Error(result.error||'V2 bridge unavailable'),typeof result.code==='string'?{code:result.code}:{});return result;
}
