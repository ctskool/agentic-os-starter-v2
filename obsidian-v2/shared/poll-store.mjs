// One poll and one in-flight request shared by every subscriber in a view runtime.
export function createPollStore({initial,load,intervalMs=2500,startTimer=setInterval,stopTimer=clearInterval,onStart=(_run)=>()=>{}}){
 let snapshot=initial,flight=null,timer=null,cleanup=null,revision=0;
 const listeners=new Set();
 const publish=value=>{revision++;snapshot=value;for(const fn of listeners)fn(snapshot)};
 const refresh=()=>{
  if(flight)return flight;
  const began=revision;
  flight=Promise.resolve().then(load).then(value=>{if(began===revision)publish(value);return snapshot}).finally(()=>{flight=null});
  return flight;
 };
 const run=()=>{void refresh().catch(()=>{})};
 return {getSnapshot:()=>snapshot,publish,refresh,subscribe(fn){
  listeners.add(fn);fn(snapshot);
  if(listeners.size===1){cleanup=onStart(run);timer=startTimer(run,intervalMs);run()}
  return()=>{listeners.delete(fn);if(!listeners.size){stopTimer(timer);timer=null;cleanup?.();cleanup=null}};
 }};
}
