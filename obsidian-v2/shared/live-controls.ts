import {LIVE_VOICES,type VoicePrefs} from './voice-prefs';
import type {LiveSnapshot} from './live-session';

export const liveModeOption=(prefs:VoicePrefs,live:LiveSnapshot)=>prefs.voiceMode===undefined?null:{
 value:prefs.voiceMode,disabled:Boolean(live.unavailable),reason:live.unavailable
};
type Choice={value:string;label:string};
export function liveSettings(prefs:VoicePrefs){
 const rows:{key:keyof VoicePrefs;label:string;value:string;choices:Choice[];change:(value:string)=>Partial<VoicePrefs>}[]=[];
 if(prefs.liveVoice!==undefined)rows.push({key:'liveVoice',label:'Live voice',value:prefs.liveVoice,choices:LIVE_VOICES.map(value=>({value,label:value.charAt(0).toUpperCase()+value.slice(1)})),change:value=>({liveVoice:value})});
 if(prefs.liveConfirm!==undefined)rows.push({key:'liveConfirm',label:'Confirm actions',value:prefs.liveConfirm,choices:[{value:'auto',label:'Just do it'},{value:'voice',label:'Say yes'},{value:'click',label:'Tap to confirm'},{value:'destructive',label:'Ask only for stops & edits'}],change:value=>({liveConfirm:value as VoicePrefs['liveConfirm']})});
 if(prefs.liveTaskUpdates!==undefined)rows.push({key:'liveTaskUpdates',label:'Task updates',value:prefs.liveTaskUpdates,choices:[{value:'done',label:'Done & blockers'},{value:'silent',label:'Screen only'},{value:'chatty',label:'Check in on long tasks'}],change:value=>({liveTaskUpdates:value as VoicePrefs['liveTaskUpdates']})});
 // How long a quiet call waits before standby (Chase, 2026-11-26): awake, Live says task news in its own voice.
 // OpenAI allows at most 60 seconds (it rejected 180 on a real call, 2026-11-26).
 if(prefs.liveStandbySec!==undefined)rows.push({key:'liveStandbySec',label:'Standby after',value:String(prefs.liveStandbySec),choices:[[20,'20 sec'],[30,'30 sec'],[60,'1 min']].map(([sec,label])=>({value:String(sec),label:String(label)})),change:value=>({liveStandbySec:Number(value) as VoicePrefs['liveStandbySec']})});
 if(prefs.liveIdleHangupMin!==undefined)rows.push({key:'liveIdleHangupMin',label:'End call after idle',value:String(prefs.liveIdleHangupMin),choices:[15,30,60].map(min=>({value:String(min),label:`${min} min`})),change:value=>({liveIdleHangupMin:Number(value) as VoicePrefs['liveIdleHangupMin']})});
 return rows;
}
export const wakeOnVoice=(on:boolean):Partial<VoicePrefs>=>({liveIdleMic:on?'open':'muted'});
export const carryToday=(on:boolean):Partial<VoicePrefs>=>({liveCarryToday:on});
export const liveLabel=(live:LiveSnapshot)=>({idle:'Start Live call',connecting:'Connecting',listening:'Listening',speaking:'Speaking',standby:'Standby',muted:'Muted'}[live.state]);
// The orb starts a call and wakes a muted one; only the End call button ends it (Chase, 2026-11-22).
export const liveToggleLabel=(live:LiveSnapshot)=>live.state==='idle'?'Start Live call':live.state==='standby'&&live.micMuted?'Wake microphone':'Live call in progress';
export function liveClock(live:LiveSnapshot,now=Date.now()){
 const elapsed=Math.max(0,Math.floor((now-(live.startedAt??now))/1000));
 return `LIVE ${String(Math.floor(elapsed/60)).padStart(2,'0')}:${String(elapsed%60).padStart(2,'0')} · ~$${(live.cost??0).toFixed(2)}`;
}
