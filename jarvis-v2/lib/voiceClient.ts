import {TIME_ZONE} from '../../obsidian-v2/shared/timezone.mjs';
import {VoiceSession,browserVoiceTransport,type VoiceMode,type VoiceReveal} from '../../obsidian-v2/shared/voice-session';
import {getWorkSelection,openWork,workFeed,syncWorkReply} from './work';
import {authorizeBridge} from './bridge-auth';
import type {ArtifactOpener} from '../../obsidian-v2/shared/artifact-delivery';
let session:VoiceSession|null=null;
let log:(kind:string,text:string)=>void=()=>{},listening:(v:boolean)=>void=()=>{},speaking:(v:boolean)=>void=()=>{},mode:(v:VoiceMode)=>void=()=>{};
let panels:(items:string[])=>void=()=>{},deliverable:(path:string,label:string)=>void=()=>{},reveal:(item:VoiceReveal)=>void=()=>{},openDoc:(path:string)=>void=()=>{};
const noArtifactViewer:ArtifactOpener=async()=>{throw new Error('The dashboard file viewer is unavailable.')};
let artifact:ArtifactOpener=noArtifactViewer;
function get(){
 if(!session){const transport=browserVoiceTransport(undefined,authorizeBridge);session=new VoiceSession(transport,getWorkSelection,'web');
 session.onState=v=>{listening(v==='listening');speaking(v==='speaking');mode(v)};
 session.onMessage=(text,error)=>log(error?'err':'sys',text);
 session.onReveal=r=>reveal(r);
 session.onArtifact=(item,signal)=>artifact(item,signal);
 session.onReply=r=>{
  syncWorkReply(r);
  void workFeed.refresh().catch(()=>{});
  if(r.panels?.length)panels(r.panels);
  if(r.deliverable){if(r.reveal==='open')openDoc(r.deliverable);else if(!r.reveals?.length)deliverable(r.deliverable,r.deliverable.split('/').pop()||'Report')}
  if(r.action==='cockpit')window.scrollTo({top:0});if(r.workIds?.length&&!r.conversationSuperseded)openWork(r.workIds,true);
  const a=r.obsidian;if(!a)return;
  if(a.op==='cockpit')window.scrollTo({top:0});
  else if(a.op==='daily-note')openDoc(`daily-notes/${new Intl.DateTimeFormat('en-CA',{timeZone:TIME_ZONE}).format(new Date())}.md`);
  else if(a.op==='open-note')openDoc(a.query);
  else if(a.op==='command'&&a.id==='terminal:open-terminal.default.root')openWork();
  else if(a.op==='web'||a.op==='repo')reveal({kind:'link',target:a.op==='repo'?`https://github.com/${a.slug}`:a.url,label:a.op==='repo'?a.slug:a.label,at:0});
  else log('sys','That workspace action is available in Obsidian.');
 };session.connect();}
 return session;
}
export const voice={
 init(){get()},onLog(fn:typeof log){log=fn},onPanels(fn:typeof panels){panels=fn},
 onDeliverable(fn:typeof deliverable){deliverable=fn},onReveal(fn:typeof reveal){reveal=fn},onOpenDoc(fn:typeof openDoc){openDoc=fn},
 onArtifact(fn:ArtifactOpener){artifact=fn;return()=>{if(artifact===fn)artifact=noArtifactViewer}},
 onListening(fn:typeof listening){listening=fn},onMode(fn:typeof mode){mode=fn;return()=>{mode=()=>{}}},
 onSpeaking(fn:typeof speaking){speaking=fn;return()=>{speaking=()=>{}}},
 async startCapture(){await get().start();return get().mode==='listening'},finishCapture(){return get().finish()},toggle(){return get().toggle()},
 sendText(text:string){return get().sendText(text)},
 stop(reason?:'provider-change'){
  const current=get(),wasActive=['listening','working','speaking'].includes(current.mode),result=current.cancel(reason);
  if(wasActive&&reason==='provider-change')log('sys','Voice stopped after switching providers. Click the orb to start again.');
  return result;
 },
 speak(text:string){get().enqueue(text)},announce(id:string,text:string){return get().announce(id,text)},getLevel(){return session?.getLevel()??null},
 getMode(){return session?.mode??'idle'},
 cancelArtifact(){session?.cancelArtifact()},
 destroy(){void session?.destroy();session=null},
};
