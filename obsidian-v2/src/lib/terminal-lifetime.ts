import type {Server,Socket} from 'net';

export interface TerminalLifetime {readonly endpoint:string;readonly active:boolean;close():void}
interface ViewComponent {register(cleanup:()=>unknown):void}
type LifetimeModules={net:typeof import('net');platform:string;id:string;tmpdir:string};
const registryKey=Symbol.for('agentic-os-v2.terminal-lifetimes.v1');
const registryHost=globalThis as typeof globalThis&{[registryKey]?:WeakMap<object,TerminalLifetime>};
// Normal Terminal views belong to the Terminal plugin. Their controllers must
// survive a V2 plugin reload, and end only when that view actually unloads.
const lifetimes=registryHost[registryKey]??=new WeakMap<object,TerminalLifetime>();
export const lifetimeForView=(view:object)=>lifetimes.get(view);
export function bindTerminalLifetime(view:ViewComponent,lifetime:TerminalLifetime){
 lifetimes.get(view)?.close();lifetimes.set(view,lifetime);
 view.register(()=>{if(lifetimes.get(view)===lifetime)lifetimes.delete(view);lifetime.close()});
}
function nativeModules():LifetimeModules {
 // No eager Node import: the same source tree also has a browser preview.
 const requireNative=(globalThis as typeof globalThis&{require?:(id:string)=>any}).require;
 if(!requireNative)throw new Error('The native terminal lifetime service is unavailable.');
 const nodeProcess=requireNative('process') as typeof process;
 return {net:requireNative('net'),platform:nodeProcess.platform,id:requireNative('crypto').randomUUID(),tmpdir:requireNative('os').tmpdir()};
}
export async function createTerminalLifetime(modules:LifetimeModules=nativeModules()):Promise<TerminalLifetime> {
 const {net,platform,id,tmpdir}=modules;
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw new Error('Invalid terminal viewer identity.');
 const endpoint=platform==='win32'?`\\\\.\\pipe\\aos-v2-terminal-${id}`:`${tmpdir.replace(/\/$/,'')}/aos-v2-terminal-${id}.sock`;
 // macOS has a short sockaddr_un path limit. /tmp is local and the random
 // endpoint has no sensitive payload; it carries only this viewer's lifetime.
 const localEndpoint=platform!=='win32'&&new TextEncoder().encode(endpoint).length>100?`/tmp/aos-v2-terminal-${id}.sock`:endpoint;
 let active=true,current:Socket|null=null,server:Server;
 const sockets=new Set<Socket>();
 const controller:TerminalLifetime={endpoint:localEndpoint,get active(){return active},close(){
  if(!active)return;active=false;
  for(const socket of sockets)socket.destroy();sockets.clear();current=null;
  try{server.close()}catch{}
 }};
 server=net.createServer(socket=>{
  if(!active){socket.destroy();return}
  // Terminal's Restart action reuses the view without unloading it. The new
  // connection retires its old attachment before acknowledging the replacement.
  current?.destroy();current=socket;sockets.add(socket);socket.unref();
  socket.on('error',()=>socket.destroy());socket.on('close',()=>{sockets.delete(socket);if(current===socket)current=null});
  socket.on('data',()=>socket.destroy());
  socket.write('READY\n');
 });
 await new Promise<void>((resolve,reject)=>{
  const onError=(error:Error)=>{controller.close();reject(error)};
  server.once('error',onError);server.listen(localEndpoint,()=>{server.off('error',onError);server.on('error',()=>controller.close());server.unref();resolve()});
 });
 return controller;
}
