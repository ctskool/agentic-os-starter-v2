import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {build} from 'esbuild';
const built=await build({entryPoints:['src/lib/terminal-lifetime.ts'],bundle:true,platform:'node',format:'esm',write:false});
const source=built.outputFiles[0].text,load=(suffix='')=>import('data:text/javascript;base64,'+Buffer.from(source+'\n// '+suffix).toString('base64'));
const {createTerminalLifetime,bindTerminalLifetime,lifetimeForView}=await load();
const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Socket fixture timed out')),3000)})])}finally{clearTimeout(timer)}};
async function connect(endpoint){const socket=net.connect(endpoint);await bounded(once(socket,'connect'));const [data]=await bounded(once(socket,'data'));assert.equal(data.toString(),'READY\n');return socket}
async function lifetime(t){const controller=await createTerminalLifetime({net,platform:process.platform,id:randomUUID(),tmpdir:os.tmpdir()});t.after(()=>controller.close());return controller}
test('view unload closes the local socket and only its lifetime controller',async t=>{
 const controller=await lifetime(t),callbacks=[],view={register(fn){callbacks.push(fn)}};bindTerminalLifetime(view,controller);
 const socket=await connect(controller.endpoint);t.after(()=>socket.destroy());assert.equal(lifetimeForView(view),controller);
 const closed=once(socket,'close');callbacks[0]();await bounded(closed);assert.equal(controller.active,false);assert.equal(lifetimeForView(view),undefined);
});
test('Terminal Restart replaces the old client while keeping the same tab socket available',async t=>{
 const controller=await lifetime(t),first=await connect(controller.endpoint);t.after(()=>first.destroy());const retired=once(first,'close');
 const replacement=await connect(controller.endpoint);t.after(()=>replacement.destroy());await bounded(retired);assert.equal(controller.active,true);assert.equal(replacement.destroyed,false);
});
test('a V2 module reload retains the same controller until its Terminal view unloads',async t=>{
 const controller=await lifetime(t),cleanup=[],view={register(fn){cleanup.push(fn)}};bindTerminalLifetime(view,controller);
 const reloaded=await load(randomUUID());assert.equal(reloaded.lifetimeForView(view),controller);assert.equal(controller.active,true);cleanup[0]();assert.equal(reloaded.lifetimeForView(view),undefined);
});
test('lifetime service needs no polling timer and contains no task or HTTP control path',async t=>{
 const previous=globalThis.setInterval;globalThis.setInterval=()=>assert.fail('Lifetime control must be event driven');
 try{const controller=await lifetime(t);const socket=await connect(controller.endpoint);socket.destroy();controller.close()}finally{globalThis.setInterval=previous}
 assert.doesNotMatch(source,/\/work\/|taskkill|child_process|setInterval/);
});
test('browser preview can bundle the adapter without eagerly resolving Node modules',async()=>{
 const result=await build({entryPoints:['src/lib/native-terminal.ts'],bundle:true,platform:'browser',format:'esm',write:false});
 assert.ok(result.outputFiles[0].text.includes('AOS_V2_TERMINAL_LIFETIME'));
});
