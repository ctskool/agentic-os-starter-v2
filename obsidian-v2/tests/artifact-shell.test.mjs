import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {artifactHandoffInstructions,ARTIFACT_HANDOFF_INSTRUCTIONS} from '../runner/artifact-instructions.mjs';
import {NativeTerminalManager} from '../runner/native-terminals.mjs';

const gitBash=[process.env.CLAUDE_CODE_GIT_BASH_PATH,path.join(process.env.ProgramFiles||'C:/Program Files','Git','bin','bash.exe')].find(file=>file&&fs.existsSync(file));
const shellName=provider=>process.platform==='win32'&&provider!=='claude'?'PowerShell':'Bash';
test('artifact commands select the provider tool shell and preserve invalid-identity fallback',()=>{
 const options={node:"C:\\Program Files\\nodejs\\node.exe",helper:"C:\\Worker's folder\\helper.mjs",events:"C:\\Vault's folder\\outbox",taskId:crypto.randomUUID(),requestKey:crypto.randomUUID()};
 for(const platform of ['win32','darwin','linux'])for(const provider of ['codex','claude']){
  const instruction=artifactHandoffInstructions({...options,platform,provider}),powershell=platform==='win32'&&provider==='codex';
  assert.ok(instruction.includes(`command (${powershell?'PowerShell':'Bash'}):`));
  const command=instruction.split('\n')[2];
  if(powershell){assert.ok(command.startsWith("& 'C:\\Program Files"));assert.ok(command.includes("Worker''s folder"));}
  else {assert.ok(!command.startsWith('&'));assert.ok(command.includes(`Worker'"'"'s folder`));if(platform==='win32')assert.ok(command.startsWith("'C:/Program Files/nodejs/node.exe'"));}
 }
 assert.equal(artifactHandoffInstructions({...options,provider:'claude',taskId:'invalid'}),ARTIFACT_HANDOFF_INSTRUCTIONS);
 assert.match(artifactHandoffInstructions({...options,platform:'win32'}),/command \(PowerShell\)/);
});

for(const provider of ['codex','claude'])test(`${provider} generated command executes literal paths with spaces and apostrophes`,{skip:process.platform==='win32'&&provider==='claude'&&!gitBash?'Git Bash is not installed':false},t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),"aos shell's "));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const taskId=crypto.randomUUID(),requestKey=crypto.randomUUID(),vault=path.join(base,'vault with spaces'),helper=path.join(base,'runner','artifact-result.mjs'),runtime=path.join(base,'.runtime','terminals',taskId,'events'),outbox=path.join(vault,'system','v2','artifact-requests',taskId);
 for(const folder of [path.dirname(helper),runtime,outbox])fs.mkdirSync(folder,{recursive:true});
 fs.copyFileSync(fileURLToPath(new URL('../runner/artifact-result.mjs',import.meta.url)),helper);
 fs.writeFileSync(path.join(runtime,'active-request.meta'),JSON.stringify({taskId,requestKey,vault,events:runtime}));
 fs.writeFileSync(path.join(runtime,'..','session.json'),JSON.stringify({id:taskId,vault,provider,artifactRequestKey:requestKey}));
 fs.writeFileSync(path.join(outbox,'active-request.meta'),JSON.stringify({taskId,requestKey,vault,outbox}));
 const file=path.join(vault,"result's file.txt"),label="Result's $(literal) `text` & symbols";fs.writeFileSync(file,'Fixture result');
 const powershell=shellName(provider)==='PowerShell',literal=value=>powershell?value.replaceAll("'","''"):value.replaceAll("'",`'"'"'`);
 const instruction=artifactHandoffInstructions({node:process.execPath,helper,events:outbox,taskId,requestKey,provider});
 const command=instruction.split('\n')[2].replace('<actual local file>',literal(file)).replace('<short title>',literal(label));
 const shell=powershell?'powershell.exe':process.platform==='win32'?gitBash:'/bin/bash';
 const args=powershell?['-NoLogo','-NoProfile','-NonInteractive','-Command',command]:['--noprofile','--norc','-c',command];
 const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('AOS_'))delete env[key];
 const result=spawnSync(shell,args,{cwd:vault,env,encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,'pending');
 const receipts=fs.readdirSync(outbox).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(fs.readFileSync(path.join(outbox,name),'utf8')));
 assert.equal(receipts.length,1);assert.equal(receipts[0].path,file);assert.equal(receipts[0].label,label);assert.equal(receipts[0].taskId,taskId);assert.equal(receipts[0].requestKey,requestKey);assert.equal(receipts[0].open,true);
});

for(const provider of ['codex','claude'])test(`${provider} native launch and follow-up use that provider's artifact shell`,t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-shell-native-'));
 const manager=new NativeTerminalManager(root,{directory:path.join(root,'tasks'),resolveNativeCli:()=>({command:process.execPath,prefix:[]}),schedule:()=>({unref(){}}),cancelSchedule(){},defer:()=>({unref(){}}),cancelDeferred(){},deliveryWatch:()=>({poll:()=>false,close(){}})});
 t.after(()=>{manager.close();fs.rmSync(root,{recursive:true,force:true});});
 const task=manager.start({selection:{provider,model:provider==='codex'?'gpt-6-astra':'sonnet'},prompt:'Make a file',execution:'native'});
 const ticket=JSON.parse(fs.readFileSync(task.native.ticket,'utf8'));
 assert.ok(ticket.args.at(-1).includes(`command (${shellName(provider)}):`));
 const launch=task.native.actions.find(action=>action.type==='launch');manager.claimNative(launch.id);
 manager.accept(task.id,{type:'native-start',taskId:task.id,nativeInstance:task.native.instance,pid:700,ts:Date.now()});
 manager.nativeEvent({taskId:task.id,instance:task.native.instance,actionId:launch.id,type:'launched',hostPid:600});
 manager.accept(task.id,{type:provider==='codex'?'complete':'Stop',sessionId:crypto.randomUUID(),nativeInstance:task.native.instance,turnId:crypto.randomUUID(),text:'Saved.',ts:Date.now()});
 assert.equal(task.state,'ready');manager.send(task.id,'Show the file');
 const send=task.native.actions.find(action=>action.type==='send');assert.ok(send.text.includes(`command (${shellName(provider)}):`));assert.ok(send.text.includes(task.artifactRequestKey));
});
