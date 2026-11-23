import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {ROOT} from '../shared/contract.mjs';
import {writeJson} from '../runner/core.mjs';
import {readJson,routeVoice} from '../runner/bridge-core.mjs';
import {handleVoiceRequest} from '../runner/voice-request.mjs';
import {readVoiceReport} from '../runner/voice-documents.mjs';
import {voiceMemory} from '../runner/voice-router.mjs';
import {localDate} from '../runner/brief-voice.mjs';
import {CONVERSATION_IDLE_MS,readCurrentState,readConversationEpoch,setCurrent} from '../runner/current-conversations.mjs';

const chosen={provider:'claude',model:'sonnet'};
const selected='00000000-0000-4000-8000-000000000001',stale='00000000-0000-4000-8000-000000000002';
const daily=`daily-notes/${localDate()}.md`;
const note='# Today\n\n## Top 3 Priorities\n1. [ ] Publish the newsletter\n2. [ ] Record the demo\n\n## Daily Drivers\n- [ ] Review comments\n';
const artifact={id:'a'.repeat(40),path:`${ROOT}/artifacts/files/test.png`,label:'Preview',mime:'image/png',isFinal:true};
const put=(root,relative,text)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text)};
function tree(root){
 const files=new Map();
 const walk=dir=>{for(const item of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){
  const relative=path.posix.join(dir,item.name);
  if(item.isDirectory())walk(relative);else files.set(relative,fs.readFileSync(path.join(root,relative),'utf8'));
 }};
 walk('');return files;
}
const diff=(before,after)=>[...new Set([...before.keys(),...after.keys()])].filter(file=>before.get(file)!==after.get(file));

function fixture(t,{target=false,state='ready',staleCurrent=true,model={tier:3,reply:'Working on that.'}}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'voice-plan-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 put(root,daily,note);put(root,artifact.path,'fixture image');writeJson(root,`${ROOT}/runner-status.json`,{ts:new Date().toISOString()});
 const records=new Map(),calls=[],task={id:selected,...chosen,model:'opus',state,execution:'cli',created:Date.now(),title:'Newsletter',turns:[]};
 const add=(site,job)=>{calls.push([site,job]);const next={id:job.id,...job.selection,state:'working',title:job.title,execution:'cli'};records.set(next.id,next);return next};
 const terminals={records,live:new Map(),list:()=>[...records.values()],get:id=>records.get(id),
  start:job=>add('start',job),startWorkflow:job=>add('startWorkflow',job),send:(...args)=>calls.push(['send',...args]),
  stop(id){calls.push(['stop',id]);records.get(id).state='stopped'},
  continueWorkflow:(...args)=>calls.push(['continueWorkflow',...args])
 };
 if(target){records.set(selected,task);setCurrent(root,terminals,{provider:'claude',id:selected})}
 if(staleCurrent){
  const then=Date.now()-CONVERSATION_IDLE_MS-10000;
  records.set(stale,{id:stale,provider:'codex',model:'astra',state:'ready',execution:'cli',created:then});
  setCurrent(root,terminals,{provider:'codex',id:stale,now:then});
 }
 let jevCalls=0,modelCalls=0;
 const execute=async()=>{modelCalls++;return {text:JSON.stringify(model)}};
 const routeOptions={resolveCli:()=>true,
  jev:{config:{key:'fixture',mode:{claude:'shadow'},theta:0.9},classify:async()=>{jevCalls++;return {route:'tier3',tier:3,p:0.95,ms:1}}},
  strict:{config:{open:'shadow',ui:'shadow'}},
  updateCurrent:change=>setCurrent(root,terminals,change),
  onDispatch:(...args)=>calls.push(['onDispatch',...args]),
  reopenArtifact:(...args)=>calls.push(['reopenArtifact',args[0]])
 };
 const request=(transcript,fields={})=>({id:crypto.randomUUID(),transcript,selection:chosen,terminalMode:true,workTarget:target?selected:null,...fields});
 const route=(request,options={})=>routeVoice(root,request,undefined,execute,terminals,{...routeOptions,...options});
 const ctx={root,terminals,active:new Map(),routeOptions,route:(root,request,signal,_execute,terminals,options)=>routeVoice(root,request,signal,execute,terminals,options)};
 return {root,request,route,ctx,task,calls,terminals,models:()=>modelCalls,jevCalls:()=>jevCalls};
}

const routes=[
 {name:'saved lookup',said:'What was the top AI news today?'},
 {name:'tier 1 workflow',said:'Run morning intel',description:/Start the morning-intel workflow in your Claude terminal/,sites:['startWorkflow','onDispatch','updateCurrent']},
 {name:'tier 3 new task',said:'Start a new task: Options for the newsletter format.',description:/Start “/,options:{target:true},model:true,sites:['start','onDispatch','updateCurrent']},
 {name:'continue selected',said:'Continue the newsletter',description:/Continue “Newsletter”/,options:{target:true},sites:['send','onDispatch','updateCurrent']},
 {name:'continue selected workflow',said:'Run morning intel',description:/Run the morning-intel workflow in “Newsletter”/,options:{target:true},sites:['continueWorkflow','onDispatch','updateCurrent']},
 {name:'stop',said:'Stop that',description:/Stop “Newsletter”/,options:{target:true,state:'working'},sites:['stop']},
 {name:'Top 3 note edit',said:'Check off priority two',description:/Check off “Record the demo”/,options:{target:true},sites:['editDaily']},
 {name:'model-proposed note edit',said:'Mark whichever priority involves recording',description:/Check off “Record the demo”/,options:{model:{tier:2,write:{kind:'top3',index:1}}},model:true,sites:['editDaily']},
 {name:'fuzzy note edit',said:'Mark review comments done',description:/Check off “Review comments”/,sites:['editDaily']},
 {name:'add note item',said:'Add proofread the draft to my tasks',description:/Add “proofread the draft”/,sites:['editDaily']},
 {name:'conversation reset',said:'Start a new task',description:/Start a new conversation/,options:{target:true},sites:['updateCurrent']},
 {name:'legacy enqueue',said:'Run morning intel',request:{terminalMode:false},description:/Queue the morning-intel workflow/,sites:['enqueue']},
 {name:'artifact reopen',said:'Pull it up',description:/Reopen “Preview”/,options:{target:true},seed:f=>f.task.turns.push({id:'output',artifacts:[artifact]}),sites:['reopenArtifact']}
];
for(const item of routes)test(`plan and commit: ${item.name}`,async t=>{
 const live=fixture(t,item.options);item.seed?.(live);
 const request=live.request(item.said,item.request);
 const before=tree(live.root);
 const planned=await handleVoiceRequest(live.ctx,request,{source:'live',phase:'plan',guard:()=>assert.fail('plan reached the guard')});
 // Deferred strict/Jev qualification may log on a later turn.
 await new Promise(resolve=>setImmediate(()=>setImmediate(resolve)));
 const after=tree(live.root),changed=diff(before,after);
 assert.ok(changed.includes(`${ROOT}/current-conversations.json`));
 assert.equal(readCurrentState(live.root).codex,null);
 assert.ok(changed.every(file=>file===`${ROOT}/current-conversations.json`||file===`${ROOT}/voice-requests/${request.id}.json`||
  file===`${ROOT}/voice-results/${request.id}.json`||file.startsWith(`${ROOT}/logs/`)||file.startsWith(`${ROOT}/jev-shadow/`)),changed.join('\n'));
 assert.deepEqual(live.calls,[]);
 if(item.model){assert.equal(live.jevCalls(),1);assert.equal(live.models(),1);assert.ok(changed.some(file=>file.startsWith(`${ROOT}/jev-shadow/`)))}
 if(!item.sites){
  assert.equal(planned.kind,'read');
  assert.equal(readJson(live.root,`${ROOT}/voice-results/${request.id}.json`,null).reply,planned.reply);return;
 }
 assert.equal(planned.kind,'action');assert.match(planned.description,item.description);
 assert.equal(readJson(live.root,`${ROOT}/voice-results/${request.id}.json`,null),null);
 const action=JSON.parse(JSON.stringify(planned.action)),guarded=[],beforeModels=live.models();
 const committed=await handleVoiceRequest(live.ctx,request,{source:'live',phase:'commit',plannedAction:action,guard:(site,details)=>{assert.ok(details);guarded.push(site)}});
 assert.equal(live.models(),beforeModels,'commit must never classify again');
 assert.deepEqual(guarded.filter(site=>site!=='renewConversation'),item.sites);
 assert.equal(guarded[0]==='renewConversation',Boolean(item.options?.target&&!item.said.startsWith('Start a new task')));
 assert.equal(committed.transport,'live');assert.equal(committed.origin,'live');
 const local=fixture(t,item.options);item.seed?.(local);
 const baseline=await local.route(request);
 assert.deepEqual(live.calls,local.calls);
 assert.deepEqual(committed.workIds,baseline.workIds);
 assert.equal(committed.queued,baseline.queued);
 assert.equal(committed.workerModel,baseline.workerModel);
 assert.equal(committed.conversationEpoch,baseline.conversationEpoch);
 assert.deepEqual(readCurrentState(live.root),readCurrentState(local.root));
 assert.equal(tree(live.root).get(daily),tree(local.root).get(daily));
 if(committed.queued){
  const queued=root=>{const {ts,...job}=readJson(root,`${ROOT}/queue/${request.id}.json`);return job};
  assert.deepEqual(queued(live.root),queued(local.root));
 }
 const replay=await handleVoiceRequest(live.ctx,request,{source:'live',phase:'commit',plannedAction:action,guard:()=>assert.fail('replay reapplied effects')});
 assert.deepEqual(replay,committed);
});

for(const changed of ['target','selection','epoch','task state','note moved','note renamed'])test(`commit refuses changed ${changed} before effects`,async t=>{
 const f=fixture(t,{target:true,staleCurrent:false}),request=f.request(changed.startsWith('note')?'Check off priority two':'Continue the newsletter');
 const planned=await handleVoiceRequest(f.ctx,request,{source:'live',phase:'plan'});
 const commitRequest={...request};
 if(changed==='target')commitRequest.workTarget=null;
 if(changed==='selection')writeJson(f.root,`${ROOT}/provider.json`,{provider:'claude',model:'opus'});
 if(changed==='epoch')setCurrent(f.root,f.terminals,{provider:'claude',id:selected,resetContext:true});
 if(changed==='task state')f.task.state='working';
 if(changed==='note moved')put(f.root,daily,note.replace('1. [ ] Publish the newsletter\n2. [ ] Record the demo','2. [ ] Record the demo\n1. [ ] Publish the newsletter'));
 if(changed==='note renamed')put(f.root,daily,note.replace('Record the demo','Record a tutorial'));
 const before=tree(f.root);
 await assert.rejects(handleVoiceRequest(f.ctx,commitRequest,{source:'live',phase:'commit',plannedAction:planned.action,guard:()=>assert.fail('validated too late')}),/changed/);
 assert.deepEqual(tree(f.root),before);assert.deepEqual(f.calls,[]);
});

for(const said of ['Continue the newsletter','Start a new task','Check off priority two'])test(`guard veto precedes every effect: ${said}`,async t=>{
 const f=fixture(t,{target:said.startsWith('Continue'),staleCurrent:false}),request=f.request(said);
 const planned=await f.route(request,{phase:'plan',transport:'live'}),before=tree(f.root);
 const refusal=new Error('Guard veto');
 await assert.rejects(f.route(request,{phase:'commit',transport:'live',plannedAction:planned.action,guard:()=>{throw refusal}}),error=>error===refusal);
 assert.deepEqual(tree(f.root),before);assert.deepEqual(f.calls,[]);
});

test('Local receipts and older receipts share Local replay and offer semantics',async t=>{
 const f=fixture(t,{staleCurrent:false}),oldId=crypto.randomUUID(),report='wiki/fixture.md';
 put(f.root,report,'local report');
 const old={id:oldId,provider:chosen.provider,requestedWorkerModel:chosen.model,transcript:'How is my queue?',
  reply:'Want me to run the morning report, or do you have anything else in mind?',ts:Date.now()-20,workIds:[],tier:2,deliverable:report};
 writeJson(f.root,`${ROOT}/voice-results/${oldId}.json`,old);
 assert.equal((await f.route(f.request(old.transcript,{id:oldId}))).transport,'local');
 assert.equal(voiceMemory(f.root,'claude').at(-1).you,old.transcript);
 assert.equal(readVoiceReport(f.root,report,[],[old]).content,'local report');
 assert.throws(()=>readVoiceReport(f.root,report,[],[{...old,transport:'live'}]),/Only referenced notes/);
 const liveOffer={...old,id:crypto.randomUUID(),transport:'live'};
 writeJson(f.root,`${ROOT}/voice-results/${liveOffer.id}.json`,liveOffer);
 const live=await f.route(f.request('yes'),{transport:'live',phase:'plan',guard:()=>assert.fail('affirmation reached guard')});
 assert.equal(live.kind,'read');assert.equal(live.reply,"Tell me what you'd like me to do.");assert.deepEqual(f.calls,[]);
 const local=await f.route(f.request('yes',{origin:'test'}));
 assert.equal(local.transport,'local');assert.equal(local.origin,'test');assert.equal(local.skill,'morning-report');
 assert.equal(readJson(f.root,`${ROOT}/voice-results/${local.id}.json`).transport,'local');
 assert.equal(readConversationEpoch(f.root,'claude'),0);
});

test('the shared artifact reopen guards binding and durable publication separately',async t=>{
 const f=fixture(t,{target:true,staleCurrent:false}),request=f.request('Pull it up'),events=[];
 f.task.turns.push({id:'output',artifacts:[artifact]});
 const {reopenArtifact:_stub,...routeOptions}=f.ctx.routeOptions;
 const target={client:'fixture-surface',kind:'web',provider:'claude',epoch:0};
 const ctx={...f.ctx,routeOptions,artifactTarget:()=>target,hub:{live:()=>[],emit:event=>events.push(['emit',event.type])},
  artifacts:{bind:id=>events.push(['bind',id]),publish:(_task,turn)=>{events.push(['publish',turn.id]);return 1}}};
 const {action}=await handleVoiceRequest(ctx,request,{source:'live',phase:'plan',guard:()=>assert.fail('plan reached guard')});
 assert.deepEqual(events,[]);
 await handleVoiceRequest(ctx,request,{source:'live',phase:'commit',plannedAction:action,guard:site=>{if(site!=='renewConversation')events.push(['guard',site])}});
 assert.deepEqual(events,[['guard','reopenArtifact'],['bind',selected],['guard','publishArtifact'],['publish',`reopen:${request.id}`],['emit','pending']]);
});
