import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {build} from 'esbuild';
const built=await build({entryPoints:['src/lib/direct-terminal-pty.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {bindDirectTerminal}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,options={}){
 const stdout=new EventEmitter(),stderr=new EventEmitter(),display=[],writes=[],input=new Set(),cleanup=[],events=[];
 stdout.on('data',data=>display.push(data));
 const process={pid:456,exitCode:null,signalCode:null,stdout,stderr,stdin:{write(data,callback){writes.push(data);callback()}}};
 let exit;const pty={shell:Promise.resolve(process),onExit:new Promise(resolve=>exit=resolve),kills:0,async kill(){this.kills++}};
 const emulator={pseudoterminal:Promise.resolve(pty),terminal:{onData(listener){input.add(listener);return {dispose(){input.delete(listener)}}}}};
 const view={emulator,register(fn){cleanup.push(fn)}},callbacks=Object.fromEntries(['ready','input','approval','closed','error','exit'].map(type=>[type,value=>events.push({type,value})]));
 const binding=bindDirectTerminal(view,callbacks,{pollMs:1,...options});t.after(()=>binding.dispose());
 return {stdout,stderr,display,writes,input,cleanup,events,process,pty,view,emulator,binding,exit};
}
test('native observation preserves Terminal display listeners and writes only to its current process',async t=>{
 const f=fixture(t);await f.binding.ready;assert.equal(f.binding.hostPid,456);assert.equal(f.stdout.listenerCount('data'),2);
 f.stdout.emit('data',Buffer.from('hello'));assert.equal(f.display.length,1);await f.binding.write('test');assert.deepEqual(f.writes,['test']);
 f.binding.dispose();assert.equal(f.stdout.listenerCount('data'),1);assert.equal(f.stderr.listenerCount('data'),0);assert.equal(f.input.size,0);assert.equal(f.pty.kills,0);await assert.rejects(f.binding.write('unsafe'),/changed or exited/);
});
test('human drafts and submits are observed while automatic terminal responses are ignored',async t=>{
 const f=fixture(t);await f.binding.ready;for(const listener of f.input)listener('\x1b]10;rgb:ffff/ffff/ffff\x07');assert.equal(f.binding.hasDraft,false);
 for(const listener of f.input)listener('unfinished');assert.equal(f.binding.hasDraft,true);assert.equal(f.events.at(-1).value.edited,true);
 f.binding.clearApproval();assert.equal(f.binding.hasDraft,true);for(const listener of f.input)listener('\r');assert.equal(f.binding.hasDraft,false);assert.equal(f.events.at(-1).value.submitted,true);
});
test('approval parsing is local, survives fragmented output and never changes the display stream',async t=>{
 const f=fixture(t);await f.binding.ready;
 for(const chunk of ['Would you like to run this ','command?\r\n› 1. Yes\r\n  2. No\r\n'])f.stdout.emit('data',Buffer.from(chunk));
 assert.match(f.binding.approval,/your approval/);assert.equal(f.display.length,2);assert.equal(f.events.filter(event=>event.type==='approval').length,1);
 f.binding.clearApproval();assert.equal(f.binding.approval,null);
});
test('history navigation is treated as a possible draft instead of an empty composer',async t=>{
 const f=fixture(t);await f.binding.ready;for(const listener of f.input)listener('\x1b[A');assert.equal(f.binding.hasDraft,true);assert.equal(f.events.at(-1).value.edited,true);
});

for(const provider of ['codex','claude'])test(`${provider} native trust prompt names its own provider without answering it`,async t=>{
 const f=fixture(t,{provider});await f.binding.ready;
 const screen='Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit\n';
 for(let at=0;at<screen.length;at+=7)f.stdout.emit('data',Buffer.from(screen.slice(at,at+7)));
 assert.match(f.binding.approval,new RegExp(provider==='claude'?'^Claude Code':'^Codex'));
 assert.deepEqual(f.writes,[]);
});

test('non-editing keys and fragmented reports never invent or erase a human draft',async t=>{
 const f=fixture(t);await f.binding.ready;
 const keys=['\x1b[C','\x1b[D','\x1b[H','\x1b[F','\x1b[1;5C','\x1bOC','\x1bOD','\x01','\x05','\x1b'];
 for(const key of keys)for(const listener of f.input)listener(key);
 for(const fragment of ['\x1b','[','I','\x1b','[','O'])for(const listener of f.input)listener(fragment);
 assert.equal(f.binding.hasDraft,false);assert.equal(f.events.some(event=>event.type==='input'),false);
 for(const listener of f.input)listener('keep my draft');
 for(const key of keys)for(const listener of f.input)listener(key);
 assert.equal(f.binding.hasDraft,true);
});

test('history recall and autocomplete still protect possible human text',async t=>{
 for(const key of ['\x1b[A','\x1b[B','\x1bOA','\t','\x10','\x0e','\x12']){
  const f=fixture(t);await f.binding.ready;for(const listener of f.input)listener(key);assert.equal(f.binding.hasDraft,true,JSON.stringify(key));
 }
});
test('focus and recognized mouse reports never create drafts or emit editing',async t=>{
 const f=fixture(t);await f.binding.ready;
 const reports=['\x1b[I','\x1b[O','\x1b[<0;12;8M','\x1b[<0;12;8m','\x1b[<64;12;8M','\x1b[32;12;8M','\x1b[M !!'];
 for(const report of [...reports,reports.join('')])for(const listener of f.input)listener(report);
 assert.equal(f.binding.hasDraft,false);assert.equal(f.events.some(event=>event.type==='input'),false);
 for(const listener of f.input)listener('\x1b[A');assert.equal(f.binding.hasDraft,true);assert.equal(f.events.at(-1).value.edited,true);
});
test('a replaced emulator immediately rejects input and detaches observers without killing either process',async t=>{
 const f=fixture(t);await f.binding.ready;f.view.emulator={...f.emulator};await assert.rejects(f.binding.write('wrong session'),/changed or exited/);
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.binding.active,false);assert.equal(f.pty.kills,0);assert.ok(f.events.some(event=>event.type==='closed'&&event.value==='replaced'));
});
test('exit and real view unload close once and never stop an unrelated process',async t=>{
 const f=fixture(t);await f.binding.ready;f.exit(0);await tick();f.cleanup.forEach(fn=>fn());assert.equal(f.binding.active,false);assert.equal(f.events.filter(event=>event.type==='closed').length,1);assert.equal(f.pty.kills,0);
});
test('a child which has already exited cannot be reported ready or accept input',async t=>{
 const f=fixture(t);f.process.exitCode=1;await assert.rejects(f.binding.ready,/changed or exited/);assert.equal(f.binding.active,false);assert.equal(f.writes.length,0);
});
