import {TIME_ZONE} from '../../obsidian-v2/shared/timezone.mjs';
import {VoiceSession,browserVoiceTransport,type VoiceMode,type VoiceReply,type VoiceReveal} from '../../obsidian-v2/shared/voice-session';
import {LiveSession,initialLive,type LiveActivity,type LiveSnapshot} from '../../obsidian-v2/shared/live-session';
import {liveBridgeFetch} from '../../obsidian-v2/shared/live-surface';
import {localTaskSpeech} from '../../obsidian-v2/shared/task-activity';
import {getWorkSelection,openWork,workFeed,syncWorkReply} from './work';
import {authorizeBridge} from './bridge-auth';
import type {ArtifactOpener} from '../../obsidian-v2/shared/artifact-delivery';
import {createVoicePrefsStore,VOICE_SAMPLE} from '../../obsidian-v2/shared/voice-prefs';
// How voice sounds in this vault (spoken replies on or off, voice, speed), shared with the Obsidian plugin.
export const voicePrefs=createVoicePrefsStore(browserVoiceTransport(undefined,authorizeBridge));
let stopPrefs:()=>void=()=>{};
let session:VoiceSession|null=null;
let live:LiveSession|null=null;
const liveListeners=new Set<(snapshot:LiveSnapshot)=>void>();
let log:(kind:string,text:string)=>void=()=>{},listening:(v:boolean)=>void=()=>{},speaking:(v:boolean)=>void=()=>{},mode:(v:VoiceMode)=>void=()=>{};
let panels:(items:string[])=>void=()=>{},deliverable:(path:string,label:string,liveReport?:boolean)=>void=()=>{},reveal:(item:VoiceReveal,liveReport?:boolean)=>void=()=>{},openDoc:(path:string,liveReport?:boolean)=>void=()=>{};
const noArtifactViewer:ArtifactOpener=async()=>{throw new Error('The dashboard file viewer is unavailable.')};
let artifact:ArtifactOpener=noArtifactViewer;
function get(){
 if(!session){const transport=browserVoiceTransport(undefined,authorizeBridge);session=new VoiceSession(transport,getWorkSelection,'web');
 session.onState=v=>{listening(v==='listening');speaking(v==='speaking');mode(v)};
 session.onMessage=(text,error)=>log(error?'err':'sys',text);
 session.onReveal=r=>reveal(r);
 session.onArtifact=(item,signal)=>artifact(item,signal);
 const showReply=(r:Partial<VoiceReply>,liveReport=false)=>{
  syncWorkReply(r);
  void workFeed.refresh().catch(()=>{});
  if(r.panels?.length)panels(r.panels);
  if(r.deliverable){if(r.reveal==='open')openDoc(r.deliverable,liveReport);else if(!r.reveals?.length)deliverable(r.deliverable,r.deliverable.split('/').pop()||'Report',liveReport)}
  if(r.action==='cockpit')window.scrollTo({top:0});if(r.workIds?.length&&!r.conversationSuperseded)openWork(r.workIds);
  const a=r.obsidian;if(!a)return;
  if(a.op==='cockpit')window.scrollTo({top:0});
  else if(a.op==='daily-note')openDoc(`daily-notes/${new Intl.DateTimeFormat('en-CA',{timeZone:TIME_ZONE}).format(new Date())}.md`,liveReport);
  else if(a.op==='open-note')openDoc(a.query,liveReport);
  else if(a.op==='command'&&a.id==='terminal:open-terminal.default.root')openWork([],true);
  else if(a.op==='web'||a.op==='repo')reveal({kind:'link',target:a.op==='repo'?`https://github.com/${a.slug}`:a.url,label:a.op==='repo'?a.slug:a.label,at:0});
  else log('sys','That workspace action is available in Obsidian.');
 };session.onReply=showReply;session.connect();
 const call=live=new LiveSession({scope:'web',fetch:liveBridgeFetch('web',authorizeBridge),getSelection:getWorkSelection});
 call.onError=message=>log('err',message);
 call.onEffect=r=>{showReply(r,true);for(const item of r.reveals||[])reveal(item,item.kind==='doc');if(r.reply)log('sys',r.reply)};
 call.onArtifact=(item,signal)=>artifact(item,signal);
 call.onActivity=item=>liveActivity(item);
 const created=session;call.onStopLocalAudio=()=>{if(created.mode==='speaking')created.cancel()};
 call.subscribe(snapshot=>{for(const listener of liveListeners)listener(snapshot)});call.connect();
 // The session is told at once, so the very next reply follows the setting.
 // Switching them off stops a reply that is loading or being spoken (voice-session.ts).
 stopPrefs=voicePrefs.subscribe(next=>{const off=!localTaskSpeech(next.prefs.voiceMode)||next.ready&&!next.prefs.spokenReplies;if(off!==created.muted)created.setMuted(off);call.configure(next.prefs)});}
 return session;
}
let liveActivity:(item:LiveActivity)=>void=()=>{};
export const voice={
 init(){get()},onLog(fn:typeof log){log=fn},onPanels(fn:typeof panels){panels=fn},
 onDeliverable(fn:typeof deliverable){deliverable=fn},onReveal(fn:typeof reveal){reveal=fn},onOpenDoc(fn:typeof openDoc){openDoc=fn},
 onArtifact(fn:ArtifactOpener){artifact=fn;return()=>{if(artifact===fn)artifact=noArtifactViewer}},
 onListening(fn:typeof listening){listening=fn},onMode(fn:typeof mode){mode=fn;return()=>{mode=()=>{}}},
 onSpeaking(fn:typeof speaking){speaking=fn;return()=>{speaking=()=>{}}},
 onLiveActivity(fn:(item:LiveActivity)=>void){liveActivity=fn;return()=>{if(liveActivity===fn)liveActivity=()=>{}}},
 onLive(fn:(snapshot:LiveSnapshot)=>void){liveListeners.add(fn);fn(live?.getSnapshot()??initialLive);return()=>{liveListeners.delete(fn)}},
 async startCapture(){await get().start();return get().mode==='listening'},finishCapture(){return get().finish()},
 toggle(){const local=get();return voicePrefs.getSnapshot().prefs.voiceMode==='live'?live?.toggle():local.toggle()},
 sendText(text:string){const local=get(),headers=live?.surfaceHeaders();if(live?.getSnapshot().occupied||live?.isActive()&&!headers)return;return local.sendText(text,headers)},
 syncLiveContext(){live?.pushContext()},
 muteLive(muted:boolean){return live?.setMuted(muted)},
 actionLive(confirm:boolean){return live?.action(confirm)},
 readLiveReport(path:string){if(!live)throw new Error('This Live call has ended.');return live.report(path)},
 dismissLiveCompletion(seq:number){live?.dismissCompletion(seq)},
 stopLive(){return live?.stop()??false},
 stop(reason?:'provider-change'|'target-change'|'local-only'){
  // A provider switch or choosing another terminal moves Live hand-offs on the bridge; neither ends the call
  // (a tab click hung up a call mid-task, 2026-11-22). Only Local voice stops; 'local-only' says so directly.
  const keepLive=reason==='provider-change'||reason==='target-change'||reason==='local-only';
  const stoppedLive=keepLive?false:live?.stop(),current=get(),wasActive=['listening','working','speaking'].includes(current.mode),result=current.cancel(reason==='provider-change'?reason:undefined);
  if(wasActive&&reason==='provider-change')log('sys','Voice stopped after switching providers. Click the orb to start again.');
  return result||stoppedLive;
 },
 speak(text:string){if(localTaskSpeech(voicePrefs.getSnapshot().prefs.voiceMode))get().enqueue(text)},announce(id:string,text:string){return localTaskSpeech(voicePrefs.getSnapshot().prefs.voiceMode)?get().announce(id,text):Promise.resolve()},getLevel(){return live?.isActive()?live.getLevel():session?.getLevel()??null},
 getMode(){return session?.mode??'idle'},
 cancelArtifact(){session?.cancelArtifact()},
 // A short phrase after the voice or speed changes, so the choice is heard. Never while voice is busy or muted.
 sample(){const current=get();if(localTaskSpeech(voicePrefs.getSnapshot().prefs.voiceMode)&&current.mode==='idle'&&!current.muted)current.enqueue(VOICE_SAMPLE)},
 destroy(){stopPrefs();stopPrefs=()=>{};live?.destroy();live=null;void session?.destroy();session=null},
};
