import type {VoiceArtifact} from '../../obsidian-v2/shared/artifact-delivery';

export const MAX_ARTIFACT_BYTES=32*1024*1024;
export const ARTIFACT_MIMES=new Set(['image/png','image/jpeg','image/webp','image/gif','application/pdf','text/markdown','text/plain']);
export const validArtifactId=(id:unknown):id is string=>typeof id==='string'&&/^[A-Za-z0-9_-]{16,128}$/.test(id);
export const artifactMime=(mime:string)=>mime.split(';')[0].trim().toLowerCase();
export const artifactUrl=(id:string)=>{if(!validArtifactId(id))throw new Error('The saved file reference is invalid.');return '/api/artifact?id='+encodeURIComponent(id)};
export function validateArtifact(artifact:VoiceArtifact){
 if(!artifact||!validArtifactId(artifact.id)||!ARTIFACT_MIMES.has(artifactMime(artifact.mime))||!Number.isInteger(artifact.bytes)||artifact.bytes<0||artifact.bytes>MAX_ARTIFACT_BYTES)throw new Error('This saved file cannot be displayed here.');
}
export interface ArtifactView {artifact:VoiceArtifact;generation:number}

// A display receipt means a viewer has loaded, not merely that React state was
// queued. A stale image/PDF callback cannot approve a replacement file.
export class ArtifactPresenter {
 private next=0;private disposed=false;
 private pending:{generation:number;resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;cleanup:()=>void}|null=null;
 constructor(private show:(view:ArtifactView|null)=>void,private timeoutMs=18000){}
 open(artifact:VoiceArtifact,signal?:AbortSignal):Promise<void>{
  if(this.disposed||signal?.aborted)return Promise.reject(new Error('Opening was cancelled.'));
  try{validateArtifact(artifact)}catch(error){return Promise.reject(error)}
  this.rejectPending('Another file replaced this preview.');const generation=++this.next;
  return new Promise((resolve,reject)=>{
   const abort=()=>{if(this.pending?.generation!==generation)return;this.rejectPending('Opening was cancelled.');this.show(null)};
   const timer=setTimeout(()=>{if(this.pending?.generation!==generation)return;this.rejectPending('The file took too long to open.');this.show(null)},this.timeoutMs);
   this.pending={generation,resolve,reject,timer,cleanup:()=>signal?.removeEventListener('abort',abort)};
   signal?.addEventListener('abort',abort,{once:true});
   if(signal?.aborted){abort();return}
   try{this.show({artifact:{...artifact},generation})}catch{this.rejectPending('The dashboard preview could not be opened.')}
  });
 }
 loaded(generation:number){const pending=this.pending;if(pending?.generation!==generation)return;this.pending=null;clearTimeout(pending.timer);pending.cleanup();pending.resolve()}
 failed(generation:number,message='The saved file could not be displayed.'){if(this.pending?.generation===generation)this.rejectPending(message)}
 close(){this.rejectPending('The preview was closed before the file loaded.');this.show(null)}
 private rejectPending(message:string){const pending=this.pending;if(!pending)return;this.pending=null;clearTimeout(pending.timer);pending.cleanup();pending.reject(new Error(message))}
 destroy(){this.disposed=true;this.rejectPending('The dashboard was closed before the file loaded.')}
}

export async function readArtifactBytes(response:Response,signal?:AbortSignal){
 const declared=response.headers.get('content-length');
 if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX_ARTIFACT_BYTES)){await response.body?.cancel();throw new Error('The saved file is too large to preview.');}
 const reader=response.body?.getReader();if(!reader)return new Uint8Array(0);
 const parts:Uint8Array[]=[];let size=0;
 const abort=()=>{void reader.cancel(new Error('Opening was cancelled.')).catch(()=>{})};signal?.addEventListener('abort',abort,{once:true});
 try{while(true){if(signal?.aborted)throw new Error('Opening was cancelled.');const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_ARTIFACT_BYTES)throw new Error('The saved file is too large to preview.');parts.push(value)}if(signal?.aborted)throw new Error('Opening was cancelled.')}catch(error){await reader.cancel().catch(()=>{});throw error}finally{signal?.removeEventListener('abort',abort);reader.releaseLock()}
 const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.byteLength}return bytes;
}

export async function loadArtifact(artifact:VoiceArtifact,signal:AbortSignal,fetcher:typeof fetch=fetch){
 validateArtifact(artifact);const response=await fetcher(artifactUrl(artifact.id),{cache:'no-store',signal});
 if(!response.ok)throw new Error(response.status===409?'The saved file changed. Ask for its current version.':'The saved file is unavailable.');
 const mime=artifactMime(response.headers.get('content-type')||'');if(mime!==artifactMime(artifact.mime)||!ARTIFACT_MIMES.has(mime)){await response.body?.cancel();throw new Error('The saved file has an unsupported format.');}
 const bytes=await readArtifactBytes(response,signal);if(signal.aborted)throw new Error('Opening was cancelled.');
 if(bytes.byteLength!==artifact.bytes)throw new Error('The saved file changed while it was opening.');
 return {mime,blob:new Blob([bytes],{type:mime}),text:mime.startsWith('text/')?new TextDecoder().decode(bytes):null};
}
