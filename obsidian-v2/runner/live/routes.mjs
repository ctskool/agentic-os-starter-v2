import {validateSelection} from '../../shared/contract.mjs';
import {LiveCalls} from './calls.mjs';
import {clientStopReason} from './call-log.mjs';
import {LiveSurfaces} from './surfaces.mjs';
import {LiveDelegations} from './delegations.mjs';
import {readLiveVoiceReport} from '../voice-documents.mjs';

export function createLiveBridge({hub,listeners,active,stopLocalAudio=()=>{},readEpoch=()=>0,readContext,requestContext,delegationHandle,delegationLimits,delegationTiming,...options}){
 const surfaces=new LiveSurfaces(options);
 const calls=new LiveCalls({...options,
  ownerIsCurrent:(id,scope)=>surfaces.entries.get(id)?.connected&&listeners.has(id)&&hub.live().some(client=>client.id===id&&client.kind===scope)&&(hub.owner||hub.preferred(true)?.id)===id,
  // Starting a call needs voice ownership; keeping one needs only its own window still connected. Another window
  // taking focus or a late check-in no longer ends a call: only End call does (Chase, 2026-11-22).
  surfaceAlive:id=>!!surfaces.entries.get(id)?.connected&&listeners.has(id),
  // The same four checks, reported one by one when a call is ended for ownership (live-calls.jsonl). No IDs or secrets.
  ownerDetail:(id,scope)=>{
   const seen=hub.clients?.get(id),owner=hub.owner||hub.preferred(true)?.id||null,ownerKind=owner?hub.clients?.get(owner)?.kind??'unknown':null;
   return {surfaceConnected:!!surfaces.entries.get(id)?.connected,eventStream:listeners.has(id),checkedInSecondsAgo:seen?Math.round((Date.now()-seen.ts)/1000):null,
    isOwner:owner===id,...(owner!==id?{ownerIs:owner?(owner.startsWith('live-')?'another Live window':ownerKind+' window'):'nobody'}:{}),scope};
  },
  localBusy:()=>active.size>0,
  holdAudio:async()=>{
   hub.holdLiveAudio();
   stopLocalAudio();
   // Started announcements count as attempted. Unstarted ones remain
   // pending for the usual grouped delivery after the call.
   const until=Date.now()+1500;
   while(calls.audioHeld&&hub.hasPlaybackLease()&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,40));
   if(calls.audioHeld)hub.settlePlayback();
  },
  releaseAudio:()=>hub.releaseLiveAudio()
 });
 if(readContext&&requestContext)calls.delegations=new LiveDelegations({active,context:readContext,requestContext,
  valid:call=>calls.current(call)&&calls.surfaceAlive(call.ownerSurface,call.appScope),prefs:calls.prefs,now:calls.now,handle:delegationHandle,limits:delegationLimits,timing:delegationTiming});
 return {
  calls,surfaces,
  sweep(){surfaces.sweep();return calls.sweep()},
  surfaceGone(id){
   surfaces.revoke(id);
   if(surfaces.registered(id)){const stream=listeners.get(id);listeners.delete(id);stream?.end()}
   if(calls.call?.ownerSurface===id)void calls.invalidate('Voice surface disconnected.');
  },
  verifySurface(id,scope,secret){surfaces.verify(id,scope,secret)},
  async handle({url,req,res,appScope,body,json,acceptsToken,uuid}){
   const route=url.pathname,method=req.method;
   if(!acceptsToken()||req.headers['x-v2-app']!==appScope)return json({error:'Bridge authentication required'},401);
   if(route==='/voice/surface/register'&&method==='POST')return json(surfaces.register(appScope));
   const surface=req.headers['x-v2-surface'],secret=req.headers['x-v2-call'];
   if(route==='/voice/live/start'&&method==='POST'){
    const data=JSON.parse((await body(req,110000)).toString());
    const {surfaceId,sdp}=data;
    surfaces.require(surfaceId,appScope,req.headers['x-v2-surface-secret']??data.surfaceSecret,true);
    return json(await calls.start({ownerSurface:surfaceId,appScope,sdp}));
   }
   const call=calls.owner(surface,appScope,secret);
   if(route==='/voice/live/status'&&method==='GET')return json({...calls.status(call),...(!calls.audioHeld?{authorization:calls.authorization()}: {})});
   if(!call)return json({error:'Live call authentication required'},403);
   if(route==='/voice/live/stop'&&method==='POST'){
    // The window says why it hung up ("hung up" for the user's own button), so the call log can tell the two apart.
    let reason='hung up';try{reason=clientStopReason(JSON.parse((await body(req,2000)).toString()||'{}').reason)}catch{}
    if(calls.call===call)void calls.invalidate('Window: '+reason);return json({ok:true});
   }
   if(route==='/voice/live/rollover'&&method==='POST'){
    const {sdp}=JSON.parse((await body(req,110000)).toString());
    return json(await calls.rollover(call,sdp));
   }
   if(route==='/voice/live/mute'&&method==='POST'){
    const {muted}=JSON.parse((await body(req)).toString());calls.mute(call,muted);
    return json({ok:true});
   }
   if(['/voice/live/confirm','/voice/live/cancel'].includes(route)&&method==='POST'){
    const {actionId}=JSON.parse((await body(req)).toString());
    if(!uuid(actionId))return json({error:'Invalid Live action ID.'},400);
    try{
     if(!calls.delegations||!calls.current(call))throw new Error('That action is no longer available. Say the request again.');
     return json(await (route.endsWith('/confirm')?calls.delegations.confirm(call,actionId):calls.delegations.cancel(call,actionId)));
    }catch(error){return json({error:error.message},409)}
   }
   if(route==='/voice/live/report'&&method==='GET'){
    if(!calls.current(call)||!calls.surfaceAlive(call.ownerSurface,appScope))return json({error:'Live call authentication required'},403);
    try{return json(readLiveVoiceReport(options.root,url.searchParams.get('path')||'',call.answers?.reports))}
    catch{return json({error:'This report is unavailable in this Live call.'},404)}
   }
   if(route==='/voice/live/context'&&method==='GET')return json({conversationEpoch:readEpoch(call.provider,appScope)});
   if(route==='/voice/live/context'&&method==='POST'){
    const {selection,workTarget,appScope:scope,conversationEpoch,peerConnected,gen}=JSON.parse((await body(req)).toString());
    if(scope!==appScope||workTarget!==null&&!uuid(workTarget)||!Number.isSafeInteger(conversationEpoch)||conversationEpoch<0||peerConnected!==undefined&&peerConnected!==true)throw new Error('Invalid Live voice context.');
    const chosen=validateSelection(selection);
    if(!calls.current(call))throw new Error('Live call has ended.');
    // A Live call survives a provider switch; the switch only moves where new hand-offs go.
    if(chosen.provider!==call.provider)calls.switchProvider(call,chosen.provider);
    const target=calls.routeGeneration(call,gen);
    target.context={selection:chosen,workTarget,appScope,conversationEpoch};
    if(peerConnected)calls.peerConnected(target);
    return json({ok:true});
   }
   if(route==='/voice/live/updates'&&method==='GET'){
    const cursor=url.searchParams.get('cursor')??'0',gone=new AbortController();
    if(!/^\d+$/.test(cursor))throw new Error('Invalid Live updates cursor.');
    const disconnect=()=>gone.abort();res.on('close',disconnect);if(res.destroyed)disconnect();
    try{const result=await call.updates.poll(Number(cursor),gone.signal);if(!res.destroyed)return json(result)}
    finally{res.off('close',disconnect)}
    return;
   }
   return json({error:'Live voice route not found'},404);
  }
 };
}
