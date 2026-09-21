// Socket close is authoritative: do not retain a native hotkey target until
// its longer heartbeat grace expires after the window/plugin disconnects.
export function attachVoiceEvents(client,res,listeners,hub){
 // GET cannot evict an existing owner just by knowing its public client ID.
 if(listeners.has(client)){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Voice surface already connected'}));return}
 res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive'});
 res.write('data: {"type":"heartbeat"}\n\n');
 listeners.set(client,res);
 // An observable heartbeat lets clients replace a stale OPEN connection after
 // sleep. SSE comments keep TCP alive but are invisible to EventSource users.
 const ping=setInterval(()=>res.write('data: {"type":"heartbeat"}\n\n'),10000);ping.unref();
 res.on('close',()=>{
  clearInterval(ping);
  if(listeners.get(client)===res){listeners.delete(client);hub.leave(client)}
 });
}
