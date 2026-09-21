import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const built=await build({entryPoints:['src/lib/native-direct-host.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {NativeDirectHost}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const task='11111111-1111-4111-8111-111111111111',instance='22222222-2222-4222-8222-222222222222',launchId='33333333-3333-4333-8333-333333333333',sendId='44444444-4444-4444-8444-444444444444',key='55555555-5555-4555-8555-555555555555';
function fixture(){
 const leaves=[],calls=[],notices=[],revealed=[],bindings=[],pending=[],lifetimes=[];
 const launch={id:launchId,taskId:task,instance,type:'launch',provider:'codex',title:'Fixture',launch:{executable:'C:\\Program Files\\nodejs\\node.exe',args:['C:\\fixture\\runner\\native-launch.mjs','--ticket','C:\\fixture\\launch.json'],cwd:'C:\\fixture vault',environment:[]}};
 const actions=new Map([[launch.id,launch]]);
 const app={vault:{adapter:{getBasePath:()=>launch.launch.cwd}},plugins:{plugins:{terminal:{manifest:{version:'3.27.1'},settings:{value:{defaultProfile:'shell',profiles:{shell:{type:'integrated',pythonExecutable:'python',terminalOptions:{fontSize:15},useWin32Conhost:false}}}}}}},workspace:{getLeavesOfType:type=>leaves.filter(leaf=>leaf.state.type===type)}};
 const options={app,notice:message=>notices.push(message),reveal:async leaf=>revealed.push(leaf),settle:async()=>{},
  async createLifetime(){const lifetime={endpoint:'\\\\.\\pipe\\aos-test-'+lifetimes.length,active:true,close(){this.active=false}};lifetimes.push(lifetime);return lifetime},
  createLeaf(){const cleanups=[],leaf={state:{type:'empty'},view:{register(fn){cleanups.push(fn)}},sets:0,getViewState(){return this.state},async setViewState(state){this.sets++;this.state=structuredClone(state)},detach(){for(const cleanup of cleanups)cleanup();leaves.splice(leaves.indexOf(this),1)}};leaves.push(leaf);return leaf},
  bind(view,callbacks){const binding={active:true,hostPid:789,hasDraft:false,approval:null,writes:[],stops:0,async write(data){this.writes.push(data)},clearApproval(){this.approval=null},async stop(){this.stops++},dispose(){this.active=false;callbacks.closed('disposed')}};binding.ready=Promise.resolve().then(()=>callbacks.ready({hostPid:789}));bindings.push({binding,callbacks});return binding},
  async request(path,body){calls.push({path,body:structuredClone(body)});if(path==='/native/pending')return {actions:pending.splice(0)};if(path==='/native/claim')return {action:structuredClone(actions.get(body.id))};if(path==='/native/submit-check')return {submit:true};return {}},
 };
 const host=new NativeDirectHost(options);
 const queue=action=>{actions.set(action.id,action);pending.push({id:action.id,taskId:action.taskId,instance:action.instance,type:action.type})};
 const send=()=>queue({id:sendId,taskId:task,instance,type:'send',text:'Follow up\nwith detail',requestKey:key});
 return {host,options,app,leaves,calls,notices,revealed,bindings,pending,launch,queue,send,lifetimes};
}
const events=f=>f.calls.filter(call=>call.path==='/native/event').map(call=>call.body);
test('a launch uses a native Terminal ticket with normal theme and no attachment relay',async()=>{
 const f=fixture(),before=structuredClone(f.app.plugins.plugins.terminal.settings);f.queue(f.launch);await f.host.sync();
 assert.equal(f.leaves.length,1);const state=f.leaves[0].state.state['terminal:terminal'];assert.equal(state.profile.executable,f.launch.launch.executable);assert.deepEqual(state.profile.args,f.launch.launch.args);assert.equal(state.profile.useWin32Conhost,true);assert.equal(state.profile.restoreHistory,false);assert.equal(state.serial,null);assert.equal(state.profile.terminalOptions.fontSize,15);assert.doesNotMatch(JSON.stringify(state),/terminal-attach|screenrelay|Follow up/);
 assert.deepEqual(f.app.plugins.plugins.terminal.settings,before);assert.equal(events(f).find(event=>event.type==='launched').hostPid,789);assert.ok(f.revealed.includes(f.leaves[0]));
});
test('a launch whose terminal becomes ready late is an ordinary launch: launched, no error, no notice, follow-ups work',async()=>{
 const f=fixture(),bind=f.options.bind;let release;
 f.options.bind=(view,callbacks)=>{const made=bind(view,{...callbacks,ready(){}});made.ready=new Promise(resolve=>{release=()=>{callbacks.ready({hostPid:789});resolve()}});return made};
 f.queue(f.launch);const syncing=f.host.sync();await new Promise(resolve=>setTimeout(resolve,40));
 assert.equal(events(f).some(event=>event.type==='launched'||event.type==='error'),false,'still waiting quietly');assert.deepEqual(f.notices,[]);
 release();await syncing;await f.host.sync();
 assert.equal(events(f).filter(event=>event.type==='launched').length,1);assert.equal(events(f).some(event=>event.type==='error'),false);assert.deepEqual(f.notices,[]);assert.ok(f.revealed.includes(f.leaves[0]));
 f.send();await f.host.sync();assert.ok(events(f).some(event=>event.type==='input-written'),'follow-ups reach the terminal');
});
test('queued sends write one bracketed paste and one Enter after server and local checks',async()=>{
 const f=fixture();f.queue(f.launch);await f.host.sync();f.send();await f.host.sync();assert.deepEqual(f.bindings[0].binding.writes,['\x1b[200~Follow up\nwith detail\x1b[201~','\r']);assert.ok(events(f).some(event=>event.type==='input-written'&&event.actionId===sendId));
 f.pending.push({id:sendId,taskId:task,instance,type:'send'});await f.host.sync();assert.equal(f.bindings[0].binding.writes.length,2);
});
test('human input during settling cancels Enter and preserves the pasted request',async()=>{
 const f=fixture();f.queue(f.launch);await f.host.sync();f.options.settle=async()=>{f.bindings[0].binding.hasDraft=true;f.bindings[0].callbacks.input({submitted:false,edited:true,hasDraft:true})};f.send();await f.host.sync();
 assert.equal(f.bindings[0].binding.writes.length,1);assert.ok(events(f).some(event=>event.type==='input-cancelled'));assert.equal(events(f).some(event=>event.type==='input-written'),false);
});
test('authoritative hook approval or lost submit-check stops Enter after a paste',async()=>{
 for(const failure of ['approval','offline']){const f=fixture();f.queue(f.launch);await f.host.sync();const request=f.options.request;let checks=0;f.options.request=async(path,body)=>path==='/native/submit-check'&&++checks===2?(failure==='approval'?{submit:false,reason:'Review approval'}:Promise.reject(new Error('offline'))):request(path,body);f.send();await f.host.sync();assert.equal(f.bindings[0].binding.writes.length,1);assert.ok(events(f).some(event=>event.type==='input-cancelled'))}
});
test('failed launch claim is never retried, and a lost input ACK retries only the ACK',async()=>{
 const f=fixture(),request=f.options.request;f.options.request=async(path,body)=>{if(path==='/native/claim'){f.calls.push({path,body});throw new Error('claim response lost')}return request(path,body)};f.queue(f.launch);await f.host.sync();f.queue(f.launch);await f.host.sync();assert.equal(f.leaves.length,0);assert.equal(f.calls.filter(call=>call.path==='/native/claim').length,1);
 const g=fixture();g.queue(g.launch);await g.host.sync();const request2=g.options.request;let lost=true;g.options.request=async(path,body)=>{if(path==='/native/event'&&body.type==='input-written'&&lost){lost=false;throw new Error('ack lost')}return request2(path,body)};g.send();await assert.rejects(g.host.sync(),/ack lost/);g.pending.push({id:sendId,taskId:task,instance,type:'send'});await g.host.sync();assert.equal(g.bindings[0].binding.writes.length,2);assert.ok(events(g).some(event=>event.type==='input-written'));
});
test('V2 reload retains live controllers and human drafts without reapplying Terminal launch state',async()=>{
 const f=fixture();f.queue(f.launch);await f.host.sync();f.bindings[0].binding.hasDraft=true;f.host.dispose();const reloaded=new NativeDirectHost(f.options);await reloaded.sync();assert.equal(await reloaded.open(task),f.leaves[0]);assert.equal(f.bindings.length,1);assert.equal(f.leaves[0].sets,1);assert.equal(f.bindings[0].binding.stops,0);assert.equal(f.bindings[0].binding.hasDraft,true);
});
test('unknown Terminal version fails before claiming actions or changing ordinary shell tabs',async()=>{
 const f=fixture();f.app.plugins.plugins.terminal.manifest.version='3.28.0';f.queue(f.launch);await assert.rejects(f.host.sync(),/has not been verified/);assert.equal(f.calls.length,0);assert.equal(f.leaves.length,0);
});
test('closed or mismatched native views can never receive a follow-up',async()=>{
 const f=fixture();f.queue(f.launch);await f.host.sync();f.leaves[0].view={};f.send();await f.host.sync();assert.equal(f.bindings[0].binding.writes.length,0);assert.ok(events(f).some(event=>event.type==='error'));
});
test('editing a native profile into an ordinary shell makes it ineligible for automatic input',async()=>{
 const f=fixture();f.queue(f.launch);await f.host.sync();const profile=f.leaves[0].state.state['terminal:terminal'].profile;profile.executable='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';profile.args=[];f.send();await f.host.sync();assert.equal(f.bindings[0].binding.writes.length,0);assert.ok(events(f).some(event=>event.type==='error'));
});
test('server rejection or human input during the first authorization check prevents the paste itself',async()=>{
 for(const cause of ['server','human']){const f=fixture();f.queue(f.launch);await f.host.sync();const request=f.options.request;f.options.request=async(path,body)=>{if(path==='/native/submit-check'){if(cause==='server')return {submit:false,reason:'The task already continued.'};f.bindings[0].callbacks.input({submitted:true,edited:false,hasDraft:false});return {submit:true}}return request(path,body)};f.send();await f.host.sync();assert.equal(f.bindings[0].binding.writes.length,0);assert.ok(events(f).some(event=>event.type==='input-cancelled'&&event.hasDraft===false))}
});
test('closing or stopping a native tab ends its own lifetime, while V2 reload preserves it',async()=>{
 for(const cause of ['close','stop','reload']){const f=fixture();f.queue(f.launch);await f.host.sync();assert.equal(Object.fromEntries(f.leaves[0].state.state['terminal:terminal'].profile.environment).AOS_V2_TERMINAL_LIFETIME,f.lifetimes[0].endpoint);if(cause==='close')f.leaves[0].detach();else if(cause==='stop'){f.queue({id:sendId,taskId:task,instance,type:'stop'});await f.host.sync()}else f.host.dispose();assert.equal(f.lifetimes[0].active,cause==='reload');assert.equal(f.bindings[0].binding.stops,0)}
});
test('layout guard covers only mounting and reveal, leaving process startup outside it',async()=>{
 const f=fixture();let depth=0,release,entered;const gate=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>entered=resolve),bind=f.options.bind;
 f.options.withLayout=async operation=>{depth++;try{return await operation()}finally{depth--}};
 f.options.bind=(view,callbacks)=>{assert.equal(depth,0);const binding=bind(view,callbacks);binding.ready=binding.ready.then(async()=>{entered();await gate});return binding};
 f.options.reveal=async leaf=>{assert.equal(depth,1);f.revealed.push(leaf)};f.queue(f.launch);const running=f.host.sync();await waiting;assert.equal(depth,0);release();await running;assert.equal(depth,0);assert.equal(f.revealed.length,1);
});
