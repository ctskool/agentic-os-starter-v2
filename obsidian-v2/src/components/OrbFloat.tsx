import {applyVoiceAction,openVoiceArtifact} from "../lib/voice-actions";
import {readRun} from '../lib/queue';
import {h} from 'preact';
import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'preact/hooks';
import type ChaseCommandCenter from '../main';
import {useProvider} from '../lib/provider';
import {v2VoiceTransport,assertVoiceVault} from '../lib/v2-voice';
import {VoiceSession,type VoiceMode} from '../../shared/voice-session';
import GalaxyCore from './GalaxyCore';
import {GraphCore} from './GraphCore';
import {workFeed,workTarget,chooseWork,openWork,workConversations,setWorkProvider,type WorkTask} from '../lib/work';
import {shortConversationTitle} from '../../shared/work-presentation';
export function OrbFloat({plugin,surfaceKind='native'}:{plugin:ChaseCommandCenter;surfaceKind?:'web'|'native'}){
 const state=useProvider(plugin.app);
 const clampPosition=(right:number,bottom:number)=>({right:Math.max(4,Math.min(right,document.documentElement.clientWidth-128)),bottom:Math.max(4,Math.min(bottom,document.documentElement.clientHeight-152))});
 const [position,setPosition]=useState(()=>clampPosition(plugin.settings.orbRight,plugin.settings.orbBottom));
 const positionRef=useRef(position),suppressClick=useRef(false);
 const drag=useRef<{id:number;x:number;y:number;right:number;bottom:number;moved:boolean}|null>(null);
 const moveTo=(next:typeof position)=>{positionRef.current=next;setPosition(next)};
 const pointerDown=(e:PointerEvent)=>{
  if(!e.isPrimary||e.button!==0)return;
  suppressClick.current=false;
  drag.current={id:e.pointerId,x:e.clientX,y:e.clientY,...positionRef.current,moved:false};
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
 };
 const pointerMove=(e:PointerEvent)=>{
  const d=drag.current;if(!d||d.id!==e.pointerId)return;
  const dx=e.clientX-d.x,dy=e.clientY-d.y;
  if(!d.moved&&Math.hypot(dx,dy)<6)return;
  d.moved=true;suppressClick.current=true;
  moveTo(clampPosition(d.right-dx,d.bottom-dy));
 };
 const pointerUp=(e:PointerEvent)=>{
  const d=drag.current;if(!d||d.id!==e.pointerId)return;drag.current=null;
  if(d.moved){Object.assign(plugin.settings,{orbRight:positionRef.current.right,orbBottom:positionRef.current.bottom});void plugin.saveSettings().catch(()=>{setMessage('Could not save the bubble position. Try moving it again.');setError(true)})}
 };
 const pointerCancel=()=>{const d=drag.current;if(d){drag.current=null;suppressClick.current=true;moveTo({right:d.right,bottom:d.bottom})}};
 useEffect(()=>{const resize=()=>moveTo(clampPosition(positionRef.current.right,positionRef.current.bottom));window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize)},[]);
 const [paused,setPaused]=useState(plugin.settings.pauseMotion);
 const [voiceMode,setVoiceMode]=useState<VoiceMode>('idle');
 const [message,setMessage]=useState('');
 const [error,setError]=useState(false),[unread,setUnread]=useState(false);
 const [open,setOpen]=useState(false),[text,setText]=useState('');
 const floatRef=useRef<HTMLDivElement>(null),toggleRef=useRef<HTMLButtonElement>(null),conversationRef=useRef<HTMLSelectElement>(null);
 const showPanel=()=>{setOpen(true);setUnread(false)};
 const closePanel=()=>{setOpen(false);toggleRef.current?.focus()};
 useEffect(()=>{
  if(!open)return;
  setUnread(false);conversationRef.current?.focus();
  const outside=(event:PointerEvent)=>{if(!floatRef.current?.contains(event.target as Node))setOpen(false)};
  window.addEventListener('pointerdown',outside);
  return()=>window.removeEventListener('pointerdown',outside);
 },[open]);
 const pendingVoice=useRef(new Set<string>());
 const [tasks,setTasks]=useState<WorkTask[]>([]),[target,setTarget]=useState<string|null>(workTarget());
 const selectionRef=useRef(state.selection);selectionRef.current=state.selection;
 const previousProvider=useRef(state.selection.provider);
 const voice=useMemo(()=>new VoiceSession(v2VoiceTransport,async()=>{const chosen={...selectionRef.current};await assertVoiceVault(plugin.app);return workConversations.getSelection(chosen)},surfaceKind,{version:plugin.manifest?.version,heartbeat:surfaceKind==='native'?plugin.voiceHeartbeat:undefined}),[plugin,surfaceKind]);
 // The recording command can mount the orb and dispatch its toggle immediately.
 useLayoutEffect(()=>{
  let alive=true,checkingCompletions=false;
  voice.onArtifact=async(artifact,signal)=>{if(!alive)throw new Error('Opening was cancelled.');await openVoiceArtifact(plugin.app,artifact,signal);if(alive){setMessage(`Opened ${artifact.label}.`);setError(false);setUnread(true)}};
  voice.connect();voice.onState=setVoiceMode;voice.onMessage=(msg,isError=false)=>{setMessage(msg);setError(isError)};
  voice.onReply=async r=>{if(!alive)return;workConversations.sync({...workFeed.getSnapshot(),current:r.current,currentRevision:r.currentRevision});setUnread(true);if(r.queued)pendingVoice.current.add(r.queued);if(r.workIds?.length&&!r.conversationSuperseded)openWork(r.workIds);void workFeed.refresh();const message=await applyVoiceAction(plugin.app,r,()=>plugin.activateView(),()=>openWork());if(alive&&message)setMessage(message)};
  const stopWork=workFeed.subscribe((r:any)=>{workConversations.sync(r);setTasks(r.tasks);setTarget(workTarget(selectionRef.current.provider))});
  const targetChanged=()=>setTarget(workTarget());window.addEventListener('aos-work-target',targetChanged);
  const targetError=(event:Event)=>{setMessage((event as CustomEvent<string>).detail);setError(true)};window.addEventListener('aos-work-error',targetError);
  const completions=window.setInterval(async()=>{
   if(!alive||checkingCompletions||voice.mode!=='idle')return;
   checkingCompletions=true;
   try{for(const id of pendingVoice.current){const run=await readRun(plugin.app,id);if(!alive||voice.mode!=='idle')return;if(run&&run.status!=='running'){pendingVoice.current.delete(id);setMessage(run.summary);setUnread(true);void voice.announce(`run:${id}`,run.summary).catch(()=>{if(alive)pendingVoice.current.add(id)});break}}}
   catch{/* Keep the pending result for the next poll. */}finally{checkingCompletions=false}
  },3000);
  const sync=()=>setPaused(plugin.settings.pauseMotion);
  const toggleVoice=()=>void voice.toggle();window.addEventListener('aos-toggle-voice',toggleVoice);
  const escape=(e:KeyboardEvent)=>{if(e.key!=='Escape')return;if(['listening','working','speaking'].includes(voice.mode)){voice.cancel();setMessage('Voice stopped. Agent tasks keep running.')}setOpen(false);setError(false);if(floatRef.current?.contains(document.activeElement))toggleRef.current?.focus()};
  window.addEventListener('aos-v2-settings',sync);window.addEventListener('keydown',escape);
  return()=>{alive=false;voice.onState=()=>{};voice.onMessage=()=>{};voice.onReply=()=>{};voice.onArtifact=undefined;window.removeEventListener('aos-toggle-voice',toggleVoice);window.clearInterval(completions);stopWork();window.removeEventListener('aos-work-target',targetChanged);window.removeEventListener('aos-work-error',targetError);void voice.destroy();window.removeEventListener('aos-v2-settings',sync);window.removeEventListener('keydown',escape)};
 },[plugin,voice]);
 useEffect(()=>{
  setWorkProvider(state.selection.provider);setTarget(workTarget(state.selection.provider));
  if(previousProvider.current===state.selection.provider)return;
  previousProvider.current=state.selection.provider;
  voice.cancelArtifact();
  const active=['listening','working','speaking'].includes(voice.mode);if(active)voice.cancel('provider-change');
  setError(false);setUnread(false);
  setMessage(active?'Voice stopped after switching providers. Click the orb to start again.':'');
 },[state.selection.provider,voice]);
 const voiceProvider=state.selection.provider;
 const selectedTask=tasks.find(t=>t.id===target&&t.provider===voiceProvider&&!['script','headless'].includes(t.execution||''));
 const [visitedProviders,setVisitedProviders]=useState({codex:voiceProvider==='codex',claude:voiceProvider==='claude'});
 useEffect(()=>setVisitedProviders(previous=>previous[voiceProvider]?previous:{...previous,[voiceProvider]:true}),[voiceProvider]);
 const mode=voiceMode;
 const active=['listening','working','speaking'].includes(voiceMode);
 const workingLabel=message.startsWith('Still working')?'Working…':'Thinking';
 const modeLabel={idle:'Tap to talk',listening:'Listening',working:workingLabel,speaking:'Speaking',error:'Try again'}[mode];
 const chooseConversation=(id:string|null)=>{if(active)return;voice.cancelArtifact();setMessage('');setError(false);setUnread(false);chooseWork(id,voiceProvider)};
 return <div ref={floatRef} className="v2-voice-float" data-provider={voiceProvider} data-paused={paused} style={{right:position.right,bottom:position.bottom,'--voice-right':`${position.right}px`,'--voice-bottom':`${position.bottom}px`}}>
  {error&&!open&&<div className="v2-voice-notice"><button onClick={showPanel}><span role="alert">Voice needs attention</span><span>View message</span></button><button onClick={()=>setError(false)} aria-label="Dismiss voice notice">×</button></div>}
  <span className="v2-voice-sr" role="status" aria-atomic="true">{modeLabel}</span>
  {open&&<section id="v2-voice-controls" className="v2-voice-panel" aria-label="Voice controls">
   <div className="v2-voice-heading"><strong>Voice <span>· {voiceProvider==='codex'?'Codex':'Claude'}</span></strong><button className="v2-voice-close" onClick={closePanel} aria-label="Close voice controls">×</button></div>
   <div className="v2-voice-conversation">
    <div className="v2-voice-conversation-heading"><label htmlFor="v2-voice-conversation">Conversation</label><button type="button" disabled={active} onClick={()=>chooseConversation(null)}>+ New conversation</button></div>
    <select id="v2-voice-conversation" ref={conversationRef} aria-label="Voice conversation" title={selectedTask?.title||undefined} value={target||''} disabled={active} onChange={e=>chooseConversation(e.currentTarget.value||null)}><option value="">New conversation</option>{target&&!selectedTask&&<option value={target}>Conversation unavailable</option>}{tasks.filter(t=>t.provider===voiceProvider&&!['script','headless'].includes(t.execution||'')).map(t=><option key={t.id} value={t.id} title={t.title}>{shortConversationTitle(t)}</option>)}</select>
   </div>
   <form onSubmit={e=>{e.preventDefault();if(text.trim()&&voiceMode!=='working'&&voiceMode!=='listening'){setError(false);void voice.sendText(text);setText('')}}}>
    <input aria-label="Type a voice request" placeholder="Ask or continue…" value={text} maxLength={4000} onInput={e=>setText(e.currentTarget.value)}/><button type="submit" disabled={!text.trim()||voiceMode==='working'||voiceMode==='listening'}>Send</button>
   </form>
   {message&&<p className="v2-voice-message" data-error={error} role="status" tabIndex={0}>{message}</p>}
   <div className="v2-voice-actions"><button onClick={()=>{setOpen(false);openWork()}}>Terminals <span aria-hidden="true">↗</span></button>{active?<button onClick={()=>{voice.cancel();setMessage('Voice stopped. Agent tasks keep running.')}}>Stop voice</button>:<span>Tap the orb to talk</span>}</div>
  </section>}
  <button className="v2-orb" data-provider={voiceProvider} data-mode={mode} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel} onLostPointerCapture={pointerCancel} onClick={e=>{if(e.detail!==0&&suppressClick.current){suppressClick.current=false;return}setError(false);setOpen(false);void voice.toggle()}} aria-label={voiceMode==='listening'?'Send voice recording':voiceMode==='working'?'Cancel voice request':voiceMode==='speaking'?'Interrupt and talk':'Start voice recording'} title="Click to talk · Drag to move · Pause to send · Escape to cancel">
   <div className="v2-orb-art" aria-hidden="true">
    <div className="v2-orb-provider-art" hidden={voiceProvider!=='codex'}>{(visitedProviders.codex||voiceProvider==='codex')&&<GalaxyCore mode={mode} getLevel={voice.getLevel} paused={paused||voiceProvider!=='codex'} variant="tight" compact/>}</div>
    <div className="v2-orb-provider-art" hidden={voiceProvider!=='claude'}>{(visitedProviders.claude||voiceProvider==='claude')&&<GraphCore mode={mode} getLevel={voice.getLevel} bloom={false} compact paused={paused||voiceProvider!=='claude'}/>}</div>
   </div>
   <span className="v2-orb-label">{voiceProvider==='codex'?'CODEX':'CLAUDE'} · {modeLabel}</span>
  </button>
  <button ref={toggleRef} className="v2-voice-toggle" data-unread={unread&&!open} aria-label="Voice controls and last reply" aria-expanded={open} aria-controls="v2-voice-controls" title="Type, choose a conversation, or read the last reply" onClick={()=>open?closePanel():showPanel()}>···</button>
 </div>;
}
