export function manualClock(time=Date.now()){
 const alarms=new Set();
 const schedule=(run,ms)=>{
  const alarm={at:time+ms,run};alarms.add(alarm);return ()=>alarms.delete(alarm);
 };
 const advance=ms=>{
  const end=time+ms;
  for(;;){
   const next=[...alarms].filter(alarm=>alarm.at<=end).sort((a,b)=>a.at-b.at)[0];
   if(!next)break;
   time=next.at;alarms.delete(next);next.run();
  }
  time=end;
 };
 const sleep=(ms,signal)=>new Promise((resolve,reject)=>{
  signal.throwIfAborted();
  const cancel=schedule(()=>{signal.removeEventListener('abort',abort);resolve()},ms);
  const abort=()=>{cancel();reject(signal.reason)};
  signal.addEventListener('abort',abort,{once:true});
 });
 const timeout=ms=>{
  const controller=new AbortController();
  schedule(()=>controller.abort(new DOMException('Timed out','TimeoutError')),ms);
  return controller.signal;
 };
 return {now:()=>time,advance,schedule,sleep,timeout};
}
