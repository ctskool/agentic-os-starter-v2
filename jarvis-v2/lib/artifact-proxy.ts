import {artifactMime,ARTIFACT_MIMES,readArtifactBytes,validArtifactId} from './artifact-viewer';

// Only registry IDs cross this proxy. Paths, external URLs, credentials and
// upstream HTML/error pages are never passed through to a browser document.
export async function artifactResponse(request:Request,fetcher:typeof fetch=fetch){
 const url=new URL(request.url),ids=url.searchParams.getAll('id');
 if(ids.length!==1||!validArtifactId(ids[0]))return Response.json({error:'A valid saved file reference is required.'},{status:400});
 try{
  const response=await fetcher('http://127.0.0.1:3219/artifacts/file?id='+encodeURIComponent(ids[0]),{cache:'no-store',redirect:'error',signal:AbortSignal.any([request.signal,AbortSignal.timeout(15000)])});
  if(!response.ok){await response.body?.cancel();return Response.json({error:response.status===409?'The saved file changed.':'The saved file is unavailable.'},{status:response.status===409?409:404})}
  const mime=artifactMime(response.headers.get('content-type')||'');if(!ARTIFACT_MIMES.has(mime)){await response.body?.cancel();return Response.json({error:'This file format cannot be displayed.'},{status:415})}
  const bytes=await readArtifactBytes(response,request.signal);
  return new Response(bytes,{headers:{'Content-Type':mime,'Content-Length':String(bytes.byteLength),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; sandbox",'Content-Disposition':'inline'}});
 }catch{return Response.json({error:'The saved file could not be loaded.'},{status:502})}
}
