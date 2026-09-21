import {setInterval,clearInterval} from 'timers';

// Chromium throttles renderer timers when Obsidian is occluded/minimized.
// Native voice ownership is an application service, independent of artwork.
export function nativeVoiceHeartbeat(tick:()=>void):()=>void {
 const timer=setInterval(tick,4000);
 timer.unref();
 return ()=>clearInterval(timer);
}
