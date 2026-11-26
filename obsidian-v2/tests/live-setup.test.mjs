import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {CONSENT_VERSION,liveAuthorization,liveKeyFile,readLiveKey} from '../runner/live/key.mjs';
import {collectOpenAIKey,openAIKeyOutcome} from '../scripts/aos/openai-key.mjs';
import {classifierEnv} from '../runner/adapters.mjs';
import {runCommand,workerEnv} from '../runner/workflows.mjs';
import {TerminalManager} from '../runner/terminals.mjs';
import {runNativeLaunch} from '../runner/native-launch.mjs';
import {liveHistory,liveSnapshot,SNAPSHOT_MAX_BYTES} from '../runner/live/snapshot.mjs';
import {localDate} from '../runner/brief-voice.mjs';
import {readVoicePrefs,saveVoicePrefs} from '../runner/voice-prefs.mjs';

const key=['sk','test','live_fixture_key_123456789'].join('-');
function temp(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'live-setup-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
function write(root,relative,data){
 const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);return file;
}
test('OpenAI setup requires consent and saves once without echoing the key',async t=>{
 const root=temp(t),dir=path.join(root,'private'),ready=()=>liveAuthorization(dir).ready;
 let url;
 const opened=new Promise(resolve=>{url=resolve});
 const checked=[];
 const saved=collectOpenAIKey({runtimeDir:dir,open:url,timeoutMs:3000,check:async value=>{checked.push(value);return {kind:'accepted'}}});const address=await opened;
 assert.equal(ready(),false);
 const get=await fetch(address),page=await get.text();
 assert.equal(get.status,200);assert.match(page,/microphone audio.*vault snapshot.*About me.*task titles.*inbox counts.*report excerpts.*store: false/);
 assert.match(page,/Need a key\?.*platform\.openai\.com.*separate from ChatGPT.*Add credit under Billing.*ChatGPT Pro or Business.*api-keys/s);
 const submit=async(consent,origin=new URL(address).origin,value=key)=>fetch(address,{method:'POST',headers:{Origin:origin},body:new URLSearchParams({key:value,consent})});
 assert.equal((await submit('no')).status,400);
 assert.equal((await submit('yes','null')).status,403);
 assert.equal((await submit('yes',undefined,'invalid')).status,400);assert.equal(ready(),false);
 // Nothing typed wrong is ever sent to OpenAI, and an OpenRouter key is named for what it is.
 const router=await submit('yes',undefined,['sk','or','v1','0123456789abcdef0123456789'].join('-'));
 assert.equal(router.status,400);assert.match(await router.text(),/OpenRouter key, which is for Jev/);assert.deepEqual(checked,[]);
 const result=await submit('yes'),done=await result.text();assert.equal(result.status,200);assert.equal(done.includes(key),false);
 assert.match(done,/OpenAI accepted the key.*choose <strong>Live<\/strong>.*credit on the OpenAI API account/s);assert.deepEqual(checked,[key]);
 assert.deepEqual(await saved,{saved:true,check:'accepted'});assert.equal(ready(),true);assert.equal(readLiveKey(dir)===key,true);
 if(process.platform!=='win32')assert.equal(fs.statSync(liveKeyFile(dir)).mode&0o777,0o600);
 for(const fields of [{consentVersion:CONSENT_VERSION+1},{consentAt:'not-a-date'},{consentAt:'2099-01-01'},{key:'invalid'}]){
  fs.writeFileSync(liveKeyFile(dir),JSON.stringify({key,consentAt:new Date().toISOString(),consentVersion:CONSENT_VERSION,...fields}));
  assert.equal(ready(),false);
 }
 fs.writeFileSync(liveKeyFile(dir),'broken');assert.equal(ready(),false);
});

test('a key OpenAI refuses is never saved and the page stays open; one it cannot confirm is saved with the reason',async t=>{
 const root=temp(t),dir=path.join(root,'private'),ready=()=>liveAuthorization(dir).ready;
 const answers=['refused','no-model'];
 let url;const opened=new Promise(resolve=>{url=resolve});
 const saved=collectOpenAIKey({runtimeDir:dir,open:url,timeoutMs:3000,check:async()=>({kind:answers.shift()})});const address=await opened;
 const submit=()=>fetch(address,{method:'POST',headers:{Origin:new URL(address).origin},body:new URLSearchParams({key,consent:'yes'})});
 const refused=await submit(),again=await refused.text();
 assert.equal(refused.status,400);assert.match(again,/OpenAI did not accept that key/);assert.match(again,/<form method="post"/);assert.equal(again.includes(key),false);
 assert.equal(ready(),false);assert.equal(fs.existsSync(liveKeyFile(dir)),false);
 const warned=await submit(),page=await warned.text();
 assert.equal(warned.status,200);assert.match(page,/Saved, with a warning.*did not show it the Live model \(gpt-live-1\.1\)/s);
 assert.deepEqual(await saved,{saved:true,check:'no-model'});assert.equal(ready(),true);
 assert.match(openAIKeyOutcome({saved:true,check:'no-model'}),/^Saved, but OpenAI did not show this key the Live model/);
 assert.match(openAIKeyOutcome({saved:true,check:'accepted'}),/^Saved\. OpenAI accepted the key\./);
 assert.match(openAIKeyOutcome({saved:true,check:'unconfirmed'}),/could not be reached.*first call is the test/);
 assert.match(openAIKeyOutcome({saved:false,reason:'timeout'}),/^No key was saved/);
});

test('a check that throws or answers nonsense still saves the key, marked unconfirmed',async t=>{
 const root=temp(t),dir=path.join(root,'private');
 let url;const opened=new Promise(resolve=>{url=resolve});
 const saved=collectOpenAIKey({runtimeDir:dir,open:url,timeoutMs:3000,check:async()=>{throw new Error('offline')}});const address=await opened;
 const response=await fetch(address,{method:'POST',headers:{Origin:new URL(address).origin},body:new URLSearchParams({key,consent:'yes'})});
 assert.equal(response.status,200);assert.match(await response.text(),/could not be checked with OpenAI just now/);
 assert.deepEqual(await saved,{saved:true,check:'unconfirmed'});assert.equal(liveAuthorization(dir).ready,true);
});

test('Live voice preferences validate independently from key authorization and preserve Local fields',t=>{
 const root=temp(t);
 const defaults={voiceMode:'local',liveVoice:'marin',liveConfirm:'auto',liveIdleMic:'open',liveIdleHangupMin:30,liveStandbySec:60,liveCarryToday:false,liveShareWork:true,liveShareBrief:false,liveGreeting:true,liveTaskUpdates:'done'};
 assert.deepEqual(readVoicePrefs(root),{spokenReplies:true,voice:null,rate:1,...defaults});
 saveVoicePrefs(root,{liveConfirm:'voice'});assert.equal(readVoicePrefs(root).liveConfirm,'voice');
 const values={voiceMode:'live',liveVoice:'cedar',liveConfirm:'destructive',liveIdleMic:'muted',liveIdleHangupMin:15,liveStandbySec:20,liveCarryToday:true,liveShareWork:false,liveShareBrief:true,liveGreeting:false,liveTaskUpdates:'chatty'};
 assert.deepEqual(saveVoicePrefs(root,values),{spokenReplies:true,voice:null,rate:1,...values});
 for(const [name,value]of Object.entries({voiceMode:'off',liveVoice:'unknown',liveConfirm:'always',liveIdleMic:true,liveIdleHangupMin:0,liveStandbySec:180,liveCarryToday:1,liveShareWork:'false',liveShareBrief:'yes',liveGreeting:'yes',liveTaskUpdates:'loud'}))assert.throws(()=>saveVoicePrefs(root,{[name]:value}),/Invalid/);
 assert.deepEqual(readVoicePrefs(root),{spokenReplies:true,voice:null,rate:1,...values});
 assert.equal(liveAuthorization(path.join(root,'private')).ready,false);
});

test('classifier, worker, workflow, PTY and native launcher children do not receive the OpenAI key',async t=>{
 const root=temp(t),fake={...process.env,OpenAI_Api_Key:key};
 const probe=`const bad=Object.entries(process.env).some(([name,value])=>name.toUpperCase()==='OPENAI_API_KEY'||value===${JSON.stringify(key)});process.exitCode=bad?1:0`;
 const spawnProbe=env=>assert.equal(spawnSync(process.execPath,['-e',probe],{env,stdio:'ignore',windowsHide:true}).status,0);
 for(const provider of ['claude','codex'])spawnProbe(classifierEnv({provider,restricted:true},fake));
 const worker=workerEnv(root,{home:root});
 spawnProbe(classifierEnv({provider:'codex',skill:'morning-intel'},{...fake,...worker}));
 const previous=process.env.OPENAI_API_KEY;
 process.env.OPENAI_API_KEY=key;
 try{
  assert.equal(liveAuthorization(path.join(root,'no-consent')).ready,false);
  await runCommand(process.execPath,['-e',probe],{cwd:root,env:{...worker,OpenAI_Api_Key:key}});
  const manager=new TerminalManager(root,{directory:path.join(root,'terminals'),resolveCli:()=>({command:process.execPath,prefix:[]}),
   spawn:(_cmd,_args,{env})=>{spawnProbe(env);return {pid:1,onData(){},onExit(){},kill(){}}}});
  try{manager.start({selection:{provider:'claude',model:'sonnet'},prompt:'Fixture'})}finally{manager.close()}
  const events=path.join(root,'native-events');fs.mkdirSync(events);
  const taskId='00000000-0000-4000-8000-000000000001';
  const ticket=write(root,'native-ticket.json',JSON.stringify({version:1,taskId,instance:taskId,cwd:root,command:process.execPath,args:['-e',probe],events,env:{OPENAI_API_KEY:key}}));
  assert.equal(await runNativeLaunch(ticket,{env:fake}),0);
 }finally{if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous}
});

test('the Live snapshot keeps dated sections and excludes private inbox text, runs, queue, and Local receipts',async t=>{
 const root=temp(t),now=new Date(),date=localDate(now);
 write(root,`daily-notes/${date}.md`,'## Top 3 Priorities\n1. [ ] Record a demo\n## Schedule\n- 9:00 — Work block');
 write(root,'system/metrics/metrics.csv',`timestamp,source,metric,value,status\n${date},youtube,subscribers,100,ok`);
 write(root,`inbox/research/morning-intel/${date}-intel.md`,'## Top Story\nPublic headline\n\nREPORT_BODY_SENTINEL\n\n## X Highlights\n- Public X highlight\n\n## Inbox\n- INBOX_SENTINEL');
 write(root,`inbox/research/github-trending/${date}.md`,'### 1. [owner/repo](https://example.invalid)\n- **Description:** A public repository summary');
 write(root,`inbox/research/outlier-radar/${date}.md`,'- **[Demo video](x)** — **8x** | [Channel](y)');
 write(root,'system/v2/runs/fixture.json','{"summary":"RUN_SENTINEL"}');write(root,'system/v2/queue/fixture.json','{"title":"QUEUE_SENTINEL"}');
 const text=await liveSnapshot(root,{now,usage:{claude:async options=>{assert.equal(options.cachedOnly,true);return {checkedAt:now.toISOString(),windows:[{windowDurationMins:300,usedPercent:42}]}},codex:async()=>({windows:[]})}});
 for(const label of ['Today','Numbers','News','Radar','Record a demo','Work block','Public headline','Public X highlight','owner/repo','A public repository summary','Demo video','42%',date])assert.equal(text.includes(label),true,label);
 assert.ok(Buffer.byteLength(text)<=SNAPSHOT_MAX_BYTES);assert.doesNotMatch(text,/INBOX_SENTINEL|RUN_SENTINEL|QUEUE_SENTINEL|REPORT_BODY_SENTINEL/);
 const receipt={appScope:'web',ts:+now,origin:'live',reply:'Fixture'};
 for(const [id,transport]of [['00000000-0000-4000-8000-000000000001','local'],['00000000-0000-4000-8000-000000000002','live']])
  write(root,`system/v2/voice-results/${id}.json`,JSON.stringify({...receipt,transport,transcript:transport+' history'}));
 assert.match(liveHistory(root,'web',now),/live history/);assert.doesNotMatch(liveHistory(root,'web',now),/local history/);
});
