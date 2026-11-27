import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {ROOT,validateSelection} from '../shared/contract.mjs';
import {vaultPath,writeJson} from './core.mjs';
import {readJson,routeVoice} from './bridge-core.mjs';
import {readCurrentState,readConversationEpoch,reconcileCurrent,setCurrent} from './current-conversations.mjs';
import {preconnectJev,prepareJev} from './jev.mjs';
import {executeFastVoice,prepareFastVoice} from './fast-voice.mjs';
import {voiceReceiptTransport} from './voice-receipts.mjs';

export const voiceRequestId=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
const digest=action=>createHash('sha256').update(JSON.stringify(action)).digest('hex');

export function voiceJson(root,appScope,json,full,cached=false){
 const {decision:_decision,origin:_origin,transport:_transport,liveCallId:_liveCallId,...value}=full;
 if(value.conversationResetError)return json({error:value.conversationResetError},400);
 try{
  const {revision,...current}=readCurrentState(root,appScope);
  const conversationSuperseded=value.conversationSuperseded||(value.conversationEpoch??0)!==readConversationEpoch(root,value.provider,appScope);
  return json({...value,...(conversationSuperseded?{conversationSuperseded:true}:{}),current,currentRevision:revision});
 }catch(error){if(cached)return json(value);throw error}
}

// Keep the body and work header lazy: a cancelled or replayed request never
// reads its body, and a malformed work header keeps its transcript diagnostic.
export function handleVoiceHttp(ctx,req,res,{body,json,appScope,source}){
 return handleVoiceRequest(ctx,{
  id:req.headers['x-v2-request'],readSelection:()=>JSON.parse(req.headers['x-v2-selection']||'null'),
  readTranscript:async()=>JSON.parse((await body(req)).toString()).transcript,
  readAudio:()=>body(req,8*1024*1024),contentType:req.headers['content-type']||'audio/webm',
  readWork:()=>JSON.parse(req.headers['x-v2-work']||'null'),surface:req.headers['x-v2-surface'],
  appScope,origin:req.headers['x-v2-origin']==='test'?'test':'live',
  watchDisconnect:abort=>{
   const disconnected=()=>{if(!res.writableEnded)abort()};
   res.on('close',disconnected);if(res.destroyed)disconnected();
   return ()=>res.off('close',disconnected);
  },
  respond:(result,cached)=>voiceJson(ctx.root,appScope,json,result,cached)
 },{source});
}

// In-process callers supply the transcript and captured scope directly.
// Commit uses the original request ID and utterance from the proposed action.
export async function handleVoiceRequest(ctx,request,{source='text',guard,phase,plannedAction,transport=source==='live'?'live':'local'}={}){
 const {root,terminals,hub,artifacts,artifactTarget,active,speech,route=routeVoice,routeOptions={},fetchAudio=fetch,write=writeJson}=ctx;
 const {id,appScope='web',origin='live',respond=result=>result}=request;
 if(!voiceRequestId(id))throw new Error('Invalid request ID');
 const chosen=validateSelection(request.readSelection?request.readSelection():request.selection);
 if(fs.existsSync(vaultPath(root,`${ROOT}/voice-cancelled/${id}.json`)))throw new Error('Voice request cancelled');
 const receipt=readJson(root,`${ROOT}/voice-results/${id}.json`,null);
 if(receipt){
  if((receipt.appScope||'web')!==appScope||receipt.provider!==chosen.provider||(receipt.requestedWorkerModel??receipt.workerModel)!==chosen.model||voiceReceiptTransport(receipt)!==transport||transport==='live'&&receipt.liveCallId!==request.liveCallId)throw new Error('Request ID already belongs to a different selection');
  const result={...receipt,transport:voiceReceiptTransport(receipt)};
  return respond(phase==='plan'?{kind:'read',...result}:result,true);
 }
 // Local detects corrupt settings before claiming or reading the body.
 // Commit checks stale context read-only so a refusal cannot change it.
 if(phase!=='commit')reconcileCurrent(root,terminals,{scope:appScope});
 const conversationEpoch=request.conversationEpoch??readConversationEpoch(root,chosen.provider,appScope);
 if(active.size)throw new Error('Another voice request is being processed. Wait or cancel it first.');
 const controller=new AbortController();active.set(id,controller);
 const unwatch=request.watchDisconnect?.(()=>controller.abort());
 const claim=`${ROOT}/voice-requests/${id}.json`;
 let prepared=null,claimed=false,stage='receiving',diagnostic={id,...chosen,ts:new Date().toISOString(),appScope,source};
 // Failure evidence belongs to the claim, never to successful voice memory.
 const recordDiagnostic=fields=>{if(claimed){diagnostic={...diagnostic,stage,...fields,updatedAt:new Date().toISOString()};try{write(root,claim,diagnostic)}catch{}}};
 try{
  const exists=fs.existsSync(vaultPath(root,claim));
  if(phase==='commit'){
   const previous=exists?readJson(root,claim,null):null;
   if(!plannedAction||previous?.stage!=='completed'||previous.plannedDigest!==digest(plannedAction))throw new Error('This voice request has no available planned action.');
  }else if(exists)throw new Error('This voice request was already submitted. Start a new request to retry.');
  if(phase!=='commit'){write(root,claim,{...diagnostic,stage});claimed=true}
  let transcript;
  if(source!=='audio')transcript=request.readTranscript?await request.readTranscript():request.transcript;
  else{
   const audio=await request.readAudio();if(audio.length<1000)throw new Error('Recording was too short.');
   stage='transcribing';preconnectJev();try{prepareJev({provider:chosen.provider})}catch{}
   // Overlap the small model's startup with transcription. The handle is
   // discarded even if transcription fails or the request is cancelled.
   try{prepared=prepareFastVoice(root,chosen)}catch{}
   const stt=await fetchAudio(`${speech}/stt`,{method:'POST',headers:{'Content-Type':request.contentType||'audio/webm'},body:audio,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
   if(!stt.ok)throw new Error('Local transcription failed. Check the V2 speech service.');transcript=(await stt.json()).text;
  }
  stage='validating';if(typeof transcript==='string')diagnostic.transcript=transcript.slice(0,4000);
  if(controller.signal.aborted)throw new Error('Voice request cancelled');
  const work=request.readWork?.(),workTarget=request.readWork?work?.targetId||null:request.workTarget??null;
  const terminalMode=request.readWork?!!work:request.terminalMode??Object.hasOwn(request,'workTarget');
  if(voiceRequestId(workTarget))diagnostic.workTarget=workTarget;
  const supplied=typeof request.surface==='string'?request.surface:null;
  const surface=supplied?hub?.live().find(item=>item.id===supplied):null;
  if(supplied&&(!surface||surface.kind!==appScope))throw new Error('Voice surface belongs to another app or is disconnected.');
  const client=supplied||hub?.live().find(item=>item.id===hub.owner&&item.kind===appScope)?.id;
  const target=artifactTarget?.(client,chosen.provider,conversationEpoch,appScope)??null;
  stage='routing';recordDiagnostic({});
  const result=await route(root,{id,transcript,selection:chosen,terminalMode,workTarget,conversationEpoch,appScope,origin,...(transport==='live'?{liveCallId:request.liveCallId,liveTurns:request.liveTurns,liveIntent:request.liveIntent,liveTaskIds:request.liveTaskIds}:{})},controller.signal,prepared?(vault,job,prompt,options)=>executeFastVoice(vault,job,prompt,options,{prepared}):undefined,terminals,{
   updateCurrent:change=>setCurrent(root,terminals,{...change,scope:appScope}),
   ...(artifacts?{
    onDispatch:(taskId,epoch)=>artifacts.bind(taskId,target?{...target,epoch}:null),
    reopenArtifact:({id:requestId,taskId,artifact},check)=>{
     if(!target)throw new Error('No connected dashboard can display that file right now.');
     const task=terminals.get(taskId);
     artifacts.bind(taskId,{...target,epoch:conversationEpoch});
     const turn={id:`reopen:${requestId}`,artifacts:[{...artifact,open:true,isFinal:true}]};
     check?.('publishArtifact',{taskId,artifact,turnId:turn.id,target});
     if(!artifacts.publish(task,turn,''))throw new Error('That file was already queued to open.');
     hub.emit({type:'pending'});
    }
   }:{}),...routeOptions,guard,phase,plannedAction,transport,handoffTarget:target,
   // Consume the staged claim after read-only validation, before any effect.
   beforeCommit:()=>{write(root,claim,{...diagnostic,stage:'committing'});claimed=true}
  });
  // A plan becomes available only after its exact contents can be checked
  // against the durable claim. Local success diagnostics remain best-effort.
  if(phase==='plan'&&result.kind==='action'){
   stage='completed';write(root,claim,{...diagnostic,stage,plannedDigest:digest(result.action),completedAt:new Date().toISOString()});
   return respond(result);
  }
  stage='responding';const response=respond(result);stage='completed';recordDiagnostic({completedAt:new Date().toISOString()});return response;
 }catch(error){recordDiagnostic({error:String(error?.message||error).slice(0,1000),failedAt:new Date().toISOString(),cancelled:controller.signal.aborted});throw error}
 finally{unwatch?.();active.delete(id);prepared?.discard()}
}
