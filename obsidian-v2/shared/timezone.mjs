// "Today" follows the computer's own time zone. The bridge, the Jarvis server,
// the browser and Obsidian all run on this machine, so they read the same zone.
// After changing the computer's time zone, restart the services.
export const TIME_ZONE=(()=>{try{return new Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'}catch{return 'UTC'}})();
