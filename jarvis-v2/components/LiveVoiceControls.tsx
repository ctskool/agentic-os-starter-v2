import React,{useEffect,useState} from 'react';
import {carryToday,liveClock,liveModeOption,liveSettings,wakeOnVoice} from '../../obsidian-v2/shared/live-controls';
import type {LiveSnapshot} from '../../obsidian-v2/shared/live-session';
import type {VoicePrefs} from '../../obsidian-v2/shared/voice-prefs';
import {voice} from '@/lib/voiceClient';
import {openWork} from '@/lib/work';

export function LiveVoiceSettings({prefs,live,save}:{prefs:VoicePrefs;live:LiveSnapshot;save:(changes:Partial<VoicePrefs>)=>void}){
 const mode=liveModeOption(prefs,live);if(!mode)return null;
 return <div className="voice-sound live-voice-settings">
  <div className="live-voice-mode" role="group" aria-label="Voice mode"><span>Voice</span><button type="button" aria-pressed={mode.value==='local'} onClick={()=>{if(mode.value!=='local')save({voiceMode:'local'})}}>Local</button><button type="button" aria-pressed={mode.value==='live'} disabled={mode.disabled} onClick={()=>{if(mode.value!=='live')save({voiceMode:'live'})}}>Live</button></div>
  {mode.reason&&<p role="status">{mode.reason}</p>}
  {mode.value==='live'&&<>
   {liveSettings(prefs).map(row=><label key={row.key}>{row.label}<select value={row.value} onChange={e=>save(row.change(e.currentTarget.value))}>{row.choices.map(choice=><option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>)}
   {prefs.liveIdleMic!==undefined&&<button type="button" className="voice-mute" aria-pressed={prefs.liveIdleMic==='open'} onClick={()=>save(wakeOnVoice(prefs.liveIdleMic!=='open'))}><span>Wake on voice</span><strong>{prefs.liveIdleMic==='open'?'On':'Off'}</strong></button>}
   {prefs.liveCarryToday!==undefined&&<label>Remember today’s calls<input type="checkbox" checked={prefs.liveCarryToday} onChange={e=>save(carryToday(e.currentTarget.checked))}/></label>}
   {prefs.liveShareWork!==undefined&&<><label>Share task titles<input type="checkbox" aria-describedby="live-share-work-hint" checked={prefs.liveShareWork} onChange={e=>save({liveShareWork:e.currentTarget.checked})}/></label><p id="live-share-work-hint">Live sees what's in progress (titles only).</p></>}
   {prefs.liveShareBrief!==undefined&&<><label>Share morning brief<input type="checkbox" aria-describedby="live-share-brief-hint" checked={prefs.liveShareBrief} onChange={e=>save({liveShareBrief:e.currentTarget.checked})}/></label><p id="live-share-brief-hint">Live sees the whole brief, including its email section.</p></>}
   {prefs.liveGreeting!==undefined&&<><label>Greeting<input type="checkbox" aria-describedby="live-greeting-hint" checked={prefs.liveGreeting} onChange={e=>save({liveGreeting:e.currentTarget.checked})}/></label><p id="live-greeting-hint">Live says hello by name when a call starts.</p></>}
  </>}
 </div>;
}
export function LiveCallBar({live}:{live:LiveSnapshot}){
 const [now,setNow]=useState(Date.now);
 useEffect(()=>{if(live.startedAt===null)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[live.startedAt]);
 if(live.occupied)return <p className="live-call-other" role="status">{live.occupied}</p>;
 if(live.state==='idle')return null;
 return <div className="live-call">
  <div className="live-call-bar"><span><i aria-hidden="true"/> {liveClock(live,now)}</span><button aria-pressed={live.micMuted} disabled={!live.ready} onClick={()=>void voice.muteLive(!live.micMuted)}>{live.micMuted?'Unmute':'Mute'}</button><button onClick={()=>voice.stopLive()}>End call</button></div>
  {live.staged&&<section className="live-staged" aria-label="Action awaiting confirmation"><p>{live.staged.description}</p><div><button onClick={()=>void voice.actionLive(false)}>Cancel</button>{live.staged.mode==='click'&&<button onClick={()=>void voice.actionLive(true)}>Confirm</button>}</div></section>}
  {live.completions?.map(card=><section key={card.seq} className="live-staged" aria-label="Task update"><strong>{card.label}</strong><p>{card.text}</p><div>{card.taskId&&<button onClick={()=>openWork([card.taskId!],true)}>Open task</button>}<button onClick={()=>voice.dismissLiveCompletion(card.seq)}>Dismiss</button></div></section>)}
 </div>;
}
