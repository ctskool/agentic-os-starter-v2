import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {EventEmitter,once} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import xterm from '@xterm/xterm';
import {attachmentOptions,inputChunks,TerminalAttachmentDisplay,runTerminalAttachment,validateLifetimeEndpoint} from '../runner/terminal-attach.mjs';
import {windowsArguments,releaseStoppedWindowsPty} from '../runner/terminal-transport.mjs';
const taskId='11111111-1111-4111-8111-111111111111',firstInstance='22222222-2222-4222-8222-222222222222',secondInstance='33333333-3333-4333-8333-333333333333';
const entry=fileURLToPath(new URL('../runner/terminal-attach.mjs',import.meta.url)),repo=path.dirname(path.dirname(entry));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(condition,timeout=3000){const start=Date.now();while(!condition()){if(Date.now()-start>timeout)assert.fail('Timed out waiting for the attachment fixture');await delay(10);}}
async function ptyPhase(condition,timeout,label,client){const start=Date.now();try{await until(condition,timeout);}catch(error){assert.fail(`${label} timed out after ${Date.now()-start} ms; exited=${client.state.exited}; output=${JSON.stringify(client.state.text.slice(-1000))}`);}return Date.now()-start;}
function fixture(t){const runtimeDir=fs.mkdtempSync(path.join(os.tmpdir(),'aos-attach-'));const token='a'.repeat(64);fs.writeFileSync(path.join(runtimeDir,'bridge-auth.json'),JSON.stringify({version:1,token}));fs.writeFileSync(path.join(runtimeDir,'vault.json'),JSON.stringify({vault:runtimeDir}));t.after(()=>fs.rmSync(runtimeDir,{recursive:true,force:true}));return {runtimeDir,taskId,token};}
class Input extends PassThrough{constructor(){super();this.isTTY=true;this.isRaw=false;}setRawMode(value){this.isRaw=value;return this;}}
class Output extends Writable{constructor(){super();this.isTTY=true;this.columns=80;this.rows=24;this.text='';}_write(chunk,_encoding,callback){this.text+=String(chunk);callback();}}
function mock(t,options={}){
 const config=fixture(t),stdin=new Input(),stdout=new Output(),signals=new EventEmitter(),calls=[],accepted=[];
 const state={instance:firstInstance,output:'\x1b[31mFixture CLI\x1b[0m\r\nReady> ',state:'ready',cols:110,rows:30,protocol:1,execution:undefined,activeOutput:0,maxOutput:0};
 const respond=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
 const fetchImpl=async(url,init)=>{
  const parsed=new URL(url),endpoint=parsed.pathname,body=init.body?JSON.parse(init.body):null;calls.push({endpoint,method:init.method,body,headers:init.headers,bytes:init.body?Buffer.byteLength(init.body):0});
  if(endpoint==='/work')return respond({attachmentProtocol:state.protocol,vault:config.runtimeDir,tasks:[{id:taskId,state:state.state,pid:999,execution:state.execution}]});
  if(endpoint==='/work/output'){
   state.activeOutput++;state.maxOutput=Math.max(state.maxOutput,state.activeOutput);if(options.outputDelay)await delay(options.outputDelay);state.activeOutput--;
   if(!state.instance)return respond({instance:'',cursor:0,data:'',state:state.state});
   const reset=parsed.searchParams.get('instance')!==state.instance,data=reset?state.output:state.output.slice(Number(parsed.searchParams.get('cursor')));
   return respond({instance:state.instance,cursor:state.output.length,data,frames:[{cols:state.cols,rows:state.rows,data}],reset,state:state.state});
  }
  assert.equal(init.headers['X-V2-Token'],JSON.parse(fs.readFileSync(path.join(config.runtimeDir,'bridge-auth.json'))).token);
  if(endpoint==='/work/resize'){if(body.instance!==state.instance)return respond({error:'instance changed'},409);state.cols=body.cols;state.rows=body.rows;return respond({ok:true});}
  if(endpoint==='/work/input'){if(options.input)await options.input(body,state);if(body.instance!==state.instance)return respond({error:'instance changed'},409);accepted.push(body);return respond({ok:true});}
  assert.fail('Unexpected attachment endpoint '+endpoint);
 };
 const start=()=>runTerminalAttachment(config,{stdin,stdout,signals,fetchImpl,lifetimeEndpoint:options.lifetimeEndpoint,lifetimeTimeoutMs:options.lifetimeTimeoutMs,now:options.now,timing:{active:5,idle:15,stopped:15,retry:15,timeout:1000,...options.timing}});
 return {...config,stdin,stdout,signals,calls,accepted,state,start};
}
function lifetimePath(){const name=`aos-v2-terminal-${crypto.randomUUID()}`;if(process.platform==='win32')return `\\\\.\\pipe\\${name}`;const candidate=path.join(os.tmpdir(),name+'.sock');return Buffer.byteLength(candidate)<=100?candidate:path.join('/tmp',name+'.sock');}
async function lifetimeServer(t,onConnection){const endpoint=lifetimePath(),sockets=new Set(),server=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));onConnection(socket);});server.listen(endpoint);await once(server,'listening');const close=()=>{for(const socket of sockets)socket.destroy();server.close();};t.after(close);return {endpoint,close,sockets};}
function ptyClient(t,config,bridge,endpoint){
 const require=createRequire(import.meta.url),pty=require('node-pty'),args=[entry,'--runtime',config.runtimeDir,'--task',taskId,'--bridge',bridge];
 const child=pty.spawn(process.execPath,process.platform==='win32'?windowsArguments(args):args,{cwd:repo,env:{...process.env,TERM:'xterm-256color',AOS_V2_TERMINAL_LIFETIME:endpoint},name:'xterm-256color',cols:80,rows:24,useConpty:true});
 const state={exited:false,text:'',event:null};const completion=new Promise(resolve=>child.onExit(event=>{state.exited=true;state.event=event;resolve(event);}));child.onData(data=>{state.text+=data;});
 t.after(async()=>{if(!state.exited){try{process.kill(child.pid,'SIGTERM');}catch{}}await Promise.race([completion,delay(2000)]);if(process.platform==='win32'&&state.exited)await releaseStoppedWindowsPty(child);});return {child,state,completion};
}
test('lifetime endpoints only accept the native local socket namespace',()=>{
 const win=`\\\\.\\pipe\\aos-v2-terminal-${taskId}`,unix=`/tmp/aos-v2-terminal-${taskId}.sock`;
 assert.equal(validateLifetimeEndpoint(win,{platform:'win32'}),win);assert.equal(validateLifetimeEndpoint(unix,{platform:'darwin',tmpdir:'/private/var/folders/test'}),unix);
 for(const value of ['',`\\\\host\\pipe\\aos-v2-terminal-${taskId}`,'127.0.0.1:6000',win+'\\child',win.replace('aos-v2-terminal','other')])assert.throws(()=>validateLifetimeEndpoint(value,{platform:'win32'}),/lifetime socket/);
 for(const value of ['/outside/aos-v2-terminal-'+taskId+'.sock','/tmp/../tmp/aos-v2-terminal-'+taskId+'.sock',unix+'.bak','http://localhost:6000'])assert.throws(()=>validateLifetimeEndpoint(value,{platform:'darwin',tmpdir:'/tmp'}),/lifetime socket/);
});
test('fragmented lifetime handshake gates HTTP and owner close discards queued input',async t=>{
 let owner,release,arrived=false;const gate=new Promise(resolve=>{release=resolve;}),server=await lifetimeServer(t,socket=>{owner=socket;socket.write('REA');});
 const f=mock(t,{lifetimeEndpoint:server.endpoint,input:async()=>{arrived=true;await gate;}}),running=f.start();t.after(()=>{release();f.signals.emit('SIGTERM');});
 await until(()=>owner);await delay(25);assert.equal(f.calls.length,0);assert.equal(f.stdin.isRaw,false);owner.write('DY\n');await until(()=>f.calls.some(c=>c.endpoint==='/work/resize'));
 f.stdin.write('pending old keys '.repeat(800));await until(()=>arrived);server.close();assert.equal(await running,0);const count=f.calls.length;release();await delay(40);f.stdin.write('after close');assert.equal(f.calls.length,count);assert.equal(f.calls.filter(c=>c.endpoint==='/work/input').length,1);assert.equal(f.stdin.isRaw,false);
});
test('bad, missing and early-closed lifetime handshakes fail before reading auth or HTTP',async t=>{
 for(const kind of ['bad','timeout','close']){
  const server=await lifetimeServer(t,socket=>{if(kind==='bad')socket.write('NOT READY\n');if(kind==='close')socket.destroy();});
  const f=mock(t,{lifetimeEndpoint:server.endpoint,lifetimeTimeoutMs:60});fs.unlinkSync(path.join(f.runtimeDir,'bridge-auth.json'));assert.equal(await f.start(),1);assert.match(f.stdout.text,/lifetime handshake/);assert.equal(f.calls.length,0);assert.equal(f.stdin.isRaw,false);server.close();
 }
});
test('argv rejects external bridges, malformed tasks and noninteractive input before any HTTP',async t=>{
 const f=fixture(t),args=['--runtime',f.runtimeDir,'--task',taskId];assert.equal(attachmentOptions(args).bridge,'http://127.0.0.1:3219');
 for(const url of ['https://127.0.0.1:3219','http://localhost:3219','http://example.test:3219','http://127.0.0.1:3219/path','http://secret@127.0.0.1:3219','http://127.0.0.1:3219/?token=secret'])assert.throws(()=>attachmentOptions([...args,'--bridge',url]),/loopback/);
 assert.throws(()=>attachmentOptions(['--runtime','relative','--task',taskId]),/absolute/);assert.throws(()=>attachmentOptions(['--runtime',f.runtimeDir,'--task','bad']),/task ID/);assert.throws(()=>attachmentOptions([...args,'--token','secret']),/Usage/);
 const stdin=new Input(),stdout=new Output();stdin.isTTY=false;let calls=0;await assert.rejects(runTerminalAttachment(f,{stdin,stdout,fetchImpl:()=>{calls++;}}),/Piped input/);assert.equal(calls,0);assert.equal(stdin.isRaw,false);
});
test('input chunks preserve Unicode, paste controls and JSON bodies below twenty kilobytes',()=>{
 const text='\x1b[200~'+'🌌λ\0\x01'.repeat(8000)+'\x1b[201~\r',chunks=inputChunks(text);assert.equal(chunks.join(''),text);assert.ok(chunks.length>5);
 for(const data of chunks){assert.ok(Buffer.byteLength(JSON.stringify({id:taskId,instance:firstInstance,data}))<20000);assert.doesNotMatch(data,/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);}
});
test('attachment validates protocol and vault before enabling input',async t=>{
 const f=mock(t);f.state.protocol=undefined;const code=await f.start();assert.equal(code,1);assert.match(f.stdout.text,/Update or restart/);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assert.equal(f.stdin.isRaw,false);
 const g=mock(t);fs.writeFileSync(path.join(g.runtimeDir,'vault.json'),JSON.stringify({vault:repo}));assert.equal(await g.start(),1);assert.match(g.stdout.text,/different vault/);assert.equal(g.calls.filter(c=>c.method==='POST').length,0);
});
test('ordered raw keyboard, split UTF8, paste, Ctrl+C and fresh auth remain attached without task actions',async t=>{
 let inputFlights=0,maxFlights=0;const f=mock(t,{outputDelay:5,input:async()=>{inputFlights++;maxFlights=Math.max(maxFlights,inputFlights);await delay(2);inputFlights--;}}),running=f.start();
 t.after(()=>f.signals.emit('SIGTERM'));await until(()=>f.calls.some(c=>c.endpoint==='/work/resize'));
 fs.writeFileSync(path.join(f.runtimeDir,'bridge-auth.json'),JSON.stringify({version:1,token:'b'.repeat(64)}));
 const text='\x1b[200~'+'🌌λ'.repeat(4500)+'\x1b[201~\r\x03',bytes=Buffer.from(text);f.stdin.write(bytes.subarray(0,11));f.stdin.write(bytes.subarray(11));await until(()=>f.accepted.map(b=>b.data).join('')===text);
 assert.equal(maxFlights,1);assert.equal(f.state.maxOutput,1);assert.ok(f.calls.filter(c=>c.endpoint==='/work/input').every(c=>c.bytes<20000&&c.body.instance===firstInstance&&c.headers['X-V2-Token']==='b'.repeat(64)));
 f.signals.emit('SIGTERM');assert.equal(await running,0);assert.equal(f.stdin.isRaw,false);assert.ok(f.calls.every(c=>['/work','/work/output','/work/input','/work/resize'].includes(c.endpoint)));assert.doesNotMatch(f.stdout.text,new RegExp('b'.repeat(64)));
});
test('short empty gaps keep active polling, then quiet output returns to idle until input wakes it',async t=>{
 let clock=1000;const f=mock(t,{now:()=>clock,timing:{idle:3000}}),running=f.start();t.after(()=>f.signals.emit('SIGTERM'));
 const polls=()=>f.calls.filter(c=>c.endpoint==='/work/output').length;
 await until(()=>f.calls.some(c=>c.endpoint==='/work/resize'));
 clock=1150;
 // A frame every 150ms must not trigger the 3000ms test idle sleep just because
 // a 5ms poll observes no new bytes. Advancing the activity clock is explicit.
 let count=polls();await until(()=>polls()>=count+3,700);
 const nextFrame='\x1b[?2026h\x1b[3;1Hnext animation frame\x1b[?2026l';f.state.output+=nextFrame;
 await until(()=>f.stdout.text.includes(nextFrame),700);assert.equal(f.stdout.text.split(nextFrame).length-1,1);
 clock=2050;count=polls();await until(()=>polls()>=count+3,700);
 clock=2200;count=polls();await until(()=>polls()>count,700);await delay(30);
 const quiet=polls();await delay(40);assert.equal(polls(),quiet);
 // Deliberate input gets the same grace even when the CLI has not echoed yet.
 f.stdin.write('a');await until(()=>f.accepted.length===1,700);count=polls();await until(()=>polls()>=count+3,700);
 assert.equal(f.state.maxOutput,1);f.signals.emit('SIGTERM');await running;
 const closed=polls();await delay(30);assert.equal(polls(),closed);assert.equal(f.stdin.isRaw,false);
});

test('stopped terminals leave the active grace immediately and detach clears their idle timer',async t=>{
 const f=mock(t,{now:()=>1000,timing:{stopped:3000}}),running=f.start();t.after(()=>f.signals.emit('SIGTERM'));
 const polls=()=>f.calls.filter(c=>c.endpoint==='/work/output').length;
 await until(()=>f.calls.some(c=>c.endpoint==='/work/resize'));f.state.instance='';f.state.state='stopped';
 await until(()=>f.stdout.text.includes('when you resume'),700);
 const stopped=polls();await delay(40);assert.equal(polls(),stopped);
 const posted=f.calls.filter(c=>c.method==='POST').length;f.stdin.write('discarded');await delay(20);assert.equal(f.calls.filter(c=>c.method==='POST').length,posted);
 f.signals.emit('SIGTERM');await running;await delay(30);assert.equal(polls(),stopped);assert.equal(f.stdin.isRaw,false);
});

test('stopped attachments stay read-only and resume in the same client with no stale input',async t=>{
 const f=mock(t),running=f.start();t.after(()=>f.signals.emit('SIGTERM'));await until(()=>f.calls.some(c=>c.endpoint==='/work/resize'));
 f.state.instance='';f.state.state='stopped';await until(()=>f.stdout.text.includes('when you resume'));assert.ok(f.stdout.text.includes('\x1b[2J\x1b[HThe CLI is stopped'));const before=f.accepted.length;f.stdin.write('must not dispatch\r');await delay(30);assert.equal(f.accepted.length,before);
 f.state.instance=secondInstance;f.state.state='ready';f.state.output='Resumed CLI> ';await until(()=>f.calls.some(c=>c.endpoint==='/work/resize'&&c.body.instance===secondInstance));f.stdin.write('new deliberate input');await until(()=>f.accepted.some(b=>b.instance===secondInstance));assert.equal(f.accepted.at(-1).data,'new deliberate input');
 f.signals.emit('SIGTERM');await running;assert.ok(!f.calls.some(c=>/stop|resume|start|send/.test(c.endpoint)));
});
test('instance changes reject in-flight old input and discard unsent old chunks',async t=>{
 let release,arrived=false;const gate=new Promise(resolve=>{release=resolve;});const f=mock(t,{input:async()=>{arrived=true;await gate;}}),running=f.start();t.after(()=>{release();f.signals.emit('SIGTERM');});
 await until(()=>f.calls.some(c=>c.endpoint==='/work/resize'));f.stdin.write('old draft '.repeat(1000));await until(()=>arrived);f.state.instance=secondInstance;f.state.output='Replacement CLI> ';await until(()=>f.stdout.text.includes('Replacement CLI'));release();await delay(50);
 assert.equal(f.accepted.length,0);assert.equal(f.calls.filter(c=>c.endpoint==='/work/input').length,1);assert.match(f.stdout.text,/changed|rejected/);f.signals.emit('SIGTERM');await running;
});
test('uncertain input POST is never retried and pending text is not resent',async t=>{
 let posts=0;const f=mock(t,{input:async()=>{posts++;throw new Error('connection lost after POST');}}),running=f.start();t.after(()=>f.signals.emit('SIGTERM'));
 await until(()=>f.calls.some(c=>c.endpoint==='/work/resize'));f.stdin.write('one draft '.repeat(900));await until(()=>f.stdout.text.includes('could not be confirmed'));await delay(50);assert.equal(posts,1);assert.equal(f.accepted.length,0);f.signals.emit('SIGTERM');await running;
});
test('geometry-aware replay preserves colored screen, alternate buffer transitions and idle cost',async()=>{
 const native=new xterm.Terminal({cols:30,rows:8,allowProposedApi:true}),writes=[];const write=data=>new Promise(resolve=>{writes.push(data);native.write(data,resolve);});
 const display=new TerminalAttachmentDisplay(write,()=>({cols:30,rows:8}));
 try{
  const frames=[{cols:20,rows:5,data:'\x1b[31mNormalFrame\x1b[0m\r\nOlder line'},{cols:30,rows:8,data:'\x1b[?1049h\x1b[2J\x1b[H\x1b[32mAlternateFrame\x1b[0m\x1b[?2004h'}];const data=frames.map(f=>f.data).join('');await display.consume({instance:firstInstance,cursor:data.length,reset:true,data,frames});
  assert.equal(native.buffer.active.type,'alternate');assert.match(native.buffer.active.getLine(0).translateToString(true),/AlternateFrame/);assert.equal(native.buffer.active.getLine(0).getCell(0).getFgColor(),2);assert.equal(native.modes.bracketedPasteMode,true);
  await display.consume({instance:firstInstance,cursor:data.length+8,data:'\x1b[?1049l',frames:[{cols:30,rows:8,data:'\x1b[?1049l'}]});assert.equal(native.buffer.active.type,'normal');assert.match(native.buffer.active.getLine(0).translateToString(true),/NormalFrame/);
  const count=writes.length;await display.consume({instance:firstInstance,cursor:data.length+8,data:'',frames:[{cols:30,rows:8,data:''}]});assert.equal(writes.length,count);
 }finally{display.dispose();native.dispose();}
});
test('real CLI rejects piped input without contacting an isolated HTTP bridge',async t=>{
 const f=fixture(t);let calls=0;const server=http.createServer((_req,res)=>{calls++;res.end('{}');});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 const child=spawn(process.execPath,[entry,'--runtime',f.runtimeDir,'--task',taskId,'--bridge',`http://127.0.0.1:${server.address().port}`],{windowsHide:true,stdio:['pipe','pipe','pipe']});let error='';child.stderr.on('data',data=>{error+=data;});const [code]=await once(child,'exit');assert.equal(code,1);assert.match(error,/Piped input/);assert.equal(calls,0);
});
test('real PTY attachments exit naturally on native Restart takeover and tab close; invalid owner never reaches HTTP',{timeout:35000},async t=>{
 const f=fixture(t),requests=[],accepted=[];let current,connections=0;
 const owner=await lifetimeServer(t,socket=>{current?.destroy();current=socket;connections++;socket.write('READY\n');});
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1'),chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null;requests.push(url.pathname);let result;
  if(url.pathname==='/work')result={attachmentProtocol:1,vault:f.runtimeDir,tasks:[{id:taskId,state:'ready',pid:123}]};
  else if(url.pathname==='/work/output'){const reset=url.searchParams.get('instance')!==firstInstance,data=reset?'Native lifetime fixture> ':'';result={instance:firstInstance,cursor:24,data,frames:[{cols:80,rows:24,data}],reset,state:'ready'};}
  else{assert.equal(req.headers['x-v2-token'],f.token);assert.equal(body.instance,firstInstance);assert.ok(['/work/resize','/work/input'].includes(url.pathname));if(url.pathname==='/work/input')accepted.push(body.data);result={ok:true};}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});const bridge=`http://127.0.0.1:${server.address().port}`;
 const first=ptyClient(t,f,bridge,owner.endpoint);const firstStartup=await ptyPhase(()=>first.state.text.includes('Native lifetime fixture'),10000,'Initial PTY startup',first);
 const second=ptyClient(t,f,bridge,owner.endpoint);const replacementStartup=await ptyPhase(()=>connections===2&&second.state.text.includes('Native lifetime fixture'),10000,'Replacement PTY startup',second);await ptyPhase(()=>first.state.exited,5000,'Superseded client exit',first);assert.equal((await first.completion).exitCode,0);
 second.child.write('only the new viewer\r');await until(()=>accepted.join('').includes('only the new viewer\r'));owner.close();const closeExit=await ptyPhase(()=>second.state.exited,5000,'Owner-close client exit',second);assert.equal((await second.completion).exitCode,0);
 const count=requests.length;await delay(100);assert.equal(requests.length,count);assert.ok(requests.every(endpoint=>['/work','/work/output','/work/input','/work/resize'].includes(endpoint)));
 let invalidConnected=false;const invalidOwner=await lifetimeServer(t,socket=>{invalidConnected=true;socket.end('NO\n');});fs.unlinkSync(path.join(f.runtimeDir,'bridge-auth.json'));const rejected=ptyClient(t,f,bridge,invalidOwner.endpoint);const rejectedStartup=await ptyPhase(()=>invalidConnected||rejected.state.exited,10000,'Invalid-owner PTY startup',rejected);assert.equal(invalidConnected,true);const rejectedExit=await ptyPhase(()=>rejected.state.exited,5000,'Rejected-handshake client exit',rejected);assert.equal((await rejected.completion).exitCode,1);assert.match(rejected.state.text,/lifetime handshake/);assert.equal(requests.length,count);
 t.diagnostic(`PTY startup: initial ${firstStartup} ms, replacement ${replacementStartup} ms, invalid owner ${rejectedStartup} ms. Natural exit: owner close ${closeExit} ms, rejected handshake ${rejectedExit} ms.`);
});
test('real PTY client talks only to isolated HTTP bridge and exiting the attachment never stops its task',{timeout:18000},async t=>{
 const f=fixture(t),requests=[],accepted=[];let instance=firstInstance,output='Isolated attachment fixture> ',cols=80,rows=24;
 const server=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://127.0.0.1');const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null;requests.push(url.pathname);let result;
  if(url.pathname==='/work')result={attachmentProtocol:1,vault:f.runtimeDir,tasks:[{id:taskId,state:'ready',pid:123}]};
  else if(url.pathname==='/work/output'){const reset=url.searchParams.get('instance')!==instance,data=reset?output:output.slice(Number(url.searchParams.get('cursor')));result={instance,cursor:output.length,data,frames:[{cols,rows,data}],reset,state:'ready'};}
  else{assert.equal(req.headers['x-v2-token'],f.token);assert.equal(body.instance,instance);if(url.pathname==='/work/input')accepted.push(body.data);else if(url.pathname==='/work/resize'){cols=body.cols;rows=body.rows;}else assert.fail('Attachment attempted '+url.pathname);result={ok:true};}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));});server.listen(0,'127.0.0.1');await once(server,'listening');
 const require=createRequire(import.meta.url),pty=require('node-pty'),args=[entry,'--runtime',f.runtimeDir,'--task',taskId,'--bridge',`http://127.0.0.1:${server.address().port}`];
 const child=pty.spawn(process.execPath,process.platform==='win32'?windowsArguments(args):args,{cwd:repo,env:{...process.env,TERM:'xterm-256color'},name:'xterm-256color',cols:80,rows:24,useConpty:true});let exited=false,text='';const completion=new Promise(resolve=>child.onExit(event=>{exited=true;resolve(event);}));child.onData(data=>{text+=data;});
 t.after(async()=>{if(!exited){try{process.kill(child.pid,'SIGTERM');}catch{}}await Promise.race([completion,delay(2000)]);if(process.platform==='win32'&&exited)await releaseStoppedWindowsPty(child);server.closeAllConnections();server.close();});
 await ptyPhase(()=>requests.includes('/work/resize')&&text.includes('Isolated attachment fixture'),10000,'Standalone PTY startup',{get state(){return {text,exited};}});child.write('hello fixture\r\x03');await until(()=>accepted.join('').includes('hello fixture\r\x03'));process.kill(child.pid,'SIGTERM');await completion;
 assert.ok(requests.every(endpoint=>['/work','/work/output','/work/input','/work/resize'].includes(endpoint)));assert.doesNotMatch(text,new RegExp(f.token));
});
