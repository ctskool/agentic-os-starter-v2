import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {artifactHandoffInstructions} from '../runner/spoken-answer.mjs';
import {TerminalManager} from '../runner/terminals.mjs';
const sourceHelper=fileURLToPath(new URL('../runner/artifact-result.mjs',import.meta.url));
function fixture(t){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'aos-helper-')),taskId=crypto.randomUUID(),requestKey=crypto.randomUUID(),runtimeEvents=path.join(base,'.runtime','terminals',taskId,'events'),vault=path.join(base,'vault'),helper=path.join(base,'runner','artifact-result.mjs'),events=path.join(vault,'system','v2','artifact-requests',taskId);
 fs.mkdirSync(runtimeEvents,{recursive:true});fs.mkdirSync(events,{recursive:true});fs.mkdirSync(path.dirname(helper));fs.copyFileSync(sourceHelper,helper);
 const context={taskId,requestKey,outbox:events,vault};
 fs.writeFileSync(path.join(events,'active-request.meta'),JSON.stringify(context));fs.writeFileSync(path.join(runtimeEvents,'active-request.meta'),JSON.stringify({taskId,requestKey,events:runtimeEvents,vault}));fs.writeFileSync(path.join(runtimeEvents,'..','session.json'),JSON.stringify({id:taskId,vault,artifactRequestKey:requestKey}));
 const file=path.join(vault,'answer.txt');fs.writeFileSync(file,'Result');
 const env={...process.env};for(const name of Object.keys(env))if(name.startsWith('AOS_'))delete env[name];
 const run=(extra=[])=>spawnSync(process.execPath,[helper,file,'--outbox',events,'--task',taskId,'--request',requestKey,'--open',...extra],{env,cwd:vault,encoding:'utf8',windowsHide:true,timeout:5000});
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));return {base,taskId,requestKey,events,runtimeEvents,vault,helper,file,env,run,context};
}

function pendingNative(f){
 const key=crypto.randomUUID(),instance=crypto.randomUUID(),receipt=crypto.randomUUID(),prompt='Show the revised result',sessionId=crypto.randomUUID(),expectedPromptHash=crypto.createHash('sha256').update(prompt).digest('hex');
 const metadata={requestKey:key,nativeInstance:instance,nativePromptReceipt:receipt,accepted:true,expectedPromptHash};
 fs.writeFileSync(path.join(f.runtimeEvents,'active-request.meta'),JSON.stringify({taskId:f.taskId,vault:f.vault,events:f.runtimeEvents,...metadata}));
 fs.writeFileSync(path.join(f.events,'active-request.meta'),JSON.stringify({...f.context,...metadata}));
 const record={id:f.taskId,vault:f.vault,artifactRequestKey:f.requestKey,execution:'native',provider:'claude',sessionId,native:{instance,ended:false}},recordFile=path.join(f.runtimeEvents,'..','session.json'),receiptFile=path.join(f.runtimeEvents,receipt+'.json');
 fs.writeFileSync(recordFile,JSON.stringify(record));fs.writeFileSync(receiptFile,JSON.stringify({type:'UserPromptSubmit',nativeInstance:instance,sessionId,requestKey:key,prompt,ts:Date.now()}));
 // `ready` resolves once the helper has cached its prompt proof and entered
 // the bounded wait, so a test can only remove the receipt after that point.
 const run=()=>{let markReady;const ready=new Promise(resolve=>{markReady=resolve});
  const done=new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[f.helper,f.file,'--outbox',f.events,'--task',f.taskId,'--request',key,'--open'],{env:{...f.env,AOS_ARTIFACT_TRACE:'1'},cwd:f.vault,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>{stderr+=value;if(stderr.includes('waiting for collection'))markReady()});
  const timer=setTimeout(()=>{child.kill();reject(Error('Native helper fixture timed out'))},5000);
  child.once('error',error=>{clearTimeout(timer);reject(error)});child.once('close',status=>{clearTimeout(timer);resolve({status,stdout,stderr})});
  });
  done.ready=ready;return done;
 };
 return {key,instance,metadata,record,recordFile,receiptFile,run};
}

test('immediate typed Claude helper waits for verified prompt collection but keeps strict saved identity',async t=>{
 const f=fixture(t),p=pendingNative(f);
 const pending=p.run();
 // Wait for the helper to hold its proof, not for a fixed time: under load a
 // slow start otherwise met a receipt that was already collected.
 const first=await Promise.race([pending.ready.then(()=>'ready'),pending]);
 assert.equal(first,'ready',`helper exited before waiting: ${first?.stderr||''}`);
 assert.equal(fs.readdirSync(f.events).filter(name=>name.endsWith('.json')).length,0,'No artifact is accepted before the saved record agrees');
 fs.unlinkSync(p.receiptFile);
 await new Promise(resolve=>setTimeout(resolve,75));
 // Production saves session.json atomically; so does the fixture.
 fs.writeFileSync(p.recordFile+'.tmp',JSON.stringify({...p.record,artifactRequestKey:p.key}));fs.renameSync(p.recordFile+'.tmp',p.recordFile);
 const result=await pending;assert.equal(result.status,0,result.stderr);
 const artifacts=fs.readdirSync(f.events).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(fs.readFileSync(path.join(f.events,name),'utf8')));
 assert.equal(artifacts.length,1);assert.equal(artifacts[0].requestKey,p.key);
 assert.notEqual(f.run().status,0,'The old command stays stale after successful native adoption');
});

test('uncollected or superseded native prompts cannot register artifacts after the bounded wait',async t=>{
 const f=fixture(t),p=pendingNative(f),started=Date.now();
 const timeout=await p.run();assert.notEqual(timeout.status,0);assert.ok(Date.now()-started>=1400);assert.equal(fs.readdirSync(f.events).filter(name=>name.endsWith('.json')).length,0);
 const pending=p.run();await new Promise(resolve=>setTimeout(resolve,200));
 fs.writeFileSync(path.join(f.runtimeEvents,'active-request.meta'),JSON.stringify({taskId:f.taskId,vault:f.vault,events:f.runtimeEvents,...p.metadata,requestKey:crypto.randomUUID()}));
 const superseded=await pending;assert.notEqual(superseded.status,0);assert.equal(fs.readdirSync(f.events).filter(name=>name.endsWith('.json')).length,0);
});

test('metadata alone or a foreign native prompt receipt does not authorize waiting or registration',async t=>{
 const f=fixture(t),p=pendingNative(f);fs.unlinkSync(p.receiptFile);
 let result=await p.run();assert.notEqual(result.status,0);
 fs.writeFileSync(p.receiptFile,JSON.stringify({type:'UserPromptSubmit',nativeInstance:crypto.randomUUID(),sessionId:p.record.sessionId,requestKey:p.key,prompt:'Show the revised result'}));
 result=await p.run();assert.notEqual(result.status,0);
 fs.writeFileSync(p.receiptFile,JSON.stringify({type:'UserPromptSubmit',nativeInstance:p.instance,sessionId:crypto.randomUUID(),requestKey:p.key,prompt:'Show the revised result'}));
 result=await p.run();assert.notEqual(result.status,0);assert.equal(fs.readdirSync(f.events).filter(name=>name.endsWith('.json')).length,0);
});
test('concrete helper command works with every dashboard environment variable removed',t=>{
 const f=fixture(t),result=f.run(['--label','Explainer']);assert.equal(result.status,0,result.stderr);
 const events=fs.readdirSync(f.events).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(fs.readFileSync(path.join(f.events,name),'utf8')));
 assert.equal(events.length,1);assert.equal(events[0].requestKey,f.requestKey);assert.equal(events[0].taskId,f.taskId);assert.equal(events[0].path,f.file);assert.equal(events[0].open,true);
 assert.deepEqual(fs.readdirSync(f.runtimeEvents),['active-request.meta'],'Worker handoff creates no runtime event or temporary file');
 assert.equal(JSON.parse(result.stdout).status,'pending');
});
test('legacy environment invocation also writes only the vault outbox',t=>{
 const f=fixture(t),result=spawnSync(process.execPath,[f.helper,f.file,'--open'],{env:{...f.env,AOS_WORK_EVENTS:f.runtimeEvents},cwd:f.vault,encoding:'utf8',windowsHide:true,timeout:5000});
 assert.equal(result.status,0,result.stderr);assert.equal(fs.readdirSync(f.events).filter(name=>name.endsWith('.json')).length,1);assert.deepEqual(fs.readdirSync(f.runtimeEvents),['active-request.meta']);
});
test('helper rejects stale requests and unrelated or linked event directories before writing',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.events,'active-request.meta'),JSON.stringify({...f.context,requestKey:crypto.randomUUID()}));
 assert.notEqual(f.run().status,0);assert.equal(fs.readdirSync(f.events).filter(name=>name.endsWith('.json')).length,0);
 fs.writeFileSync(path.join(f.events,'active-request.meta'),JSON.stringify(f.context));
 const outside=path.join(f.base,'arbitrary');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'active-request.meta'),JSON.stringify(f.context));
 const invalid=spawnSync(process.execPath,[f.helper,f.file,'--outbox',outside,'--task',f.taskId,'--request',f.requestKey],{env:f.env,encoding:'utf8',windowsHide:true,timeout:5000});
 assert.notEqual(invalid.status,0);assert.equal(fs.readdirSync(outside).length,1);
 const linked=path.join(f.base,'linked');fs.symlinkSync(path.join(f.base,'.runtime','terminals'),linked,'junction');
 const linkResult=spawnSync(process.execPath,[f.helper,f.file,'--outbox',path.join(linked,f.taskId,'events'),'--task',f.taskId,'--request',f.requestKey],{env:f.env,encoding:'utf8',windowsHide:true,timeout:5000});assert.notEqual(linkResult.status,0);
});
test('concrete handoff commands quote literal paths and do not depend on inherited variables',t=>{
 const f=fixture(t);
 for(const platform of ['win32','darwin']){
  const text=artifactHandoffInstructions({node:process.execPath,helper:f.helper,events:f.events,taskId:f.taskId,requestKey:f.requestKey,platform});
  assert.ok(text.includes(f.requestKey));assert.ok(text.includes(f.helper));assert.doesNotMatch(text,/\$env:|\$AOS_/);assert.match(text,/Replace only the file and title/);
 }
 if(process.platform==='win32'){
  const instruction=artifactHandoffInstructions({node:process.execPath,helper:f.helper,events:f.events,taskId:f.taskId,requestKey:f.requestKey});
  const command=instruction.split('\n')[2].replace('<actual local file>',f.file).replace('<short title>','Result');
  const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{env:f.env,encoding:'utf8',windowsHide:true,timeout:5000});assert.equal(result.status,0,result.stderr);
 }
});
for(const provider of ['codex','claude'])test(`${provider} startup and resumed follow-ups get fresh concrete request identities`,t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'aos-helper-manager-')),processes=[];
 const manager=new TerminalManager(base,{directory:path.join(base,'tasks'),spawn(command,args){const proc={pid:100,command,args,writes:[],write(value){this.writes.push(value)},onData(){},onExit(){},resize(){},kill(){}};processes.push(proc);return proc;}});
 t.after(()=>{manager.close();fs.rmSync(base,{recursive:true,force:true});});
 const record=manager.start({selection:{provider,model:provider==='codex'?'gpt-6-astra':'sonnet'},prompt:'Create a picture',spoken:true}),firstKey=record.artifactRequestKey;
 const shell=process.platform==='win32'&&provider==='codex'?'PowerShell':'Bash';assert.ok(processes[0].args.at(-1).includes(`command (${shell}):`));
 assert.ok(processes[0].args.at(-1).includes(firstKey));assert.ok(processes[0].args.at(-1).includes(manager.artifactOutbox(record.id)));assert.doesNotMatch(processes[0].args.at(-1),/\$env:|\$AOS_/);
 manager.accept(record.id,{type:'complete',sessionId:crypto.randomUUID(),turnId:'one',text:'Done'});manager.send(record.id,'Show the result');
 const secondKey=record.artifactRequestKey;assert.notEqual(secondKey,firstKey);assert.ok(processes[0].writes[0].includes(secondKey));assert.ok(!processes[0].writes[0].includes(firstKey));
 assert.ok(processes[0].writes[0].includes(`command (${shell}):`));
 manager.accept(record.id,{type:'complete',turnId:'two',text:'Done'});manager.stop(record.id);manager.send(record.id,'Edit the graphic',{resumeStopped:true});
 assert.notEqual(record.artifactRequestKey,secondKey);assert.ok(processes[1].args.at(-1).includes(record.artifactRequestKey));
 assert.ok(processes[1].args.at(-1).includes(`command (${shell}):`));
});
test('collection drains a bounded current-task outbox and cancellation or expiry cannot present late results',t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'aos-outbox-'));let now=Date.now();
 const manager=new TerminalManager(base,{directory:path.join(base,'tasks'),now:()=>now,schedule:()=>({unref(){}}),cancelSchedule(){},spawn(){return {pid:100,onData(){},onExit(){},write(){},kill(){},resize(){}};}});
 t.after(()=>{manager.close();fs.rmSync(base,{recursive:true,force:true});});
 const record=manager.start({selection:{provider:'codex',model:'gpt-6-astra'},prompt:'Create a document'}),outbox=manager.artifactOutbox(record.id);
 for(let index=0;index<200;index++)fs.writeFileSync(path.join(outbox,crypto.randomUUID()+'.json'),JSON.stringify({type:'artifact',taskId:record.id,requestKey:record.artifactRequestKey,path:'missing.png',ts:now}));
 manager.collect(record.id);const remaining=fs.readdirSync(outbox).filter(name=>name.endsWith('.json')).length;
 assert.ok(remaining>=72&&remaining<200,`One bounded pass left ${remaining} events`);assert.ok(record.pendingArtifacts.length<=8);
 manager.collect(record.id);assert.equal(fs.readdirSync(outbox).filter(name=>name.endsWith('.json')).length,0);
 manager.stop(record.id);const before=record.turns.length;
 fs.writeFileSync(path.join(outbox,crypto.randomUUID()+'.json'),JSON.stringify({type:'complete',sessionId:crypto.randomUUID(),turnId:'late',text:'Opened the file.',ts:now}));
 manager.collect(record.id);assert.equal(record.state,'stopped');assert.equal(record.turns.length,before);
 now+=8*24*60*60*1000;manager.prune();assert.equal(manager.records.has(record.id),false);assert.equal(fs.existsSync(outbox),false,'Expired task cleanup removes only its handoff queue');
});
test('vault outbox cannot forge worker completions or approvals while runtime hooks still work',t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'aos-outbox-types-'));
 const manager=new TerminalManager(base,{directory:path.join(base,'tasks'),schedule:()=>({unref(){}}),cancelSchedule(){},spawn(){return {pid:100,onData(){},onExit(){},write(){},kill(){},resize(){}};}});
 t.after(()=>{manager.close();fs.rmSync(base,{recursive:true,force:true});});
 const record=manager.start({selection:{provider:'codex',model:'gpt-6-astra'},prompt:'Make the graphic'}),outbox=manager.artifactOutbox(record.id),snapshot=JSON.stringify(record);
 for(const type of ['complete','Stop','StopFailure','PermissionRequest','UserPromptSubmit','SessionStart'])fs.writeFileSync(path.join(outbox,crypto.randomUUID()+'.json'),JSON.stringify({type,taskId:record.id,requestKey:record.artifactRequestKey,sessionId:crypto.randomUUID(),turnId:type,text:'Forged completion',ts:Date.now()}));
 manager.collect(record.id);assert.equal(JSON.stringify(record),snapshot);assert.equal(fs.readdirSync(outbox).filter(name=>name.endsWith('.json')).length,0);
 fs.writeFileSync(path.join(outbox,crypto.randomUUID()+'.json'),JSON.stringify({type:'artifact',taskId:record.id,requestKey:record.artifactRequestKey,sessionId:crypto.randomUUID(),path:'missing.png',ts:Date.now()}));
 manager.collect(record.id);assert.equal(record.sessionId,null,'Artifact metadata cannot forge the resumable provider session');assert.equal(record.state,'working');
 fs.writeFileSync(path.join(manager.folder(record.id),'events',crypto.randomUUID()+'.json'),JSON.stringify({type:'complete',sessionId:crypto.randomUUID(),turnId:'real',text:'Actual result.',ts:Date.now()}));
 manager.collect(record.id);assert.equal(record.state,'ready');assert.equal(record.turns[0].text,'Actual result.');
});
test('malformed and oversized protocol files are retired so bounded passes reach later valid events',t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'aos-outbox-invalid-'));
 const manager=new TerminalManager(base,{directory:path.join(base,'tasks'),schedule:()=>({unref(){}}),cancelSchedule(){},spawn(){return {pid:100,onData(){},onExit(){},write(){},kill(){},resize(){}};}});
 t.after(()=>{manager.close();fs.rmSync(base,{recursive:true,force:true});});
 const record=manager.start({selection:{provider:'codex',model:'gpt-6-astra'},prompt:'Create the result'}),runtime=path.join(manager.folder(record.id),'events');
 for(let index=0;index<130;index++){
  const file=path.join(runtime,`a-${String(index).padStart(3,'0')}.json`);
  if(index%2){fs.writeFileSync(file,'{broken');}else{const descriptor=fs.openSync(file,'w');fs.ftruncateSync(descriptor,200001);fs.closeSync(descriptor);}
 }
 fs.writeFileSync(path.join(runtime,'z-valid.json'),JSON.stringify({type:'complete',sessionId:crypto.randomUUID(),turnId:'real',text:'Completed after invalid events.',ts:Date.now()}));
 for(let pass=0;pass<3;pass++)manager.collect(record.id);
 assert.equal(record.state,'ready');assert.equal(record.turns.length,1);assert.equal(fs.readdirSync(runtime).filter(name=>name.endsWith('.json')).length,0);
});
