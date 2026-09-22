import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import net from 'node:net';import {EventEmitter,once} from 'node:events';
import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
import {connectNativeOwner,readNativeTicket,runNativeLaunch} from '../runner/native-launch.mjs';
import {windowsArguments,releaseStoppedWindowsPty} from '../runner/terminal-transport.mjs';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-native-launch-')),events=path.join(root,'events');fs.mkdirSync(events);
 const file=path.join(root,'launch.json'),ticket={version:1,taskId:crypto.randomUUID(),instance:crypto.randomUUID(),cwd:root,command:process.execPath,args:['-e','process.stdout.write("hello\\n")','a\r\nb & c ^ ! %'],env:{AOS_WORK_PROMPT:'one\ntwo'},events};
 fs.writeFileSync(file,JSON.stringify(ticket));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {file,ticket,events,write:()=>fs.writeFileSync(file,JSON.stringify(ticket)),readEvents:()=>fs.readdirSync(events).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(fs.readFileSync(path.join(events,name),'utf8')))};
}
function fake(){const child=new EventEmitter(),signals=new EventEmitter(),calls=[],kills=[];child.pid=12345;child.kill=signal=>{kills.push(signal);queueMicrotask(()=>child.emit('exit',null,signal));return true};return {child,signals,calls,kills,spawnImpl:(...args)=>{calls.push(args);queueMicrotask(()=>child.emit('spawn'));return child}}}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function owner(t,onConnect){
 const name='aos-v2-terminal-'+crypto.randomUUID(),endpoint=process.platform==='win32'?'\\\\.\\pipe\\'+name:path.join('/tmp',name+'.sock'),sockets=new Set();
 const server=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));onConnect(socket)});server.listen(endpoint);await once(server,'listening');
 t.after(()=>{for(const socket of sockets)socket.destroy();server.close()});return {endpoint,server,sockets};
}
async function until(fn){const start=Date.now();while(!fn()){if(Date.now()-start>1000)assert.fail('Timed out waiting for native owner fixture');await new Promise(resolve=>setTimeout(resolve,5))}}
test('native launch inherits the Terminal TTY directly and preserves multiline argv without a shell',async t=>{
 const f=fixture(t),p=fake(),running=runNativeLaunch(f.file,{...p,env:{KEEP:'yes',CLAUDECODE:'nested'},stderr:{write(){assert.fail('no launcher errors')}}});await tick();
 assert.equal(p.calls.length,1);const [command,args,options]=p.calls[0];assert.equal(command,process.execPath);assert.deepEqual(args,f.ticket.args);assert.equal(options.shell,false);assert.equal(options.stdio,'inherit');assert.equal(options.windowsHide,true);
 assert.equal(options.env.CLAUDECODE,undefined);assert.equal(options.env.KEEP,'yes');assert.equal(options.env.AOS_NATIVE_INSTANCE,f.ticket.instance);assert.equal(options.env.AOS_NATIVE_TASK_ID,f.ticket.taskId);assert.equal(options.env.AOS_WORK_EVENTS,f.events);
 assert.deepEqual(p.child.eventNames().sort(),['error','exit']);assert.ok(fs.existsSync(f.file+'.claimed'));
 assert.equal(f.readEvents().length,1);assert.equal(f.readEvents()[0].type,'native-start');assert.equal(f.readEvents()[0].pid,p.child.pid);
 p.child.emit('exit',0,null);assert.equal(await running,0);assert.equal(f.readEvents().filter(event=>event.type==='native-exit').length,1);assert.equal(p.signals.listenerCount('SIGINT'),0);assert.equal(p.signals.listenerCount('SIGTERM'),0);
});
test('a consumed launch cannot spawn twice or publish a misleading exit for the existing CLI',async t=>{
 const f=fixture(t),p=fake(),running=runNativeLaunch(f.file,p);await tick();
 await assert.rejects(runNativeLaunch(f.file,p),/already used/);assert.equal(p.calls.length,1);assert.equal(f.readEvents().length,1);
 p.child.emit('exit',0,null);await running;
});
test('native ownership handshake gates claiming and owner close ends the owned child tree',async t=>{
 const f=fixture(t),p=fake(),killer=new EventEmitter();killer.kill=()=>{};let socket;
 const lifetime=await owner(t,value=>{socket=value;socket.write('REA')});
 const spawnImpl=(command,args,options)=>{if(command===f.ticket.command)return p.spawnImpl(command,args,options);p.calls.push([command,args,options]);queueMicrotask(()=>p.child.emit('exit',null,'SIGTERM'));return killer};
 const running=runNativeLaunch(f.file,{...p,spawnImpl,env:{AOS_V2_TERMINAL_LIFETIME:lifetime.endpoint}});
 await until(()=>socket);assert.equal(p.calls.length,0);assert.equal(fs.existsSync(f.file+'.claimed'),false);
 socket.write('DY\n');await until(()=>p.calls.length===1);socket.destroy();assert.equal(await running,143);
 assert.equal(f.readEvents().filter(event=>event.type==='native-exit').length,1);
 if(process.platform==='win32')assert.deepEqual(p.calls[1][1],['/PID','12345','/T','/F']);else assert.deepEqual(p.kills,['SIGTERM']);
});
test('invalid or disconnected native owners fail before a claim or CLI spawn',async t=>{
 assert.throws(()=>connectNativeOwner('http://127.0.0.1:3219'),/lifetime socket/);
 for(const response of ['NO\n','']){
  const f=fixture(t),p=fake(),lifetime=await owner(t,socket=>socket.end(response));
  await assert.rejects(runNativeLaunch(f.file,{...p,env:{AOS_V2_TERMINAL_LIFETIME:lifetime.endpoint}}),/closed before/);assert.equal(p.calls.length,0);assert.equal(fs.existsSync(f.file+'.claimed'),false);assert.equal(f.readEvents().length,0);
 }
});
test('Ctrl+C is received by the console group once; SIGTERM ends the owned child on Unix',async t=>{
 const f=fixture(t),p=fake(),running=runNativeLaunch(f.file,{...p,platform:'darwin'});await tick();
 p.signals.emit('SIGINT');assert.deepEqual(p.kills,[]);p.signals.emit('SIGTERM');assert.equal(await running,143);assert.deepEqual(p.kills,['SIGTERM']);
 assert.equal(f.readEvents().find(event=>event.type==='native-exit').signal,'SIGTERM');
});
test('a hangup (Terminal 3.27.2 closing a Mac pane sends SIGHUP first) stops the owned child and reports its exit once',async t=>{
 const f=fixture(t),p=fake(),running=runNativeLaunch(f.file,{...p,platform:'darwin'});await tick();
 p.signals.emit('SIGHUP');p.signals.emit('SIGHUP');assert.equal(await running,143);assert.deepEqual(p.kills,['SIGTERM']);
 assert.equal(f.readEvents().filter(event=>event.type==='native-exit').length,1);
});
test('Windows termination targets only this launcher child tree and never a reported or restored PID',async t=>{
 const f=fixture(t),p=fake(),killer=new EventEmitter();killer.kill=()=>{};
 const spawnImpl=(command,args,options)=>{if(command===f.ticket.command)return p.spawnImpl(command,args,options);p.calls.push([command,args,options]);queueMicrotask(()=>p.child.emit('exit',null,'SIGTERM'));return killer};
 const running=runNativeLaunch(f.file,{...p,spawnImpl,platform:'win32',env:{SystemRoot:'C:\\Windows'}});await tick();p.signals.emit('SIGTERM');assert.equal(await running,143);
 assert.match(p.calls[1][0],/taskkill\.exe$/);assert.deepEqual(p.calls[1][1],['/PID','12345','/T','/F']);assert.equal(p.calls[1][2].shell,false);assert.equal(p.calls[1][2].stdio,'ignore');
});
test('an executable spawn failure remains consumed and publishes one failure without exposing prompt text',async t=>{
 const f=fixture(t),p=fake(),errors=[];const running=runNativeLaunch(f.file,{...p,stderr:{write:text=>errors.push(text)}});p.child.emit('error',new Error('could not spawn'));assert.equal(await running,1);
 assert.equal(f.readEvents().length,1);assert.equal(f.readEvents()[0].type,'native-exit');assert.doesNotMatch(JSON.stringify(f.readEvents()),/one\\ntwo/);assert.equal(errors.length,1);
 await assert.rejects(runNativeLaunch(f.file,p),/already used/);assert.equal(p.calls.length,1);
});
test('invalid tickets cannot claim or launch arbitrary malformed command vectors',t=>{
 for(const mutation of [ticket=>ticket.command='relative',ticket=>ticket.args=['bad\0argument'],ticket=>ticket.env={BAD:'x\0y'},ticket=>ticket.instance='invalid',ticket=>ticket.claimFile='C:/different.claimed']){
  const f=fixture(t);mutation(f.ticket);f.write();assert.throws(()=>readNativeTicket(f.file));assert.equal(fs.existsSync(f.file+'.claimed'),false);
 }
});

test('real native launcher passes a real TTY and multiline request directly to its child',{timeout:15000},async t=>{
 const f=fixture(t),entry=fileURLToPath(new URL('../runner/native-launch.mjs',import.meta.url)),require=createRequire(import.meta.url),pty=require('node-pty');
 const request='first line\nsecond & ^ ! % "quoted" line';
 f.ticket.args=['-e','process.stdout.write("NATIVE-TTY:"+JSON.stringify({tty:!!process.stdin.isTTY&&!!process.stdout.isTTY,request:process.argv.at(-1)})+"\\n")','--',request];f.write();
 const args=[entry,'--ticket',f.file];const child=pty.spawn(process.execPath,process.platform==='win32'?windowsArguments(args):args,{cwd:f.ticket.cwd,env:{...process.env,TERM:'xterm-256color'},name:'xterm-256color',cols:120,rows:24,useConpty:true});
 let text='',exited=false;child.onData(data=>{text+=data});const done=new Promise(resolve=>child.onExit(event=>{exited=true;resolve(event)}));
 t.after(async()=>{if(!exited){try{process.kill(child.pid,'SIGTERM')}catch{}}await Promise.race([done,new Promise(resolve=>setTimeout(resolve,2000))]);if(process.platform==='win32'&&exited)await releaseStoppedWindowsPty(child)});
 const event=await done;assert.equal(event.exitCode,0,text);const plain=text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
 assert.match(plain,/NATIVE-TTY:/);assert.ok(plain.includes(JSON.stringify({tty:true,request})),plain);
 const events=f.readEvents();assert.equal(events.filter(event=>event.type==='native-start').length,1);assert.equal(events.filter(event=>event.type==='native-exit').length,1);
});
