import type {BridgeAuthorization} from './bridge-auth';

export type LiveScope='native'|'web';
export type LiveFetch=(path:string,options?:RequestInit)=>Promise<Response>;
export interface LiveSurfaceLease {surfaceId:string;surfaceSecret:string}
export function liveBridgeFetch(scope:LiveScope,authorize:BridgeAuthorization,base='http://127.0.0.1:3219'):LiveFetch{
 return async(path,options={})=>{
  const send=async(refresh=false)=>{
   const token=await authorize(refresh);
   options.signal?.throwIfAborted();
   const headers=new Headers(options.headers);
   headers.set('X-V2-App',scope);headers.set('X-V2-Token',token);
   return fetch(base+path,{...options,headers,cache:'no-store'});
  };
  const response=await send();
  if(response.status!==401)return response;
  await response.body?.cancel();
  return send(true);
 };
}
export const jsonPost=(body:unknown,options:RequestInit={}):RequestInit=>{
 const headers=new Headers(options.headers);headers.set('Content-Type','application/json');
 return {...options,method:'POST',headers,body:JSON.stringify(body)};
};
export class LiveHttpError extends Error {
 constructor(readonly status:number,message:string){super(message)}
}
export async function liveJSON(request:LiveFetch,path:string,options?:RequestInit){
 const response=await request(path,options);
 let data;try{data=await response.json()}catch{}
 if(!response.ok)throw new LiveHttpError(response.status,typeof data?.error==='string'?data.error:'Live voice is unavailable.');
 return data;
}
export async function registeredStream(request:LiveFetch,lease:LiveSurfaceLease,signal:AbortSignal){
 const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),5000);
 const response=await request('/voice/events?client='+encodeURIComponent(lease.surfaceId),{
  signal:AbortSignal.any([signal,deadline.signal]),headers:{'X-V2-Surface-Secret':lease.surfaceSecret}
 }).finally(()=>clearTimeout(timer));
 if(!response.ok||!response.body)throw new LiveHttpError(response.status,'Live surface connection could not open.');
 return response.body.getReader();
}
export async function readSurfaceEvents(reader:ReadableStreamDefaultReader<Uint8Array>,onEvent:(event:any)=>void){
 const decoder=new TextDecoder();let pending='';
 try{
  while(true){
   const {done,value}=await reader.read();
   if(done)break;
   pending+=decoder.decode(value,{stream:true});
   let boundary;
   while((boundary=/\r?\n\r?\n/.exec(pending))){
    const frame=pending.slice(0,boundary.index);
    pending=pending.slice(boundary.index+boundary[0].length);
    const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
    if(!data)continue;
    let event;try{event=JSON.parse(data)}catch{continue}
    onEvent(event);
   }
   if(pending.length>65536)throw new Error('Live surface event was too large.');
  }
 }finally{reader.releaseLock()}
}
