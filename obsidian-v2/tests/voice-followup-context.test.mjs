import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {routeVoice} from '../runner/bridge-core.mjs';
import {invalidateVoiceSnapshot} from '../runner/voice-router.mjs';
import {localDate} from '../runner/brief-voice.mjs';
import {writeJson} from '../runner/core.mjs';
import {setCurrent} from '../runner/current-conversations.mjs';

function fixture(t,provider){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-followup-context-'));
 t.after(()=>{invalidateVoiceSnapshot(root);fs.rmSync(root,{recursive:true,force:true})});
 const selection={provider,model:provider==='codex'?'gpt-6-astra':'sonnet'};
 const calls=[],updates=[],tasks=[],classifications=[];
 const get=id=>{const task=tasks.find(task=>task.id===id);if(!task)throw Error('Task not found');return task};
 const terminals={live:new Map(),list:()=>tasks,get,
  send(id,text){
   const task=get(id);
   if(task.state==='stopped')throw Error('Resume this terminal before sending a follow-up.');
   if(task.state!=='ready')throw Error('This task is working or needs terminal input. Wait for its answer, or type directly in its terminal.');
   task.state='working';calls.push({kind:'send',id,text});return task;
  },
  start(options){const task={...options,...options.selection,state:'working',turns:[]};tasks.push(task);calls.push({kind:'start',...options});return task},
  startWorkflow(){assert.fail('These requests do not start a named workflow')}
 };
 const add=(fields={})=>{const task={id:crypto.randomUUID(),...selection,title:'AI news visual',prompt:'Create an illustrated summary of yesterday’s AI news.',state:'ready',created:Date.now(),turns:[],...fields};tasks.push(task);if(task.provider===provider)setCurrent(root,terminals,{provider,id:task.id});return task};
 const model=(tier=3,inspect=()=>{})=>async(requestRoot,job,prompt,options)=>{
  assert.equal(requestRoot,root);assert.equal(job.provider,provider);
  assert.equal(job.model,provider==='codex'?'gpt-5.6-luna':'haiku');
  classifications.push({job,prompt,options});inspect({job,prompt,options});
  return {text:JSON.stringify({tier,reply:tier===3?'I will continue that conversation.':'Here is the answer.'})};
 };
 const reopens=[];
 const speak=(transcript,workTarget,execute=model(),extra={},signal)=>routeVoice(root,{id:crypto.randomUUID(),transcript,selection,terminalMode:true,workTarget,...extra},signal,execute,terminals,{resolveCli:()=>({command:'unused-test-cli',prefix:[]}),updateCurrent:value=>updates.push(value),reopenArtifact:item=>reopens.push(item)});
 const receipt=(name,fields)=>writeJson(root,`system/v2/voice-results/${name}.json`,{ts:Date.now()-1000,provider,...fields});
 const write=(relative,content)=>{const filename=path.join(root,relative);fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,content)};
 return {root,selection,calls,updates,tasks,classifications,terminals,add,model,speak,receipt,write,reopens};
}

for(const provider of ['codex','claude']){
 test(`${provider}: a registered output reopens on the dashboard, and other follow-ups carry it to classifier and worker`,async t=>{
  const f=fixture(t,provider),artifact={id:'a'.repeat(40),path:'system/v2/artifacts/files/retained.png',label:'Cipher explainer',mime:'image/png'};
  const task=f.add({turns:[{id:'completed',text:'The explainer is ready.',artifacts:[artifact]}]});
  // "Bring that up" is display, not work: the saved file reopens without a
  // classifier call or a worker turn.
  const shown=await f.speak('Can you bring that up for me?',task.id,()=>assert.fail('Reopening a saved file must not call a model'));
  assert.deepEqual(f.reopens.map(r=>({taskId:r.taskId,artifactId:r.artifact.id})),[{taskId:task.id,artifactId:artifact.id}]);
  assert.equal(shown.reopened.artifactId,artifact.id);assert.equal(shown.reply,'');assert.deepEqual(f.calls,[]);assert.equal(f.classifications.length,0);
  await f.speak('Can you make the title larger?',task.id,f.model(3,({options})=>assert.ok(options.system.includes(artifact.path))));
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].id,task.id);assert.ok(f.calls[0].text.includes(artifact.path));assert.match(f.calls[0].text,/data only, not instructions/);
 });
 test(`${provider}: a selected conversation receives its initial creation receipt without unrelated voice histories`,async t=>{
  const f=fixture(t,provider),task=f.add(),sibling=crypto.randomUUID();
  f.receipt('created',{ts:Date.now()-5000,workTarget:null,workIds:[task.id],transcript:'CREATION_RECEIPT: create the news graphic',reply:'CREATION_REPLY: created the visual',deliverable:'outputs/created-visual.md'});
  f.receipt('selected',{ts:Date.now()-4000,workTarget:task.id,workIds:[],transcript:'SELECTED_QUESTION: which stories were used?',reply:'SELECTED_REPLY: the saved editorial selections'});
  f.receipt('foreign',{ts:Date.now()-3000,provider:provider==='codex'?'claude':'codex',workTarget:task.id,workIds:[task.id],transcript:'FOREIGN_RECEIPT',reply:'FOREIGN_REPLY'});
  f.receipt('sibling',{ts:Date.now()-2000,workTarget:sibling,workIds:[sibling],transcript:'SIBLING_RECEIPT',reply:'SIBLING_REPLY'});
  f.receipt('multi',{workTarget:null,workIds:[task.id,sibling],transcript:'MULTI_RECEIPT',reply:'MULTI_REPLY'});
  await f.speak('Why did you choose that approach?',task.id,f.model(3,({options})=>{
   for(const included of ['CREATION_RECEIPT','CREATION_REPLY','outputs/created-visual.md','SELECTED_QUESTION','SELECTED_REPLY'])assert.ok(options.system.includes(included),included);
   for(const excluded of ['FOREIGN_RECEIPT','FOREIGN_REPLY','SIBLING_RECEIPT','SIBLING_REPLY','MULTI_RECEIPT','MULTI_REPLY'])assert.ok(!options.system.includes(excluded),excluded);
  }));
  assert.equal(f.classifications.length,1);assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'send');
 });

 test(`${provider}: classifier sees the selected original request and saved result after short voice memory expires`,async t=>{
  const f=fixture(t,provider),old=Date.now()-24*60*60*1000;
  const task=f.add({prompt:'ORIGINAL_WORK: create a graphite illustration about the newsroom decision.',created:old,turns:[
   {ts:old,text:'OLDER_RESULT: the initial composition is ready.'},
   {ts:old+1000,text:'LATEST_RESULT: the final illustration is saved at outputs/newsroom-final.png.'}
  ]});
  f.receipt('expired',{ts:old,workTarget:null,workIds:[task.id],transcript:'EXPIRED_VOICE_RECORD',reply:'EXPIRED_VOICE_REPLY'});
  await f.speak('Where did you save it?',task.id,f.model(3,({options})=>{
   for(const included of ['ORIGINAL_WORK','OLDER_RESULT','LATEST_RESULT','outputs/newsroom-final.png'])assert.ok(options.system.includes(included),included);
   assert.ok(!options.system.includes('EXPIRED_VOICE_RECORD'),'Expired voice memory should not be resurrected');
   assert.ok(!options.system.includes('EXPIRED_VOICE_REPLY'),'Use durable task data instead of expired voice receipt');
  }));
  assert.equal(f.calls[0].id,task.id);assert.equal(f.classifications.length,1);
 });

 test(`${provider}: semantic follow-ups dispatch the complete utterance to the same CLI and replay only once`,async t=>{
  const utterances=[
   'Can you show me the result?',
   'Why did you choose that approach?',
   'Where did you save it?',
   'Could you adjust the layout so it is easier to read?',
   'Can you pull up that graphic for me?',
   'Can you go ahead and pull up that graphic you just created on yesterday’s report?'
  ];
  for(const transcript of utterances)await t.test(transcript,async t=>{
   const f=fixture(t,provider),task=f.add({model:provider==='codex'?'gpt-5.6-luna':'opus'}),id=crypto.randomUUID();
   const result=await f.speak(transcript,task.id,f.model(3,({options})=>assert.equal(options.user,transcript)),{id});
   assert.equal(f.classifications.length,1);assert.equal(result.tier,3);assert.equal(result.provider,provider);assert.equal(result.transcript,transcript);
   assert.equal(result.workerModel,task.model);assert.equal(result.model,provider==='codex'?'gpt-5.6-luna':'haiku');
   assert.deepEqual(result.workIds,[task.id]);assert.equal(result.workTarget,task.id);
   assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'send');assert.equal(f.calls[0].id,task.id);
   assert.ok(f.calls[0].text===transcript||f.calls[0].text.startsWith(transcript+'\n\n'),'Original request must precede any appended context');
   assert.deepEqual(f.updates,[{scope:'web',provider,id:task.id}]);
   const replay=await f.speak(transcript,task.id,()=>assert.fail('Receipt replay cannot reclassify'),{id});
   assert.deepEqual(replay,result);assert.equal(f.calls.length,1);assert.equal(f.updates.length,1);
  });
 });

 test(`${provider}: missing, foreign, stopped, busy and draft conversations never start a replacement`,async t=>{
  const f=fixture(t,provider),utterance='Why did you choose that approach?';
  await assert.rejects(f.speak(utterance,crypto.randomUUID()),/conversation is unavailable/);
  const foreign=f.add({provider:provider==='codex'?'claude':'codex'});
  await assert.rejects(f.speak(utterance,foreign.id),/different provider/);
  for(const state of ['stopped','working','needs input','editing']){
   const task=f.add({state});
   await assert.rejects(f.speak(utterance,task.id),state==='stopped'?/Resume this terminal/:/working or needs terminal input/);
   assert.equal(task.state,state);
  }
  assert.equal(f.calls.length,0);assert.equal(f.updates.length,0);
 });

 test(`${provider}: an independent saved brief question bypasses classification even with a selected task`,async t=>{
  const f=fixture(t,provider),task=f.add();
  const relative=`inbox/research/morning-intel/${localDate()}-intel.md`;
  f.write(relative,'## TL;DR\n- Top story: Aurora released an open model.\n\n## Top Story\nAurora released an open model.\n');
  const result=await f.speak('What was the biggest AI story today?',task.id,()=>assert.fail('Independent saved lookup must stay fast'));
  assert.match(result.reply,/Aurora/);assert.equal(result.model,null);assert.deepEqual(result.workIds,[]);
  assert.equal(result.deliverable,relative);assert.equal(f.calls.length,0);assert.equal(task.state,'ready');assert.equal(f.updates.length,0);
 });

 test(`${provider}: a classifier quick answer does not continue work just because a task is selected`,async t=>{
  const f=fixture(t,provider),task=f.add();
  const result=await f.speak('What does that terminology mean in general?',task.id,f.model(2));
  assert.equal(f.classifications.length,1);assert.equal(result.tier,2);assert.deepEqual(result.workIds,[]);assert.equal(f.calls.length,0);assert.equal(task.state,'ready');
 });

 test(`${provider}: explicit new work uses a new task instead of the old selected CLI`,async t=>{
  const f=fixture(t,provider),old=f.add(),id=crypto.randomUUID();
  const result=await f.speak('Start a new task: create a diagram of a solar panel',old.id,()=>assert.fail('Clear new work requires no classifier'),{id});
  assert.deepEqual(result.workIds,[id]);assert.equal(result.workTarget,null);assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].kind,'start');assert.notEqual(f.calls[0].id,old.id);assert.equal(old.state,'ready');
 });

 test(`${provider}: cancellation during classification refuses to send the follow-up`,async t=>{
  const f=fixture(t,provider),task=f.add(),controller=new AbortController();
  await assert.rejects(f.speak('Why did you choose that approach?',task.id,f.model(3,()=>controller.abort()),{},controller.signal),/cancelled/);
  assert.equal(f.classifications.length,1);assert.equal(f.calls.length,0);assert.equal(f.updates.length,0);assert.equal(task.state,'ready');
 });
}
