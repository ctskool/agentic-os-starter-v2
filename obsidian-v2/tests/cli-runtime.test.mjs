import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {resolveCli,assertCliRuntime,createCliRuntime} from '../runner/cli-runtime.mjs';
import {commandFor} from '../runner/adapters.mjs';
test('configured executable wins over PATH and missing pin never silently falls back',()=>{
 const pinned=path.resolve('pinned-codex.exe'),other=path.resolve('other-codex.exe');
 const exists=p=>[pinned,other].includes(p);
 assert.equal(resolveCli('codex',{env:{PATH:'elsewhere'},pins:{codex:{command:pinned}},exists}).command,pinned);
 assert.equal(resolveCli('codex',{env:{AOS_CODEX_BIN:other},pins:{codex:{command:pinned}},exists}).command,other);
 assert.throws(()=>resolveCli('codex',{env:{AOS_CODEX_BIN:path.resolve('missing')},pins:{codex:{command:pinned}},exists}),/configured path/);
 assert.throws(()=>resolveCli('codex',{env:{AOS_CODEX_BIN:'relative.exe'},exists:()=>true}),/configured path/);
});

test('Luna classifier context restrictions do not remove worker tool access',()=>{
 const root=process.cwd(),cli={command:'test-codex',prefix:[]},base={id:'00000000-0000-4000-8000-000000000000',provider:'codex',model:'gpt-5.6-luna'};
 const quick=commandFor(root,base,cli).args;
 assert.ok(quick.includes('skills.max_context_tokens=1'));
 assert.ok(quick.includes('features.shell_tool=false'));
 assert.ok(quick.includes('project_doc_max_bytes=0'));
 assert.ok(quick.includes('web_search="disabled"'));
 assert.ok(quick.includes('model_reasoning_effort="medium"'));
 assert.ok(!quick.includes('model_reasoning_effort="max"'));
 assert.ok(!quick.includes('model_reasoning_effort="low"'));
 assert.ok(quick.some(a=>a.startsWith('model_instructions_file=')));
 const worker=commandFor(root,{...base,model:'gpt-6-astra',skill:'vault-summary'},cli).args;
 assert.ok(!worker.includes('features.shell_tool=false'));
 assert.ok(worker.includes('model_reasoning_effort="medium"'));
 assert.ok(!worker.some(a=>a.startsWith('model_instructions_file=')));
});

test('desktop Codex pins require a matching code-mode host, with no fallback to another bundle',()=>{
 const command=path.resolve('AppData/Local/OpenAI/Codex/bin/incomplete/codex.exe'),host=path.join(path.dirname(command),'codex-code-mode-host.exe');
 const otherHost=path.resolve('AppData/Local/OpenAI/Codex/bin/complete/codex-code-mode-host.exe');
 const files=new Set([command,otherHost]),exists=file=>files.has(file);
 assert.throws(()=>resolveCli('codex',{pins:{codex:{command}},env:{},exists}),/desktop runtime is incomplete.*code-mode-host/);
 assert.throws(()=>resolveCli('codex',{env:{AOS_CODEX_BIN:command},exists}),/No task was started/);
 files.add(host);const pinned=resolveCli('codex',{pins:{codex:{command}},env:{},exists});assert.equal(pinned.command,command);
 files.delete(host);assert.throws(()=>assertCliRuntime('codex',pinned,{exists}),/incomplete/,'cached executable is rechecked before a later launch');
});

test('ordinary CLI and npm installs do not inherit desktop-only companion requirements',()=>{
 for(const command of [path.resolve('npm/node_modules/@openai/codex/vendor/bin/codex.exe'),path.resolve('local/codex.exe')]){
  assert.equal(resolveCli('codex',{pins:{codex:{command}},env:{},exists:file=>file===command}).command,command);
 }
 const command=path.resolve('local/claude.exe');assert.equal(resolveCli('claude',{pins:{claude:{command}},env:{},exists:file=>file===command}).command,command);
});

function runtimeHarness(){
 const command=path.resolve('AppData/Local/OpenAI/Codex/bin/original/codex.exe'),host=path.join(path.dirname(command),'codex-code-mode-host.exe');
 const state={env:{},pins:{codex:{command}},files:new Map([[command,1],[host,1]]),calls:[],time:0,version:'codex 1',fail:false,pinError:false};
 const runtime=createCliRuntime({env:state.env,readPins:()=>{if(state.pinError)throw new Error('Invalid pin JSON');return state.pins},exists:file=>state.files.has(file),stat:file=>{if(!state.files.has(file))throw new Error('Missing runtime file');return {size:100,mtimeMs:state.files.get(file),ctimeMs:1,ino:1}},now:()=>state.time,run:(file,args,options)=>{state.calls.push({file,args,options});return {status:state.fail?1:0,stdout:state.version}}});
 return {state,runtime,command,host};
}

test('runtime status reuses a healthy version check but revalidates companion presence',()=>{
 const {state,runtime,host}=runtimeHarness();
 assert.equal(runtime.cliStatus('codex').installed,true);
 assert.equal(runtime.cliStatus('codex').installed,true);assert.equal(state.calls.length,1);
 state.files.delete(host);
 assert.throws(()=>runtime.findCli('codex'),/runtime is incomplete/);
 const missing=runtime.cliStatus('codex');assert.equal(missing.installed,false);assert.match(missing.detail,/code-mode-host/);assert.equal(state.calls.length,1);
 state.files.set(host,1);
 assert.equal(runtime.cliStatus('codex').installed,true);assert.equal(state.calls.length,2,'restoring the runtime clears the failed status without a restart');
});

test('changed pins take effect without falling back from a missing explicit path',()=>{
 const {state,runtime,command}=runtimeHarness();runtime.cliStatus('codex');
 const replacement=path.resolve('local/new-codex.exe');state.pins={codex:{command:replacement}};
 assert.throws(()=>runtime.findCli('codex'),/configured path/);
 assert.equal(runtime.cliStatus('codex').installed,false);assert.equal(state.calls.length,1,'the existing old bundle is not used');
 state.files.set(replacement,1);state.version='codex 2';
 assert.equal(runtime.findCli('codex').command,replacement);
 const healthy=runtime.cliStatus('codex');assert.equal(healthy.command,replacement);assert.equal(healthy.version,'codex 2');assert.notEqual(healthy.command,command);
});

test('environment override changes and removed executables invalidate healthy status',()=>{
 const {state,runtime,command}=runtimeHarness();runtime.cliStatus('codex');
 const replacement=path.resolve('local/environment-codex.exe');state.files.set(replacement,1);state.env.AOS_CODEX_BIN=replacement;
 const overridden=runtime.cliStatus('codex');assert.equal(overridden.command,replacement);assert.equal(overridden.source,'environment');
 state.files.delete(replacement);assert.equal(runtime.cliStatus('codex').installed,false);assert.throws(()=>runtime.findCli('codex'),/configured path/);
 delete state.env.AOS_CODEX_BIN;assert.equal(runtime.cliStatus('codex').command,command);
});

test('replaced executable or companion refreshes cached version metadata',()=>{
 const {state,runtime,command,host}=runtimeHarness();runtime.cliStatus('codex');
 state.files.set(command,2);state.version='codex 2';assert.equal(runtime.cliStatus('codex').version,'codex 2');
 state.files.set(host,2);runtime.cliStatus('codex');assert.equal(state.calls.length,3);
 assert.deepEqual(state.calls[0].args,['--version']);assert.equal(state.calls[0].options.shell,false);assert.equal(state.calls[0].options.windowsHide,true);
});

test('temporary malformed pins recover instead of caching a permanent resolution error',()=>{
 const {state,runtime}=runtimeHarness();state.pinError=true;
 assert.throws(()=>runtime.findCli('codex'),/Invalid pin JSON/);assert.equal(runtime.cliStatus('codex').installed,false);
 state.pinError=false;assert.ok(runtime.findCli('codex'));assert.equal(runtime.cliStatus('codex').installed,true);
});

test('transient version failures retry after a short backoff and config changes bypass it',()=>{
 const {state,runtime}=runtimeHarness();state.fail=true;
 assert.equal(runtime.cliStatus('codex').installed,false);state.fail=false;
 state.time=4999;assert.equal(runtime.cliStatus('codex').installed,false);assert.equal(state.calls.length,1);
 state.time=5000;assert.equal(runtime.cliStatus('codex').installed,true);assert.equal(state.calls.length,2);
 state.env.AOS_CODEX_BIN=path.resolve('local/replacement.exe');state.files.set(state.env.AOS_CODEX_BIN,1);state.fail=true;
 assert.equal(runtime.cliStatus('codex').installed,false);
 const next=path.resolve('local/next.exe');state.env.AOS_CODEX_BIN=next;state.files.set(next,1);state.fail=false;
 assert.equal(runtime.cliStatus('codex').installed,true);assert.equal(state.calls.length,4);
});
