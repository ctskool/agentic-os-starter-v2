import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {commandFor,executeCli,parseWorkerResult} from '../runner/adapters.mjs';
import {stopCliProcessTree} from '../runner/cli-process-tree.mjs';

const job=provider=>({id:crypto.randomUUID(),provider,model:provider==='codex'?'gpt-6-astra':'sonnet',skill:'vault-summary'});
test('a success summary cannot stand in for a missing report',()=>{
 assert.throws(()=>parseWorkerResult({status:'ok',summary:'Weekly report generated.',markdown:'  '}),/without the report/);
 assert.deepEqual(parseWorkerResult({status:'blocked',summary:'Calendar unavailable',markdown:''}),{status:'blocked',summary:'Calendar unavailable',text:'Calendar unavailable'});
});
function vault(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'headless-adapter-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200}));return root}

test('full workflow CLI uses authenticated user connectors; classifiers retain isolation',()=>{
 for(const provider of ['codex','claude']){
  const args=commandFor(os.tmpdir(),job(provider),{command:provider,prefix:[]}).args;
  for(const flag of ['--ignore-user-config','--strict-mcp-config','--setting-sources','--safe-mode'])assert.ok(!args.includes(flag),`${provider} inherits configuration: ${flag}`);
  assert.ok(args.some(value=>value.includes('agentic_vault')));
  assert.ok(args.includes(provider==='codex'?'exec':'--print'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
 }
});

test('Windows cancellation targets only the owned CLI tree and skips exited processes',()=>{
 let calls=0,kills=0;
 const child={pid:12345,exitCode:null,signalCode:null,kill:()=>kills++};
 const launch=(command,args,options)=>{calls++;assert.match(command,/taskkill\.exe$/);assert.deepEqual(args,['/PID','12345','/T','/F']);assert.equal(options.windowsHide,true);assert.equal(options.shell,false);return new EventEmitter()};
 stopCliProcessTree(child,{platform:'win32',launch});assert.equal(calls,1);assert.equal(kills,0);
 child.exitCode=0;stopCliProcessTree(child,{platform:'win32',launch});assert.equal(calls,1);
 child.exitCode=null;child.signalCode='SIGTERM';stopCliProcessTree(child,{platform:'win32',launch});assert.equal(calls,1);
});

test('POSIX cancellation kills the dedicated group, falling back only for a live owned child',()=>{
 const groups=[],child={pid:456,exitCode:null,signalCode:null,kill:signal=>groups.push(signal)};
 stopCliProcessTree(child,{platform:'darwin',killGroup:(id,signal)=>groups.push([id,signal])});assert.deepEqual(groups,[[-456,'SIGKILL']]);
 stopCliProcessTree(child,{platform:'darwin',killGroup:()=>{throw Error('gone')}});assert.equal(groups.at(-1),'SIGKILL');
});

for(const provider of ['claude','codex'])test(`${provider} headless adapter delivers stdin and parses complete result without a terminal`,async t=>{
 const root=vault(t),request=job(provider),final=path.join(root,'result.json');let launchOptions;
 const payload={status:'ok',summary:'Summary complete',markdown:'# Report\n\nThe complete fixture report.'};
 const script=`let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{if(input!=='Run the fixture skill.'){process.exit(2);return;}const payload=${JSON.stringify(payload)};${provider==='codex'?`require('fs').writeFileSync(${JSON.stringify(final)},JSON.stringify(payload));`:`console.log(JSON.stringify({structured_output:payload}));`}});`;
 const result=await executeCli(root,request,'Run the fixture skill.',{resolveCommand:()=>({command:process.execPath,args:['-e',script],final}),launch:(command,args,options)=>{launchOptions=options;return spawn(command,args,options)}});
 assert.equal(result.text,payload.markdown);assert.equal(result.status,'ok');
 assert.deepEqual(launchOptions.stdio,['pipe','pipe','pipe']);assert.equal(launchOptions.windowsHide,true);assert.equal(launchOptions.shell,false);
});

test('cancelling a headless worker stops its real child process as well',async t=>{
 const root=vault(t),controller=new AbortController();let descendant,owned;
 let ready;const started=new Promise(resolve=>{ready=resolve});
 const script="const {spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000);";
 const result=executeCli(root,job('claude'),'Fixture',{signal:controller.signal,resolveCommand:()=>({command:process.execPath,args:['-e',script]}),launch:(command,args,options)=>{owned=spawn(command,args,options);owned.stdout.once('data',b=>{descendant=Number(String(b).trim());ready()});return owned}});
 // Attach rejection handling before sending cancellation.
 const checked=assert.rejects(result,/Workflow cancelled/);
 await started;assert.ok(descendant>0);controller.abort();await checked;
 let alive=true;for(let attempt=0;attempt<20;attempt++){try{process.kill(descendant,0)}catch{alive=false;break}await new Promise(resolve=>setTimeout(resolve,50))}
 assert.equal(alive,false,'no descendant survives a cancelled fixture');assert.notEqual(owned.exitCode===null&&owned.signalCode===null,true);
});

test('already cancelled work never spawns a CLI',async t=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(executeCli(vault(t),job('codex'),'Fixture',{signal:controller.signal,launch:()=>assert.fail('spawned')}),/cancelled/);
});
