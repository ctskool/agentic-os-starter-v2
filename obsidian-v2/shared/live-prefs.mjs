export const LIVE_VOICES=Object.freeze(['alloy','ash','ballad','cedar','coral','echo','marin','sage','shimmer','verse']);
export const LIVE_PREF_CHOICES=Object.freeze({
 voiceMode:Object.freeze(['local','live']),liveVoice:LIVE_VOICES,
 liveTaskUpdates:Object.freeze(['done','silent','chatty']),liveConfirm:Object.freeze(['auto','voice','click','destructive']),liveIdleMic:Object.freeze(['open','muted']),
 liveIdleHangupMin:Object.freeze([15,30,60]),liveStandbySec:Object.freeze([20,30,60]),liveCarryToday:Object.freeze([false,true]),liveShareWork:Object.freeze([true,false]),liveShareBrief:Object.freeze([false,true]),liveGreeting:Object.freeze([true,false])
});
export const LIVE_PREF_DEFAULTS=Object.freeze({
 voiceMode:'local',liveTaskUpdates:'done',liveVoice:'marin',liveConfirm:'auto',liveIdleMic:'open',liveIdleHangupMin:30,liveStandbySec:60,liveCarryToday:false,liveShareWork:true,liveShareBrief:false,liveGreeting:true
});
export const livePrefsFrom=value=>Object.fromEntries(Object.entries(LIVE_PREF_CHOICES).map(([key,choices])=>[key,choices.includes(value?.[key])?value[key]:LIVE_PREF_DEFAULTS[key]]));
