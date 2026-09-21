// A drain/close race needs symmetric cleanup: once('close') otherwise survives
// every successful drain and accumulates for the lifetime of the audio response.
export function waitForResponseDrain(response){
 if(response.destroyed||response.writableEnded)return Promise.resolve(false);
 return new Promise((resolve,reject)=>{
  const cleanup=()=>{response.removeListener('drain',drained);response.removeListener('close',closed);response.removeListener('error',failed)};
  const drained=()=>{cleanup();resolve(true)};
  const closed=()=>{cleanup();resolve(false)};
  const failed=error=>{cleanup();reject(error)};
  response.once('drain',drained);response.once('close',closed);response.once('error',failed);
  if(response.destroyed||response.writableEnded)closed();
 });
}
