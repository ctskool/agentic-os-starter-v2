import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const built=await build({entryPoints:['src/lib/native-terminal.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {NativeTerminalTabs,attachmentViewState,checkedTerminalRuntime,terminalConversation,NATIVE_TERMINAL_VIEW}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const codex='22c1da8b-a7b4-4fa5-b3b2-4fa560a7cf02',claude='22c1da8b-a7b4-4fa5-b3b2-4fa560a7cf03';
// UUID strings are fixture data only. Nothing in this suite connects to a bridge.
const config={version:1,nodeExecutable:'C:\\Program Files\\nodejs\\node.exe',attachmentScript:'C:\\fixture project\\runner\\terminal-attach.mjs',runtimeDir:'C:\\fixture project\\.runtime',vault:'C:\\fixture vault'};
function fixture(){
 const leaves=[],created=[],notices=[],reads=[],controllers=[],revealed=[],commands=[];
 const snapshot={vault:config.vault,attachmentProtocol:1,tasks:[{id:codex,provider:'codex',title:'Codex fixture',state:'needs input',pid:123},{id:claude,provider:'claude',title:'Claude fixture',state:'ready',pid:124}]};
 const base={type:'integrated',executable:'powershell',args:[],platforms:{win32:true},pythonExecutable:'python',useWin32Conhost:true,terminalOptions:{fontSize:15},restoreHistory:true};
 const settings={defaultProfile:'shell',profiles:{shell:base}},app={plugins:{plugins:{terminal:{manifest:{version:'3.27.1'},settings:{value:settings}}}},vault:{adapter:{getBasePath:()=>config.vault,async read(file){reads.push(file);return JSON.stringify(config)}}},workspace:{getLeavesOfType:type=>leaves.filter(leaf=>leaf.state.type===type),async revealLeaf(leaf){revealed.push(leaf)}},commands:{executeCommandById(id){commands.push(id);return true}}};
 const view=()=>({cleanup:[],register(fn){this.cleanup.push(fn)},unload(){for(const fn of this.cleanup.splice(0))fn()}});
 const create=()=>{const leaf={state:{type:'empty'},view:view(),sets:0,detached:false,getViewState(){return this.state},async setViewState(value){this.view.unload();this.view=view();this.sets++;this.state=structuredClone(value)},detach(){this.view.unload();this.detached=true;leaves.splice(leaves.indexOf(this),1)}};leaves.push(leaf);created.push(leaf);return leaf};
 let snapshots=0;const options={pluginDir:'.obsidian/plugins/agentic-os-v2',readSnapshot:async()=>{snapshots++;return structuredClone(snapshot)},notice:value=>notices.push(value),createLifetime:async()=>{const controller={endpoint:'\\\\.\\pipe\\aos-v2-terminal-fixture-'+controllers.length,active:true,close(){this.active=false}};controllers.push(controller);return controller}};
 const adapter=new NativeTerminalTabs(app,options);
 return {adapter,app,snapshot,settings,base,leaves,created,notices,reads,create,controllers,options,revealed,commands,snapshots:()=>snapshots};
}
function plainShell(f,change={}){const leaf=f.create();leaf.state={type:NATIVE_TERMINAL_VIEW,state:{[NATIVE_TERMINAL_VIEW]:{cwd:config.vault,profileSourceId:'shell',profile:structuredClone(f.base),...change}}};leaf.unsentText='Get-ChildItem -LiteralPath ';return leaf}
test('generic opening reuses the existing PowerShell with its unfinished input and does not read bridge or launch configuration',async()=>{
 const f=fixture(),leaf=plainShell(f),before=structuredClone(leaf.state),settings=structuredClone(f.settings);f.options.readSnapshot=()=>assert.fail('Shell navigation must not contact the bridge');f.app.vault.adapter.read=()=>assert.fail('Shell navigation must not read attachment runtime');
 await f.adapter.openShell();assert.deepEqual(f.revealed,[leaf]);assert.equal(leaf.sets,0);assert.equal(leaf.unsentText,'Get-ChildItem -LiteralPath ');assert.deepEqual(leaf.state,before);assert.deepEqual(f.settings,settings);assert.deepEqual(f.commands,[]);assert.deepEqual(f.controllers,[]);assert.equal(f.snapshots(),0);
});
test('without an existing shell, opening uses the Terminal plugin own default-profile root command',async()=>{
 const f=fixture(),settings=structuredClone(f.settings);await f.adapter.openShell();assert.deepEqual(f.commands,['terminal:open-terminal.default.root']);assert.equal(f.created.length,0);assert.deepEqual(f.reads,[]);assert.equal(f.snapshots(),0);assert.deepEqual(f.controllers,[]);assert.deepEqual(f.settings,settings);
});
test('explicit New terminal uses the native command even when a matching shell already exists',async()=>{
 const f=fixture(),leaf=plainShell(f),before=structuredClone(leaf.state);await f.adapter.openShell(true);assert.deepEqual(f.commands,['terminal:open-terminal.default.root']);assert.deepEqual(f.revealed,[]);assert.equal(leaf.sets,0);assert.deepEqual(leaf.state,before);assert.equal(leaf.unsentText,'Get-ChildItem -LiteralPath ');
});
test('generic opening does not hijack an agent attachment or a shell from another vault',async()=>{
 const f=fixture(),attached=f.create();attached.state=attachmentViewState(config,f.snapshot.tasks[0],f.base);plainShell(f,{cwd:'C:\\another vault'});await f.adapter.openShell();assert.deepEqual(f.commands,['terminal:open-terminal.default.root']);assert.deepEqual(f.revealed,[]);assert.equal(attached.sets,0);assert.equal(f.snapshots(),0);
});
test('a different shell executable, arguments or environment is not mistaken for the default PowerShell',async()=>{
 for(const profile of [{executable:'cmd.exe'},{args:['-NoExit','Start-Something']},{environment:[['CUSTOM_SESSION','1']]}]){
  const f=fixture(),leaf=plainShell(f,{profile:{...f.base,...profile}});await f.adapter.openShell();assert.deepEqual(f.commands,['terminal:open-terminal.default.root']);assert.deepEqual(f.revealed,[]);assert.equal(leaf.sets,0);
 }
});
test('missing Terminal plugin, local vault or integrated default profile gives a notice without fallback UI',async()=>{
 for(const disable of [f=>{delete f.app.plugins.plugins.terminal},f=>{delete f.app.vault.adapter.getBasePath},f=>{f.base.type='external'},f=>{f.settings.defaultProfile='missing'}]){
  const f=fixture();disable(f);await f.adapter.openShell();assert.equal(f.notices.length,1);assert.doesNotMatch(f.notices[0],/opening the built-in/i);assert.equal(f.created.length,0);assert.deepEqual(f.commands,[]);assert.deepEqual(f.reads,[]);assert.equal(f.snapshots(),0);
 }
});
test('unavailable or failing native shell command reports the issue and never makes a custom terminal',async()=>{
 for(const command of [undefined,()=>false,()=>{throw new Error('Fixture command failed')}]){
  const f=fixture();f.app.commands.executeCommandById=command;await f.adapter.openShell();assert.equal(f.notices.length,1);assert.equal(f.created.length,0);assert.equal(f.snapshots(),0);assert.doesNotMatch(f.notices[0],/opening the built-in/i);
 }
});
test('pinned Terminal state launches only the attachment client with intact spaced paths and no secret',async()=>{
 const f=fixture(),before=structuredClone(f.settings),leaf=await f.adapter.open(codex,f.create);
 assert.equal(leaf.state.type,'terminal:terminal');assert.deepEqual(Object.keys(leaf.state.state),['terminal:terminal']);
 const state=leaf.state.state[NATIVE_TERMINAL_VIEW];assert.equal(state.cwd,config.vault);assert.equal(state.focus,false);assert.equal(state.serial,null);assert.equal(state.profileSourceId,null);
 assert.deepEqual(state.profile.args,[config.attachmentScript,'--runtime',config.runtimeDir,'--task',codex]);assert.equal(state.profile.executable,config.nodeExecutable);
 assert.equal(Object.fromEntries(state.profile.environment).AOS_V2_TERMINAL_LIFETIME,f.controllers[0].endpoint);
 assert.equal(state.profile.restoreHistory,false);assert.equal(state.profile.useWin32Conhost,true);assert.deepEqual(state.profile.terminalOptions,{fontSize:15});
 assert.deepEqual(terminalConversation(leaf),{id:codex,provider:'codex'});assert.doesNotMatch(JSON.stringify(state),/token|secret|--resume|--dangerous/);
 assert.deepEqual(f.settings,before);assert.deepEqual(f.reads,['.obsidian/plugins/agentic-os-v2/terminal-runtime.json']);assert.equal(f.snapshots(),1);
});
test('opening the same live task reuses the normal tab without reapplying state or replacing typed content',async()=>{
 const f=fixture(),first=await f.adapter.open(codex,f.create);first.unsentText='Keep this unfinished thought';
 const next=await f.adapter.open(codex,f.create);assert.equal(next,first);assert.equal(first.sets,1);assert.equal(first.unsentText,'Keep this unfinished thought');assert.equal(f.created.length,1);
});
test('our Windows attachment always uses the verified TTY backend while leaving the user profile intact',async()=>{
 const f=fixture();f.base.useWin32Conhost=false;const leaf=await f.adapter.open(codex,f.create);
 assert.equal(leaf.state.state[NATIVE_TERMINAL_VIEW].profile.useWin32Conhost,true);assert.equal(f.base.useWin32Conhost,false);
});
test('different provider conversations create independent tabs and closing only detaches their frontend',async()=>{
 const f=fixture(),before=structuredClone(f.snapshot),one=await f.adapter.open(codex,f.create),two=await f.adapter.open(claude,f.create);
 assert.notEqual(one,two);assert.equal(terminalConversation(two).provider,'claude');one.detach();assert.deepEqual(f.snapshot,before);
 assert.equal(f.controllers[0].active,false);assert.equal(f.controllers[1].active,true);
 const reopened=await f.adapter.open(codex,f.create);assert.notEqual(reopened,one);assert.equal(f.created.length,3);assert.deepEqual(f.snapshot,before);
});
test('null never attaches; scripts, stopped or missing tasks report notices without resuming or creating any view',async()=>{
 const f=fixture();assert.equal(await f.adapter.open(null,f.create),null);assert.equal(f.snapshots(),0);
 f.snapshot.tasks[0].execution='script';assert.equal(await f.adapter.open(codex,f.create),null);
 delete f.snapshot.tasks[0].execution;f.snapshot.tasks[0].state='stopped';f.snapshot.tasks[0].pid=null;assert.equal(await f.adapter.open(codex,f.create),null);
 f.snapshot.tasks=[];assert.equal(await f.adapter.open(codex,f.create),null);assert.equal(f.created.length,0);assert.equal(f.notices.length,3);assert.deepEqual(f.commands,[]);assert.deepEqual(f.controllers,[]);
});
test('disabled or unverified Terminal reports a notice without reading configuration, connecting to bridge or creating fallback UI',async()=>{
 const f=fixture();delete f.app.plugins.plugins.terminal;assert.equal(await f.adapter.open(codex,f.create),null);assert.deepEqual(f.reads,[]);
 f.app.plugins.plugins.terminal={manifest:{version:'4.0.0'}};await f.adapter.open(codex,f.create);await f.adapter.open(codex,f.create);
 assert.equal(f.notices.length,2);assert.match(f.notices[1],/not been verified/);assert.equal(f.snapshots(),0);assert.equal(f.created.length,0);assert.doesNotMatch(f.notices.join('\n'),/opening the built-in/i);
});
test('a verified Terminal attaches silently; a newer untested one attaches with a single notice; older and pre-release ones are refused',async()=>{
 const verified=fixture();verified.app.plugins.plugins.terminal.manifest.version='3.27.2';assert.ok(await verified.adapter.open(codex,verified.create));assert.deepEqual(verified.notices,[]);
 const newer=fixture();newer.app.plugins.plugins.terminal.manifest.version='3.28.0';assert.ok(await newer.adapter.open(codex,newer.create));assert.ok(await newer.adapter.open(claude,newer.create));
 assert.equal(newer.notices.length,1);assert.match(newer.notices[0],/Terminal 3\.28\.0 is newer than the versions tested/);assert.equal(newer.created.length,2);
 for(const [version,reason] of [['3.26.0',/too old/],['3.28.0-beta.1',/Pre-release/],['',/need the Terminal community plugin/]]){
  const f=fixture();f.app.plugins.plugins.terminal.manifest.version=version;assert.equal(await f.adapter.open(codex,f.create),null);assert.match(f.notices[0],reason);assert.equal(f.created.length,0);assert.equal(f.snapshots(),0);
 }
});
test('configuration and bridge must both name the actual vault before any attachment can start',async()=>{
 const f=fixture();f.app.vault.adapter.read=async()=>JSON.stringify({...config,vault:'C:\\another vault'});assert.equal(await f.adapter.open(codex,f.create),null);assert.equal(f.snapshots(),0);
 f.app.vault.adapter.read=async()=>JSON.stringify(config);f.snapshot.vault='C:\\another vault';assert.equal(await f.adapter.open(codex,f.create),null);assert.equal(f.created.length,0);assert.match(f.notices.at(-1),/different vault/);
});
test('an older bridge preserves an existing legacy pane and reports incompatibility without creating new fallback UI',async()=>{
 const f=fixture(),old=f.create(),prior={type:'aos-v2-work',state:{taskId:codex,title:'Existing conversation'}};old.state=structuredClone(prior);delete f.snapshot.attachmentProtocol;
 assert.equal(await f.adapter.open(codex,()=>assert.fail('Old bridge must not create an attachment'),old),null);
 assert.deepEqual(old.state,prior);assert.equal(old.sets,0);assert.equal(old.detached,false);assert.match(f.notices[0],/bridge needs.*attachment update/);
 f.snapshot.attachmentProtocol=2;assert.equal(await f.adapter.open(codex,f.create),null);assert.equal(f.created.length,1);
});
test('invalid runtime paths and task metadata fail closed; shell profiles are never mistaken for attachments',()=>{
 for(const change of [{nodeExecutable:'node'},{nodeExecutable:'C:\\Windows\\cmd.exe'},{runtimeDir:'C:\\another\\.runtime'},{attachmentScript:'C:\\fixture project\\runner\\other.mjs'},{nodeExecutable:'C:\\node.exe\n--eval'}])assert.throws(()=>checkedTerminalRuntime({...config,...change},config.vault));
 assert.deepEqual(checkedTerminalRuntime(config,config.vault.toUpperCase()),config);
 const state=attachmentViewState(config,{id:codex,provider:'codex',title:'fixture',state:'ready'}),leaf={getViewState:()=>state};
 state.state[NATIVE_TERMINAL_VIEW].profile.environment[1][1]='unknown';assert.equal(terminalConversation(leaf),null);
 state.state[NATIVE_TERMINAL_VIEW].profile.args=['powershell'];assert.equal(terminalConversation(leaf),null);
 assert.throws(()=>attachmentViewState(config,{id:'../../unsafe',provider:'codex',state:'ready'}));
});
test('attachment creation failure cleans up only its new empty leaf and permits a later native opening',async()=>{
 const f=fixture(),create=()=>{const leaf=f.create();leaf.setViewState=async()=>{throw new Error('view unavailable')};return leaf};
 assert.equal(await f.adapter.open(codex,create),null);assert.equal(f.created[0].detached,true);assert.equal(f.leaves.length,0);assert.match(f.notices[0],/view unavailable/);
 assert.ok(await f.adapter.open(claude,f.create));
});
test('restored serialized tabs receive a fresh lifetime socket in the same leaf on explicit open',async()=>{
 const f=fixture(),restored=f.create();await restored.setViewState(attachmentViewState(config,f.snapshot.tasks[1]));
 assert.equal(await f.adapter.open(claude,f.create),restored);assert.equal(restored.sets,2);assert.deepEqual(terminalConversation(restored),{id:claude,provider:'claude'});
 assert.equal(Object.fromEntries(restored.state.state[NATIVE_TERMINAL_VIEW].profile.environment).AOS_V2_TERMINAL_LIFETIME,f.controllers[0].endpoint);
});
test('a V2 adapter reload reuses the living Terminal view and socket without interrupting its attachment',async()=>{
 const f=fixture(),leaf=await f.adapter.open(codex,f.create),reloaded=new NativeTerminalTabs(f.app,f.options);
 assert.equal(await reloaded.open(codex,f.create),leaf);assert.equal(leaf.sets,1);assert.equal(f.controllers.length,1);assert.equal(f.controllers[0].active,true);
});
test('explicit migration replaces the matching custom leaf in place without stopping its bridge task',async()=>{
 const f=fixture(),old=f.create(),snapshot=structuredClone(f.snapshot);old.state={type:'aos-v2-work',state:{taskId:codex}};old.savedComposer='Retained by the draft store';
 const leaf=await f.adapter.open(codex,()=>assert.fail('Migration should reuse the custom leaf'),old);
 assert.equal(leaf,old);assert.equal(leaf.state.type,NATIVE_TERMINAL_VIEW);assert.equal(f.created.length,1);assert.equal(old.detached,false);assert.deepEqual(f.snapshot,snapshot);assert.equal(old.savedComposer,'Retained by the draft store');
});
test('a failed migration restores the old custom view and its saved state instead of detaching it',async()=>{
 const f=fixture(),old=f.create(),prior={type:'aos-v2-work',active:false,state:{taskId:codex,title:'Original task'}};old.state=structuredClone(prior);
 const set=old.setViewState.bind(old);old.setViewState=async state=>{if(state.type===NATIVE_TERMINAL_VIEW)throw new Error('Native view could not mount');await set(state)};
 assert.equal(await f.adapter.open(codex,()=>assert.fail('No extra leaf'),old),null);assert.deepEqual(old.state,prior);assert.equal(old.detached,false);assert.equal(f.leaves.length,1);assert.match(f.notices[0],/Native view could not mount/);
});
test('closing a leaf during asynchronous native opening cancels without registering a leaked controller',async()=>{
 const f=fixture(),create=()=>{const leaf=f.create(),set=leaf.setViewState.bind(leaf);leaf.setViewState=async state=>{await set(state);await new Promise(resolve=>setImmediate(resolve));leaf.detach()};return leaf};
 assert.equal(await f.adapter.open(codex,create),undefined);assert.equal(f.leaves.length,0);assert.equal(f.controllers[0].active,false);assert.equal(f.created[0].view.cleanup.length,0);assert.deepEqual(f.notices,[]);
});
