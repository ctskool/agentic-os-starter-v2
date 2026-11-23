const origin='https://api.openai.com';
const sessionId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(id);
export const validLiveSessionId=sessionId;
export class LiveCreateRejected extends Error{}
export function createLiveTransport({httpOrigin=origin,wsOrigin=httpOrigin.replace(/^http/,'ws'),fetchImpl=globalThis.fetch,WebSocketImpl=globalThis.WebSocket}={}){
 return {
  async create(key,body,signal){
   const response=await fetchImpl(httpOrigin+'/v1/live/sessions',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body),signal});
   if(!response.ok){
    // Keep OpenAI's own reason (status, code, short message) so a rejection is diagnosable. Never the key or body.
    let reason='';try{const error=(await response.json())?.error;reason=[error?.code,error?.message].filter(v=>typeof v==='string'&&v).join(': ')}catch{}
    reason=reason.split(key).join('').replace(/sk-[A-Za-z0-9_-]{8,}/g,'').replace(/\s+/g,' ').slice(0,180);
    throw new LiveCreateRejected('OpenAI rejected the Live session request (HTTP '+response.status+(reason?' '+reason:'')+').');
   }
   const data=await response.json(),id=data?.session?.id;
   if(!sessionId(id))throw new Error('Live session response did not include a session ID.');
   // Keep a valid ID even if the SDP is missing so recovery can close it.
   return {id,answerSdp:data.transport?.sdp??data.transport?.answer_sdp??data.answer_sdp??data.sdp};
  },
  attach(key,id,{signal,onEvent,onLoss}){
   if(!sessionId(id))throw new Error('Invalid Live session ID.');
   return new Promise((resolve,reject)=>{
    if(signal.aborted)return reject(signal.reason);
    // Node 22's WebSocket accepts the Undici WebSocketInit dictionary.
    const socket=new WebSocketImpl(wsOrigin+'/v1/live/sessions/'+id+'/attach',{headers:{Authorization:'Bearer '+key}});
    let opened=false, intentional=false,lost=false;
    const forget=()=>signal.removeEventListener('abort',abort);
    const close=()=>{intentional=true;forget();try{socket.close()}catch{}};
    const abort=()=>{close();if(!opened)reject(signal.reason)};
    const loss=()=>{if(lost||intentional)return;lost=true;close();if(opened)onLoss();else reject(new Error('Live sideband could not attach.'))};
    signal.addEventListener('abort',abort,{once:true});
    socket.addEventListener('open',()=>{if(intentional)return;opened=true;forget();resolve({send:event=>socket.send(JSON.stringify(event)),close})},{once:true});
    socket.addEventListener('message',({data})=>{if(intentional||typeof data!=='string'||data.length>1000000)return;let event;try{event=JSON.parse(data)}catch{return}onEvent(event)});
    socket.addEventListener('close',loss,{once:true});socket.addEventListener('error',loss,{once:true});
   });
  }
 };
}
