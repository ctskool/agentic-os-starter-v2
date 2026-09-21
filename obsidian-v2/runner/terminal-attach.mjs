// An attachment owns only its local viewer. The bridge owns the real CLI PTY.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import xterm from '@xterm/xterm';
import {readBridgeToken} from './bridge-auth.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DEFAULT_BRIDGE='http://127.0.0.1:3219';
const RESET='\x1b[?1049l\x1b[?2004l\x1b[?1004l\x1b[?1l\x1b[0m\x1b[?25h';
export function attachmentOptions(args){
 const values={};for(let i=0;i<args.length;i+=2){const key=args[i];if(!['--runtime','--task','--bridge'].includes(key)||values[key]!==undefined||typeof args[i+1]!=='string'||args[i+1].startsWith('--'))throw new Error('Usage: terminal-attach.mjs --runtime <directory> --task <task ID>');values[key]=args[i+1];}
 return validateAttachment({runtimeDir:values['--runtime'],taskId:values['--task'],bridge:values['--bridge']||DEFAULT_BRIDGE});
}
export function validateAttachment({runtimeDir,taskId,bridge=DEFAULT_BRIDGE}){
 if(typeof runtimeDir!=='string'||!path.isAbsolute(runtimeDir)||runtimeDir.includes('\0')||runtimeDir.length>4096)throw new Error('An absolute V2 runtime directory is required.');
 if(!UUID.test(taskId||''))throw new Error('A valid V2 task ID is required.');
 let url;try{url=new URL(bridge);}catch{throw new Error('The terminal bridge must be a local loopback URL.');}
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.port)throw new Error('The terminal bridge must be a local loopback URL.');
 let real;try{real=fs.realpathSync(runtimeDir);if(!fs.statSync(real).isDirectory())throw new Error();}catch{throw new Error('The V2 runtime directory is unavailable.');}
 return {runtimeDir:real,taskId,bridge:url.origin};
}
export function validateLifetimeEndpoint(value,{platform=process.platform,tmpdir=os.tmpdir()}={}){
 const invalid=()=>{throw new Error('The native terminal lifetime socket is invalid.');};
 if(typeof value!=='string'||!value||value.includes('\0')||value.length>4096)invalid();
 if(platform==='win32'){
  const prefix='\\\\.\\pipe\\aos-v2-terminal-';
  if(!value.startsWith(prefix)||!UUID.test(value.slice(prefix.length)))invalid();
 }else{
  const basename=path.posix.basename(value),prefix='aos-v2-terminal-';
  if(!path.posix.isAbsolute(value)||path.posix.normalize(value)!==value||Buffer.byteLength(value)>100||!basename.startsWith(prefix)||!basename.endsWith('.sock')||!UUID.test(basename.slice(prefix.length,-5))||![path.posix.normalize(tmpdir),'/tmp'].includes(path.posix.dirname(value)))invalid();
 }
 return value;
}
export function connectTerminalLifetime(endpoint,{signal,onClose=()=>{},timeoutMs=3000}={}){
 validateLifetimeEndpoint(endpoint);
 return new Promise((resolve,reject)=>{
  const socket=net.createConnection({path:endpoint});let ready=false,closed=false,received='';
  const close=()=>{if(closed)return;closed=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);socket.removeAllListeners();socket.on('error',()=>{});socket.destroy();};
  const failed=()=>{if(closed)return;const attached=ready;close();if(attached)onClose();else reject(new Error('The native terminal tab closed or its lifetime handshake failed. Reopen the terminal tab.'));};
  const abort=()=>{if(closed)return;close();if(!ready)reject(new Error('The native terminal attachment closed.'));};
  const timer=setTimeout(failed,Math.max(50,Math.min(10000,timeoutMs)));
  signal?.addEventListener('abort',abort,{once:true});
  socket.on('error',failed);socket.on('end',failed);socket.on('close',failed);
  socket.on('data',data=>{
   if(closed)return;
   if(ready||received.length+data.length>6){failed();return;}
   received+=data.toString('utf8');
   if(!'READY\n'.startsWith(received)){failed();return;}
   if(received==='READY\n'){ready=true;clearTimeout(timer);resolve({close});}
  });
  if(signal?.aborted)abort();
 });
}
export function inputChunks(text,size=3000){
 const chunks=[];for(let start=0;start<text.length;){let end=Math.min(text.length,start+size);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;chunks.push(text.slice(start,end));start=end;}return chunks;
}
const sizeOf=output=>({cols:Math.max(20,Math.min(300,Math.floor(output.columns||110))),rows:Math.max(5,Math.min(120,Math.floor(output.rows||30)))});
function cellStyle(cell){
 const codes=[0];for(const [name,code] of [['isBold',1],['isDim',2],['isItalic',3],['isUnderline',4],['isBlink',5],['isInverse',7],['isInvisible',8],['isStrikethrough',9],['isOverline',53]])if(cell[name]())codes.push(code);
 for(const [kind,prefix] of [['Fg',38],['Bg',48]]){const color=cell[`get${kind}Color`]();if(cell[`is${kind}RGB`]())codes.push(prefix,2,(color>>16)&255,(color>>8)&255,color&255);else if(cell[`is${kind}Palette`]())codes.push(prefix,5,color);}
 return `\x1b[${codes.join(';')}m`;
}
export function terminalSnapshot(term,{cols=term.cols,rows=term.rows}={}){
 const buffer=term.buffer.active,visible=Math.min(rows,term.rows),top=Math.max(0,buffer.cursorY-visible+1),start=buffer.baseY+top;
 let result='\x1b[?25l\x1b[0m'+(buffer.type==='alternate'?'\x1b[?1049h':'\x1b[?1049l')+'\x1b[2J\x1b[H',style='';
 // Reconstruct the current screen at its historical geometry, then clip only
 // when another viewer currently owns a different size. Never replay old ANSI
 // cursor motion against the native pane's new width.
 for(let y=0;y<visible;y++){
  result+=`\x1b[${y+1};1H`;const line=buffer.getLine(start+y);if(!line)continue;
  for(let x=0;x<Math.min(cols,term.cols);x++){const cell=line.getCell(x);if(!cell||cell.getWidth()===0)continue;const next=cellStyle(cell);if(style!==next){result+=next;style=next;}result+=cell.getChars()||' ';}
 }
 const modes=term.modes;
 result+=`\x1b[0m\x1b[${Math.min(visible,buffer.cursorY-top+1)};${Math.min(cols,buffer.cursorX+1)}H\x1b[?1${modes.applicationCursorKeysMode?'h':'l'}\x1b[?2004${modes.bracketedPasteMode?'h':'l'}\x1b[?25h`;
 return result;
}
export class TerminalAttachmentDisplay{
 constructor(write,getSize){this.write=write;this.getSize=getSize;this.term=new xterm.Terminal({cols:110,rows:30,scrollback:2000,allowProposedApi:true});this.instance='';this.repaint=true;this.bridgeSize=null;}
 async consume(output){
  if(typeof output.data!=='string'||output.data.length>500000||!Number.isSafeInteger(output.cursor)||output.cursor<0||!UUID.test(output.instance||''))throw new Error('The bridge returned invalid terminal output.');
  const frames=output.frames||[{...this.getSize(),data:output.data}];
  if(!Array.isArray(frames)||!frames.length||frames.length>10000||frames.some(f=>typeof f.data!=='string'||!Number.isInteger(f.cols)||f.cols<20||f.cols>300||!Number.isInteger(f.rows)||f.rows<5||f.rows>120)||frames.map(f=>f.data).join('')!==output.data)throw new Error('The bridge returned invalid terminal frames.');
  const reset=output.reset||this.instance!==output.instance;if(reset)this.term.reset();
  let geometryChanged=false;const previousBuffer=this.term.buffer.active.type;
  for(const frame of frames){if(this.term.cols!==frame.cols||this.term.rows!==frame.rows){this.term.resize(frame.cols,frame.rows);geometryChanged=true;}if(frame.data)await new Promise(resolve=>this.term.write(frame.data,resolve));this.bridgeSize={cols:frame.cols,rows:frame.rows};}
  const size=this.getSize(),different=this.term.cols!==size.cols||this.term.rows!==size.rows;
  if(reset||this.repaint||geometryChanged||previousBuffer!==this.term.buffer.active.type||(different&&output.data)){await this.write(terminalSnapshot(this.term,size));this.repaint=false;}
  else if(output.data)await this.write(output.data);
  this.instance=output.instance;
 }
 dispose(){this.term.dispose();}
}
async function responseJson(response){
 if(Number(response.headers.get('content-length'))>2200000)throw new Error('Bridge response is too large.');
 const reader=response.body?.getReader();if(!reader)throw new Error('The bridge returned an empty response.');
 let size=0;const parts=[];try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>2200000)throw new Error('Bridge response is too large.');parts.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
 try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new Error('The bridge returned an invalid response.');}
}
export async function runTerminalAttachment(options,{stdin=process.stdin,stdout=process.stdout,stderr=process.stderr,signals=process,fetchImpl=fetch,lifetimeEndpoint=process.env.AOS_V2_TERMINAL_LIFETIME,lifetimeTimeoutMs=3000,now=()=>performance.now(),timing={active:100,idle:600,stopped:2000,retry:1000,timeout:4000}}={}){
 const config=validateAttachment(options);
 if(!stdin.isTTY||!stdout.isTTY||typeof stdin.setRawMode!=='function')throw new Error('Open this attachment in an interactive terminal. Piped input is not supported.');
 const stop=new AbortController(),rawBefore=Boolean(stdin.isRaw),listeners=[];
 let lifetime=null,closed=false,exitCode=0,resolveDone,timer=null,polling=false,inputWorking=false,mutation=Promise.resolve(),pending=[],pendingSize=0,lastSize='',cursor=0,instance='',failures=0,live=false,lastState='',rush=false,resizeNeeded=false,activeUntil=0;
 const noteActivity=()=>{activeUntil=now()+1000;};
 const done=new Promise(resolve=>{resolveDone=resolve;});
 const listen=(target,event,fn)=>{target.on(event,fn);listeners.push(()=>target.off(event,fn));};
 const write=text=>new Promise((resolve,reject)=>{if(closed)return resolve();stdout.write(text,error=>error?reject(error):resolve());});
 const display=new TerminalAttachmentDisplay(write,()=>sizeOf(stdout));
 const discardInput=()=>{pending=[];pendingSize=0;};
 const detach=(code=0,message='')=>{if(closed)return;closed=true;exitCode=code;stop.abort();lifetime?.close();clearTimeout(timer);discardInput();for(const remove of listeners.splice(0))remove();try{stdin.setRawMode(rawBefore);stdin.pause();}catch{}try{stdout.write(RESET+(message?'\r\n'+message+'\r\n':''));}catch{}resolveDone();};
 async function request(endpoint,data){
  if(closed)throw new Error('Attachment closed.');
  const headers=data===undefined?{}:{'Content-Type':'application/json','X-V2-Token':readBridgeToken(config.runtimeDir)};
  let response;try{response=await fetchImpl(config.bridge+endpoint,{method:data===undefined?'GET':'POST',headers,...(data!==undefined?{body:JSON.stringify(data)}:{}),redirect:'error',signal:AbortSignal.any([stop.signal,AbortSignal.timeout(timing.timeout)])});}catch{throw new Error(data===undefined?'The V2 bridge is unavailable.':'Input delivery could not be confirmed. Check the terminal before typing again.');}
  if(!response.ok)throw new Error(response.status===401?'Bridge authentication changed. Waiting to reconnect.':data===undefined?'This terminal is unavailable. Check its saved task in the dashboard.':'The terminal changed or rejected input. Check its current state before typing again.');
  return responseJson(response);
 }
 // Resize and input share one ordered mutation lane. Never retry a POST whose
 // outcome is uncertain, and never send a queued key to a replacement PTY.
 function mutate(endpoint,data){const next=mutation.then(()=>{if(closed||data.instance!==instance)throw new Error('The CLI session changed. Pending input was not sent.');return request(endpoint,data);});mutation=next.catch(()=>{});return next;}
 const wake=()=>{rush=true;if(!closed&&!polling){clearTimeout(timer);timer=setTimeout(()=>void poll(),0);}};
 async function resize(expected){
  if(!expected||!live||closed)return;const size=sizeOf(stdout),key=`${size.cols}:${size.rows}:${expected}`;
  if(!resizeNeeded&&lastSize===key&&display.bridgeSize?.cols===size.cols&&display.bridgeSize?.rows===size.rows)return;
  await mutate('/work/resize',{id:config.taskId,...size,instance:expected});lastSize=key;resizeNeeded=false;display.repaint=true;
 }
 async function drain(){
  if(inputWorking||closed)return;inputWorking=true;
  try{while(!closed&&pending.length){const entry=pending.shift();pendingSize-=entry.data.length;if(!live||entry.instance!==instance)continue;await resize(entry.instance);await mutate('/work/input',{id:config.taskId,data:entry.data,instance:entry.instance});wake();}if(!closed)stdin.resume();}
  catch(error){discardInput();live=false;if(!closed){await write('\r\n'+error.message+'\r\n').catch(()=>{});wake();stdin.resume();}}finally{inputWorking=false;}
 }
 const onInput=data=>{
  if(closed)return;
  if(!live){if(lastState!=='input-disabled'){lastState='input-disabled';void write('\r\nThe CLI is not ready for input. Resume it from the dashboard; these keys were not sent.\r\n').catch(()=>detach());}return;}
  const text=String(data);if(pendingSize+text.length>256000){discardInput();live=false;void write('\r\nThat paste is too large. Check the terminal before trying a smaller paste.\r\n').catch(()=>detach());wake();return;}
  noteActivity();for(const chunk of inputChunks(text))pending.push({data:chunk,instance});pendingSize+=text.length;if(pendingSize>16000)stdin.pause();void drain();
 };
 async function poll(){
  if(closed||polling)return;polling=true;let delay=timing.idle;
  try{
   const output=await request(`/work/output?id=${config.taskId}&cursor=${cursor}&instance=${encodeURIComponent(instance)}`);if(closed)return;
   if(!output.instance){
    live=false;discardInput();cursor=0;instance='';lastSize='';activeUntil=0;
    const state=String(output.state||'stopped').replace(/[^a-z ]/gi,'');
    if(lastState!==state){lastState=state;await write(RESET+'\x1b[2J\x1b[HThe CLI is '+state+'. This saved conversation will reconnect here when you resume it from the dashboard.\r\n');}
    delay=timing.stopped||2000;failures=0;return;
   }
   const changed=output.instance!==instance;
   if(changed){live=false;discardInput();lastSize='';}
   await display.consume(output);if(closed)return;
   cursor=output.cursor;instance=output.instance;live=output.state!=='stopping';lastState=String(output.state||'');failures=0;
   if(live&&(changed||resizeNeeded))await resize(instance);
   // A CLI animation can leave an empty poll between frames. Keep the active
   // cadence through short gaps instead of batching the next frames after a
   // 600ms idle sleep; sustained silence still returns to the cheap idle poll.
   if(output.data)noteActivity();
   delay=pending.length||now()<activeUntil?timing.active:timing.idle;
  }catch(error){if(!closed){live=false;discardInput();if(failures++===0)await write('\r\n'+error.message+' Reconnecting without resending input.\r\n').catch(()=>detach());delay=Math.min(5000,timing.retry*failures);}}
  finally{polling=false;if(!closed){const wait=rush?timing.active:delay;rush=false;timer=setTimeout(()=>void poll(),wait);}}
 }
 try{
  listen(stdin,'error',()=>detach(1,'The local terminal input disconnected.'));listen(stdout,'error',()=>detach());listen(stdin,'end',()=>detach());listen(stdin,'close',()=>detach());
  for(const signal of ['SIGINT','SIGTERM','SIGHUP'])listen(signals,signal,()=>detach());
  if(lifetimeEndpoint!==undefined){lifetime=await connectTerminalLifetime(lifetimeEndpoint,{signal:stop.signal,onClose:()=>detach(),timeoutMs:lifetimeTimeoutMs});if(closed)return exitCode;}
  // The native tab must claim this viewer before even reading local auth. A
  // replacement tab attachment closes this socket and leaves the real CLI alone.
  readBridgeToken(config.runtimeDir);
  let expectedVault=null;const vaultFile=path.join(config.runtimeDir,'vault.json');
  if(fs.existsSync(vaultFile)){try{const value=JSON.parse(fs.readFileSync(vaultFile,'utf8'));if(typeof value.vault!=='string'||!path.isAbsolute(value.vault))throw new Error();expectedVault=fs.realpathSync(value.vault);}catch{throw new Error('The V2 runtime vault configuration is invalid.');}}
  const work=await request('/work?summary=1');
  if(closed)return exitCode;
  if(work.attachmentProtocol!==1)throw new Error('Update or restart the V2 bridge to enable native terminal attachments.');
  if(expectedVault){const normalize=value=>process.platform==='win32'?path.normalize(value).toLowerCase():path.normalize(value);if(typeof work.vault!=='string'||normalize(work.vault)!==normalize(expectedVault))throw new Error('This bridge belongs to a different vault. Check the V2 runtime configuration.');}
  const task=work.tasks?.find(t=>t.id===config.taskId);if(!task)throw new Error('This saved task is unavailable. Open the dashboard to select a current task.');
  if(task.execution==='script')throw new Error('Script refreshes do not have an interactive CLI terminal.');
  listen(stdout,'resize',()=>{display.repaint=true;resizeNeeded=true;wake();});
  stdin.setEncoding('utf8');stdin.setRawMode(true);listen(stdin,'data',onInput);stdin.resume();void poll();await done;
 }catch(error){detach(1,error.message);}
 finally{display.dispose();if(!closed)detach();lifetime?.close();}
 return exitCode;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.exitCode=await runTerminalAttachment(attachmentOptions(process.argv.slice(2)));}
 catch(error){process.stderr.write(String(error.message||'Could not attach to the terminal.')+'\n');process.exitCode=1;}
}
