import {h} from 'preact';
import {useEffect,useState} from 'preact/hooks';
import {carryToday,liveClock,liveModeOption,liveSettings,wakeOnVoice} from '../../shared/live-controls';
import type {LiveSession,LiveSnapshot} from '../../shared/live-session';
import type {VoicePrefs} from '../../shared/voice-prefs';

export function LiveVoiceSettings({prefs,live,save}:{prefs:VoicePrefs;live:LiveSnapshot;save:(changes:Partial<VoicePrefs>)=>void}){
 const mode=liveModeOption(prefs,live);if(!mode)return null;
 return <div className="v2-voice-sound v2-live-settings">
  <div className="v2-live-mode" role="group" aria-label="Voice mode"><span>Voice</span><button type="button" aria-pressed={mode.value==='local'} onClick={()=>{if(mode.value!=='local')save({voiceMode:'local'})}}>Local</button><button type="button" aria-pressed={mode.value==='live'} disabled={mode.disabled} onClick={()=>{if(mode.value!=='live')save({voiceMode:'live'})}}>Live</button></div>
  {mode.reason&&<p role="status">{mode.reason}</p>}
  {mode.value==='live'&&<>
   {liveSettings(prefs).map(row=><label key={row.key}>{row.label}<select value={row.value} onChange={e=>save(row.change(e.currentTarget.value))}>{row.choices.map(choice=><option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>)}
   {prefs.liveIdleMic!==undefined&&<button type="button" className="v2-voice-mute" aria-pressed={prefs.liveIdleMic==='open'} onClick={()=>save(wakeOnVoice(prefs.liveIdleMic!=='open'))}><span>Wake on voice</span><strong>{prefs.liveIdleMic==='open'?'On':'Off'}</strong></button>}
   {prefs.liveCarryToday!==undefined&&<label>Remember today’s calls<input type="checkbox" checked={prefs.liveCarryToday} onChange={e=>save(carryToday(e.currentTarget.checked))}/></label>}
   {prefs.liveShareWork!==undefined&&<><label>Share task titles<input type="checkbox" aria-describedby="v2-live-share-work-hint" checked={prefs.liveShareWork} onChange={e=>save({liveShareWork:e.currentTarget.checked})}/></label><p id="v2-live-share-work-hint">Live sees what's in progress (titles only).</p></>}
   {prefs.liveShareBrief!==undefined&&<><label>Share morning brief<input type="checkbox" aria-describedby="v2-live-share-brief-hint" checked={prefs.liveShareBrief} onChange={e=>save({liveShareBrief:e.currentTarget.checked})}/></label><p id="v2-live-share-brief-hint">Live sees the whole brief, including its email section.</p></>}
   {prefs.liveGreeting!==undefined&&<><label>Greeting<input type="checkbox" aria-describedby="v2-live-greeting-hint" checked={prefs.liveGreeting} onChange={e=>save({liveGreeting:e.currentTarget.checked})}/></label><p id="v2-live-greeting-hint">Live says hello by name when a call starts.</p></>}
  </>}
 </div>;
}
export function LiveCallBar({live,session,openTask}:{live:LiveSnapshot;session:LiveSession;openTask:(id:string)=>void}){
 const [now,setNow]=useState(Date.now);
 useEffect(()=>{if(live.startedAt===null)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[live.startedAt]);
 if(live.occupied)return <div className="v2-live-controls"><p role="status">{live.occupied}</p></div>;
 if(live.state==='idle')return null;
 return <div className="v2-live-controls">
  {live.staged&&<section className="v2-live-staged" aria-label="Action awaiting confirmation"><p>{live.staged.description}</p><div><button onClick={()=>void session.action(false)}>Cancel</button>{live.staged.mode==='click'&&<button onClick={()=>void session.action(true)}>Confirm</button>}</div></section>}
  <div className="v2-live-bar"><span><i aria-hidden="true"/> {liveClock(live,now)}</span><button aria-pressed={live.micMuted} disabled={!live.ready} onClick={()=>void session.setMuted(!live.micMuted)}>{live.micMuted?'Unmute':'Mute'}</button><button onClick={()=>session.stop()}>End call</button></div>
  {live.completions?.map(card=><section key={card.seq} className="v2-live-staged" aria-label="Task update"><strong>{card.label}</strong><p>{card.text}</p><div>{card.taskId&&<button onClick={()=>openTask(card.taskId!)}>Open task</button>}<button onClick={()=>session.dismissCompletion(card.seq)}>Dismiss</button></div></section>)}
 </div>;
}
