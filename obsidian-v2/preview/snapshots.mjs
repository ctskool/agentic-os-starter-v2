// Mount the preview before attempting authenticated reads. A fresh bridge may
// not have created its credential yet, so initial failure must remain retryable.
export function startPreviewSnapshots({load,apply,status,intervalMs=3000,schedule=setInterval,unschedule=clearInterval}){
 let closed=false,pending=false;
 const refresh=async()=>{
  if(closed||pending)return;
  pending=true;
  try{
   const snapshot=await load();
   if(closed)return;
   apply(snapshot);
   status('Connected vault · Live V2 bridge');
  }catch(error){
   if(!closed)status(`Waiting for V2 bridge · retrying automatically. ${error instanceof Error?error.message:String(error)}`);
  }finally{pending=false}
 };
 status('Connecting to V2 bridge…');
 const timer=schedule(()=>void refresh(),intervalMs);
 void refresh();
 return ()=>{closed=true;unschedule(timer)};
}
