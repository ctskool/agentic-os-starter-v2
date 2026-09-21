import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

const hook=fileURLToPath(new URL('../runner/terminal-hook.mjs',import.meta.url));
const event=(sessionId,text='Answer')=>({type:'agent-turn-complete','thread-id':sessionId,'turn-id':crypto.randomUUID(),'input-messages':['Initial request'],'last-assistant-message':text});
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aos-notify-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir}
const environment=dir=>({...process.env,AOS_WORK_EVENTS:dir,AOS_WORK_SESSION:'',AOS_WORK_PROMPT:'Initial request'});

test('concurrent first notifications publish only the exclusively claimed session',async t=>{
 const dir=fixture(t),preload=path.join(dir,'collision.mjs');
 // Hold both real helper processes immediately before their identity write.
 // This deterministically exercises the old check-then-write race.
 fs.writeFileSync(preload,`import fs from 'node:fs';import path from 'node:path';
 const write=fs.writeFileSync;
 fs.writeFileSync=(file,...args)=>{
  if(path.basename(String(file))==='main-session.txt'){
   write(path.join(process.env.AOS_WORK_EVENTS,'ready-'+process.pid),'ready');
   const until=Date.now()+5000;
   while(fs.readdirSync(process.env.AOS_WORK_EVENTS).filter(name=>name.startsWith('ready-')).length<2){
    if(Date.now()>until)throw new Error('Collision fixture timed out');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
   }
  }
  return write(file,...args);
 };`);
 const ids=[crypto.randomUUID(),crypto.randomUUID()];
 const run=sessionId=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--import',pathToFileURL(preload).href,hook,JSON.stringify(event(sessionId))],{env:environment(dir),windowsHide:true,stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const timeout=setTimeout(()=>{child.kill();reject(new Error('Notify process timed out'))},10000);
  child.once('error',error=>{clearTimeout(timeout);reject(error)});
  child.once('close',code=>{clearTimeout(timeout);if(code!==0)reject(new Error(stderr||`Notify exited ${code}`));else resolve()});
 });
 await Promise.all(ids.map(run));
 assert.equal(fs.readdirSync(dir).filter(name=>name.startsWith('ready-')).length,2);
 const winner=fs.readFileSync(path.join(dir,'main-session.txt'),'utf8');assert.ok(ids.includes(winner));
 const readEvents=()=>fs.readdirSync(dir).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8')));
 assert.equal(readEvents().length,1);assert.equal(readEvents()[0].sessionId,winner);
 const loser=ids.find(id=>id!==winner);
 const invoke=data=>{const result=spawnSync(process.execPath,[hook,JSON.stringify(data)],{env:environment(dir),windowsHide:true,encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr)};
 invoke(event(loser,'Unrelated completion'));
 invoke(event(winner,'{"title":"Legitimate JSON answer"}'));
 assert.equal(fs.readFileSync(path.join(dir,'main-session.txt'),'utf8'),winner);
 assert.equal(readEvents().length,2);assert.ok(readEvents().every(item=>item.sessionId===winner));
 assert.ok(readEvents().some(item=>item.text==='{"title":"Legitimate JSON answer"}'));
});

test('nested and unrelated title notifications cannot claim a fresh session',t=>{
 const dir=fixture(t),nested={...event(crypto.randomUUID()),agent_id:'nested'};
 const title={...event(crypto.randomUUID(),'{"title":"Internal title"}'),'input-messages':['Generate a title for the session']};
 for(const data of [nested,title]){
  const result=spawnSync(process.execPath,[hook,JSON.stringify(data)],{env:environment(dir),windowsHide:true,encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);
 }
 assert.deepEqual(fs.readdirSync(dir),[]);
});

test('Claude Stop replay keeps one completion identity per submitted request',t=>{
 const dir=fixture(t),requestKey=crypto.randomUUID(),taskId=crypto.randomUUID(),sessionId=crypto.randomUUID();
 fs.writeFileSync(path.join(dir,'active-request.meta'),JSON.stringify({taskId,requestKey}));
 const data={hook_event_name:'Stop',session_id:sessionId,last_assistant_message:'The image is ready.'};
 for(let index=0;index<2;index++){
  const result=spawnSync(process.execPath,[hook,JSON.stringify(data)],{env:environment(dir),encoding:'utf8',timeout:5000,windowsHide:true});assert.equal(result.status,0,result.stderr);
 }
 const events=fs.readdirSync(dir).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8')));
 assert.equal(events.length,2);assert.ok(events.every(event=>event.turnId===`claude-${requestKey}`));
});

test('Claude prompt receipts carry the actual prompt and current request identity',t=>{
 const dir=fixture(t),requestKey=crypto.randomUUID(),prompt='Edit the image.\nKeep its labels.';
 fs.writeFileSync(path.join(dir,'active-request.meta'),JSON.stringify({requestKey}));
 const result=spawnSync(process.execPath,[hook,JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:crypto.randomUUID(),prompt})],{env:environment(dir),encoding:'utf8',timeout:5000,windowsHide:true});
 assert.equal(result.status,0,result.stderr);
 const event=JSON.parse(fs.readFileSync(path.join(dir,fs.readdirSync(dir).find(name=>name.endsWith('.json'))),'utf8'));
 assert.equal(event.prompt,prompt);assert.equal(event.requestKey,requestKey);assert.equal(event.type,'UserPromptSubmit');
});

test('native Claude keeps an exact prepared key once and establishes fresh manual keys before work',t=>{
 const dir=fixture(t),taskId=crypto.randomUUID(),nativeInstance=crypto.randomUUID(),requestKey=crypto.randomUUID(),vault=path.join(dir,'vault'),outbox=path.join(vault,'system','v2','artifact-requests',taskId),prompt='Edit the image.\nKeep labels.';
 fs.mkdirSync(outbox,{recursive:true});const expectedPromptHash=crypto.createHash('sha256').update(prompt).digest('hex');
 fs.writeFileSync(path.join(dir,'active-request.meta'),JSON.stringify({taskId,requestKey,vault,events:dir,expectedPromptHash,nativeInstance}));
 fs.writeFileSync(path.join(outbox,'active-request.meta'),JSON.stringify({taskId,requestKey,vault,outbox,expectedPromptHash,nativeInstance}));
 const env={...environment(dir),AOS_NATIVE_INSTANCE:nativeInstance,AOS_NATIVE_TASK_ID:taskId,AOS_ARTIFACT_OUTBOX:outbox};
 const outputs=[];
 const invoke=value=>{const result=spawnSync(process.execPath,[hook,JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:taskId,prompt:value})],{env,encoding:'utf8',timeout:5000,windowsHide:true});assert.equal(result.status,0,result.stderr);outputs.push(result.stdout);return JSON.parse(fs.readFileSync(path.join(dir,'active-request.meta'),'utf8'))};
 const first=invoke(prompt.replaceAll('\n','\r\n'));assert.equal(first.requestKey,requestKey);assert.equal(first.accepted,true);
 const second=invoke(prompt);assert.notEqual(second.requestKey,first.requestKey);
 const third=invoke('Different manual task');assert.notEqual(third.requestKey,second.requestKey);
 assert.equal(JSON.parse(fs.readFileSync(path.join(outbox,'active-request.meta'),'utf8')).requestKey,third.requestKey);
 const events=fs.readdirSync(dir).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8')));
 assert.equal(events.length,3);assert.ok(events.every(event=>event.nativeInstance===nativeInstance&&event.type==='UserPromptSubmit'));assert.deepEqual(new Set(events.map(event=>event.requestKey)),new Set([first.requestKey,second.requestKey,third.requestKey]));
 assert.equal(Object.hasOwn(third,'prompt'),false);
 assert.equal(outputs[0],'','Prepared prompts already contain the current handoff instructions');
 for(const [output,meta] of [[outputs[1],second],[outputs[2],third]]){
  const response=JSON.parse(output),specific=response.hookSpecificOutput;
  assert.equal(specific.hookEventName,'UserPromptSubmit');assert.ok(specific.additionalContext.includes(meta.requestKey));assert.ok(!specific.additionalContext.includes(requestKey));
  assert.ok(specific.additionalContext.includes(outbox));assert.match(specific.additionalContext,/Do not claim that a file is opened/);
  assert.ok(fs.existsSync(path.join(dir,meta.nativePromptReceipt+'.json')));
 }
});

test('native Claude refuses mismatched outbox metadata instead of writing to an unrelated directory',t=>{
 const dir=fixture(t),taskId=crypto.randomUUID(),nativeInstance=crypto.randomUUID(),requestKey=crypto.randomUUID(),vault=path.join(dir,'vault');fs.mkdirSync(vault);
 fs.writeFileSync(path.join(dir,'active-request.meta'),JSON.stringify({taskId,requestKey,vault,events:dir,nativeInstance}));
 const result=spawnSync(process.execPath,[hook,JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:crypto.randomUUID(),prompt:'New task'})],{env:{...environment(dir),AOS_NATIVE_INSTANCE:nativeInstance,AOS_NATIVE_TASK_ID:taskId,AOS_ARTIFACT_OUTBOX:dir},encoding:'utf8',timeout:5000,windowsHide:true});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'active-request.meta'),'utf8')).requestKey,requestKey);assert.equal(fs.readdirSync(dir).filter(name=>name.endsWith('.json')).length,0);
});

test('Claude Stop uses actual assistant UUIDs so identical manual answers remain distinct and replay stays stable',t=>{
 const dir=fixture(t),config=path.join(dir,'claude'),projects=path.join(config,'projects','fixture'),sessionId=crypto.randomUUID(),first=crypto.randomUUID(),second=crypto.randomUUID(),old=crypto.randomUUID(),nativeInstance=crypto.randomUUID();
 fs.mkdirSync(projects,{recursive:true});const transcript=path.join(projects,sessionId+'.jsonl');
 const row=(uuid,text)=>JSON.stringify({type:'assistant',sessionId,uuid,message:{content:[{type:'text',text}]}})+'\n';
 fs.writeFileSync(transcript,row(old,'Earlier answer')+row(first,'Done.'));
 const env={...environment(dir),CLAUDE_CONFIG_DIR:config,AOS_NATIVE_INSTANCE:nativeInstance};
 const invoke=text=>{const before=new Set(fs.readdirSync(dir));const result=spawnSync(process.execPath,[hook,JSON.stringify({hook_event_name:'Stop',session_id:sessionId,transcript_path:transcript,last_assistant_message:text})],{env,encoding:'utf8',timeout:5000,windowsHide:true});assert.equal(result.status,0,result.stderr);const file=fs.readdirSync(dir).find(name=>name.endsWith('.json')&&!before.has(name));return JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'))};
 assert.equal(invoke('Done.').turnId,`claude-${first}`);assert.equal(invoke('Done.').turnId,`claude-${first}`);
 fs.appendFileSync(transcript,row(second,'Done.'));const next=invoke('Done.');assert.equal(next.turnId,`claude-${second}`);assert.equal(next.nativeInstance,nativeInstance);
 assert.equal(invoke('Earlier answer').turnId,`claude-${old}`);
});

test('native Claude rejects foreign sessions and replaced native instances before rotating metadata',t=>{
 const dir=fixture(t),taskId=crypto.randomUUID(),nativeInstance=crypto.randomUUID(),requestKey=crypto.randomUUID(),sessionId=crypto.randomUUID(),vault=path.join(dir,'vault'),outbox=path.join(vault,'system','v2','artifact-requests',taskId),events=path.join(dir,'events');
 fs.mkdirSync(outbox,{recursive:true});fs.mkdirSync(events);
 const active={taskId,requestKey,vault,events,nativeInstance};
 fs.writeFileSync(path.join(events,'active-request.meta'),JSON.stringify(active));fs.writeFileSync(path.join(outbox,'active-request.meta'),JSON.stringify({...active,outbox}));
 fs.writeFileSync(path.join(dir,'session.json'),JSON.stringify({id:taskId,sessionId,execution:'native',provider:'claude',native:{instance:crypto.randomUUID()},vault}));
 const env={...environment(events),AOS_NATIVE_INSTANCE:nativeInstance,AOS_NATIVE_TASK_ID:taskId,AOS_WORK_SESSION:sessionId,AOS_ARTIFACT_OUTBOX:outbox};
 for(const submittedSession of [crypto.randomUUID(),sessionId]){
  const result=spawnSync(process.execPath,[hook,JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:submittedSession,prompt:'Edit the result'})],{env,encoding:'utf8',timeout:5000,windowsHide:true});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.deepEqual(JSON.parse(fs.readFileSync(path.join(events,'active-request.meta'),'utf8')),active);assert.equal(fs.readdirSync(events).filter(name=>name.endsWith('.json')).length,0);
 }
});

test('typed native Claude hook refreshes an executable helper command without loading speech or transcript dependencies',t=>{
 const base=fixture(t),taskId=crypto.randomUUID(),instance=crypto.randomUUID(),oldKey=crypto.randomUUID(),vault=path.join(base,'vault'),events=path.join(base,'.runtime','terminals',taskId,'events'),outbox=path.join(vault,'system','v2','artifact-requests',taskId),runner=path.join(base,'runner');
 for(const dir of [events,outbox,runner])fs.mkdirSync(dir,{recursive:true});
 for(const name of ['terminal-hook.mjs','artifact-result.mjs','artifact-instructions.mjs'])fs.copyFileSync(fileURLToPath(new URL('../runner/'+name,import.meta.url)),path.join(runner,name));
 const active={taskId,requestKey:oldKey,vault,events,nativeInstance:instance,accepted:true};
 fs.writeFileSync(path.join(events,'active-request.meta'),JSON.stringify(active));fs.writeFileSync(path.join(outbox,'active-request.meta'),JSON.stringify({...active,outbox}));
 const record={id:taskId,sessionId:taskId,execution:'native',provider:'claude',native:{instance},vault,artifactRequestKey:oldKey};
 const recordFile=path.join(events,'..','session.json');fs.writeFileSync(recordFile,JSON.stringify(record));
 const env={...environment(events),AOS_NATIVE_INSTANCE:instance,AOS_NATIVE_TASK_ID:taskId,AOS_ARTIFACT_OUTBOX:outbox};
 const prompt='Change the background and show the revised file.';
 const receipt=spawnSync(process.execPath,[path.join(runner,'terminal-hook.mjs'),JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:taskId,prompt})],{env,encoding:'utf8',timeout:5000,windowsHide:true});
 assert.equal(receipt.status,0,receipt.stderr);const context=JSON.parse(receipt.stdout).hookSpecificOutput.additionalContext;
 const accepted=JSON.parse(fs.readFileSync(path.join(events,'active-request.meta'),'utf8'));assert.notEqual(accepted.requestKey,oldKey);assert.ok(context.includes(accepted.requestKey));assert.ok(!context.includes(oldKey));
 // Model context receives the new command before any tools run. Simulate the
 // bridge adopting the receipt, then execute that exact command's placeholders.
 record.artifactRequestKey=accepted.requestKey;fs.writeFileSync(recordFile,JSON.stringify(record));
 const file=path.join(vault,'revised.txt');fs.writeFileSync(file,'Revised result');
 const command=context.split('\n')[2].replace('<actual local file>',file).replace('<short title>','Revised result');
 assert.match(context,/command \(Bash\)/);
 const gitBash=[process.env.CLAUDE_CODE_GIT_BASH_PATH,path.join(process.env.ProgramFiles||'C:/Program Files','Git','bin','bash.exe')].find(file=>file&&fs.existsSync(file));
 if(process.platform==='win32'&&!gitBash){t.skip('Git Bash is not installed');return;}
 const shell=process.platform==='win32'?gitBash:'/bin/sh',args=['-c',command];
 const cleanEnv={...process.env};for(const name of Object.keys(cleanEnv))if(name.startsWith('AOS_'))delete cleanEnv[name];
 const result=spawnSync(shell,args,{env:cleanEnv,cwd:vault,encoding:'utf8',windowsHide:true,timeout:5000});assert.equal(result.status,0,result.stderr);
 const artifacts=fs.readdirSync(outbox).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(fs.readFileSync(path.join(outbox,name),'utf8')));
 assert.equal(artifacts.length,1);assert.equal(artifacts[0].requestKey,accepted.requestKey);assert.equal(artifacts[0].path,file);assert.equal(artifacts[0].open,true);
});
