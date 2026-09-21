import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {build} from 'esbuild';
const built=await build({entryPoints:['src/lib/direct-terminal-pty.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {bindDirectTerminal,DIRECT_TERMINAL_LAUNCH_TIMEOUT_MS}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// The binding's own poll timer is unreferenced (it must never keep Obsidian alive), so the tests keep the loop alive.
const keepAlive=setInterval(()=>{},25);test.after(()=>clearInterval(keepAlive));

// A Terminal view whose emulator, pseudoterminal and process can each arrive late, or never.
function slowTerminal(t,{timeoutMs=120,emulatorAt=0}={}){
 const stdout=new EventEmitter(),stderr=new EventEmitter(),input=new Set(),cleanup=[],events=[];
 const process={pid:456,exitCode:null,signalCode:null,stdout,stderr,stdin:{write(_data,callback){callback()}}};
 let givePty,failPty,giveShell,failShell,exit;
 const pty={shell:new Promise((resolve,reject)=>{giveShell=()=>resolve(process);failShell=reject}),onExit:new Promise(resolve=>exit=resolve),async kill(){}};
 const emulator={pseudoterminal:new Promise((resolve,reject)=>{givePty=()=>resolve(pty);failPty=reject}),terminal:{onData(listener){input.add(listener);return {dispose(){input.delete(listener)}}}}};
 const view={emulator:emulatorAt===0?emulator:null,register(fn){cleanup.push(fn)}};
 if(emulatorAt>0)setTimeout(()=>{view.emulator=emulator},emulatorAt);
 const callbacks=Object.fromEntries(['ready','input','approval','closed','error','exit'].map(type=>[type,value=>events.push({type,value})]));
 const binding=bindDirectTerminal(view,callbacks,{pollMs:2,timeoutMs});t.after(()=>binding.dispose());
 const types=()=>events.map(event=>event.type);
 return {view,emulator,binding,events,types,input,cleanup,stdout,stderr,givePty,failPty,giveShell,failShell,exit};
}

test('the exported default launch patience, used when no timeout is given, is 27 seconds',()=>assert.equal(DIRECT_TERMINAL_LAUNCH_TIMEOUT_MS,27000));

test('a process exposed late, but inside the limit, becomes ready with no alarm; a draft typed meanwhile is kept',{timeout:20000},async t=>{
 const f=slowTerminal(t,{timeoutMs:10000});
 await wait(60);assert.deepEqual(f.types(),[]);
 for(const listener of f.input)listener('half a sentence');                  // the human types while the terminal is still starting
 f.givePty();await wait(60);assert.deepEqual(f.types().filter(type=>type!=='input'),[]);
 f.giveShell();await f.binding.ready;
 assert.deepEqual(f.types().filter(type=>type!=='input'),['ready']);assert.equal(f.binding.active,true);assert.equal(f.binding.hasDraft,true);
 assert.equal(f.stdout.listenerCount('data'),1);
});

test('an emulator that is assigned late, then a process, is an ordinary launch',{timeout:20000},async t=>{
 const f=slowTerminal(t,{timeoutMs:10000,emulatorAt:80});
 await wait(40);assert.deepEqual(f.types(),[]);
 await wait(80);f.givePty();f.giveShell();await f.binding.ready;
 assert.deepEqual(f.types(),['ready']);
});

test('no terminal at all is still reported, and the message says that nothing opened',async t=>{
 const f=slowTerminal(t,{timeoutMs:60,emulatorAt:-1});
 await assert.rejects(f.binding.ready,/Terminal did not open before the launch timeout\./);
 assert.deepEqual(f.events,[{type:'error',value:'Terminal did not open before the launch timeout.'},{type:'closed',value:'disposed'}]);
 assert.equal(f.binding.active,false);
});

test('a terminal whose process never appears is still reported, with the message used until now',async t=>{
 const f=slowTerminal(t,{timeoutMs:60});
 await assert.rejects(f.binding.ready,/Terminal did not expose its process before the launch timeout\./);
 assert.deepEqual(f.events,[{type:'error',value:'Terminal did not expose its process before the launch timeout.'},{type:'closed',value:'disposed'}]);
 // Half-way counts as not exposed: the pseudoterminal arrived, the process did not.
 const g=slowTerminal(t,{timeoutMs:60});g.givePty();
 await assert.rejects(g.binding.ready,/did not expose its process/);
});

test('a process that arrives after the alarm is not resurrected',async t=>{
 const f=slowTerminal(t,{timeoutMs:50});
 await assert.rejects(f.binding.ready);
 f.givePty();f.giveShell();await wait(30);
 assert.deepEqual(f.types(),['error','closed']);assert.equal(f.binding.active,false);
 assert.equal(f.stdout.listenerCount('data'),0);assert.equal(f.stderr.listenerCount('data'),0);assert.equal(f.input.size,0);
 await assert.rejects(f.binding.write('x'));
});

test('a replaced emulator or a closed view while waiting ends the wait quietly, and a late process changes nothing',{timeout:20000},async t=>{
 const replaced=slowTerminal(t,{timeoutMs:10000});await wait(20);
 replaced.view.emulator={pseudoterminal:new Promise(()=>{}),terminal:{onData(){return {dispose(){}}}}};
 await assert.rejects(replaced.binding.ready);replaced.givePty();replaced.giveShell();await wait(20);
 assert.deepEqual(replaced.types(),['closed']);assert.deepEqual(replaced.events[0],{type:'closed',value:'replaced'});
 const unloaded=slowTerminal(t,{timeoutMs:10000});await wait(20);
 unloaded.cleanup.forEach(fn=>fn());await assert.rejects(unloaded.binding.ready);unloaded.givePty();unloaded.giveShell();await wait(20);
 assert.deepEqual(unloaded.events,[{type:'closed',value:'closed'}]);assert.equal(unloaded.stdout.listenerCount('data'),0);
});

test('a failing pseudoterminal or process while waiting is reported as before, not as a timeout',{timeout:20000},async t=>{
 const a=slowTerminal(t,{timeoutMs:10000});await wait(10);a.failPty(new Error('pty refused'));
 await assert.rejects(a.binding.ready,/pty refused/);assert.deepEqual(a.events,[{type:'error',value:'pty refused'},{type:'closed',value:'disposed'}]);
 const b=slowTerminal(t,{timeoutMs:10000});b.givePty();await wait(10);b.failShell(new Error('shell refused'));
 await assert.rejects(b.binding.ready,/shell refused/);assert.deepEqual(b.events,[{type:'error',value:'shell refused'},{type:'closed',value:'disposed'}]);
});

test('the terminal exiting while its process is still awaited ends the wait as a closed terminal, not as a timeout',{timeout:20000},async t=>{
 const f=slowTerminal(t,{timeoutMs:10000});f.givePty();await wait(20);f.exit(1);
 await assert.rejects(f.binding.ready);await wait(10);
 assert.deepEqual(f.events,[{type:'exit',value:1},{type:'closed',value:'closed'}]);
 f.giveShell();await wait(20);assert.deepEqual(f.types(),['exit','closed']);assert.equal(f.stdout.listenerCount('data'),0);
});

test('with the pseudoterminal already there, a process that arrives after the alarm is not resurrected either',{timeout:20000},async t=>{
 const f=slowTerminal(t,{timeoutMs:60});f.givePty();
 await assert.rejects(f.binding.ready,/did not expose its process/);
 f.giveShell();await wait(30);
 assert.deepEqual(f.types(),['error','closed']);assert.equal(f.binding.active,false);assert.equal(f.stdout.listenerCount('data'),0);assert.equal(f.input.size,0);
});
