import test from 'node:test';
import assert from 'node:assert/strict';
import {draftKey,readDraft,type DraftStorage} from '../../obsidian-v2/shared/drafts';
import {VoiceSession} from '../../obsidian-v2/shared/voice-session';
import {getWorkSelection,setWorkProvider,setWorkKeep,workFeed,workTarget,workConversations,syncWorkReply} from '../lib/work';
import {readRecoveredDraft,stageExpiredTaskDraft,stageRecoveredDraft} from '../lib/work-recovery';

function memory():DraftStorage {
  const data=new Map<string,string>();
  return {getItem:key=>data.get(key)||null,setItem:(key,value)=>{data.set(key,value)},removeItem:key=>{data.delete(key)}};
}
const source=draftKey('jarvis','C:/Test Vault','expired-task'),destination=draftKey('jarvis','C:/Test Vault',null);
const oldTask={title:'Earlier research',provider:'claude' as const,model:'sonnet'};

test('explicit expired-task draft copy preserves the original text and provider through reload without dispatch',()=>{
  const storage=memory(),text='My unsent follow-up with "quotes" and ünicode';
  const staged=stageExpiredTaskDraft(storage,source,destination,text,oldTask);
  assert.equal(readDraft(storage,source),text);
  assert.equal(readDraft(storage,destination),text);
  assert.deepEqual(readRecoveredDraft(storage,destination),staged);
  assert.deepEqual(staged.selection,{provider:'claude',model:'sonnet'});
  assert.equal(staged.title,'Draft from Earlier research');
  assert.equal(staged.skill,undefined,'copying user text must not retry the expired workflow');
});

test('copying an expired draft cannot replace an occupied new composer or its provider metadata',()=>{
  const storage=memory(),text='An existing draft';
  stageRecoveredDraft(storage,destination,{prompt:text,title:'Existing',selection:{provider:'codex',model:'gpt-6-astra'}});
  const before=storage.getItem(destination+':recovery');
  for(const draft of ['Different unsent text',text]){
    assert.throws(()=>stageExpiredTaskDraft(storage,source,destination,draft,oldTask),/new-task draft is already saved/);
    assert.equal(readDraft(storage,source),draft,'even a refused copy preserves the source draft');
    assert.equal(readDraft(storage,destination),text);
    assert.equal(storage.getItem(destination+':recovery'),before);
  }
});

test('draft-copy storage failure leaves the old draft and never pretends the new composer was staged',()=>{
  const storage=memory();storage.setItem(source,'Saved before expiry');
  const failing={...storage,setItem(key:string,value:string){if(key!==source)throw new Error('Quota full');storage.setItem(key,value)}};
  assert.throws(()=>stageExpiredTaskDraft(failing,source,destination,'Latest unsent text',oldTask),/could not be saved/);
  assert.equal(readDraft(storage,source),'Latest unsent text');
  assert.equal(readDraft(storage,destination),'');
  assert.equal(readRecoveredDraft(storage,destination),null);
});

test('Keep and unkeep use authenticated bridge mutations and refresh saved summaries; failed mutation stays an error',async t=>{
  const calls:{url:string;options?:RequestInit}[]=[],token='a'.repeat(64);
  let kept=false,fail=false;
  t.mock.method(globalThis,'fetch',async(url:RequestInfo|URL,options?:RequestInit)=>{
    const address=String(url);calls.push({url:address,options});
    if(address==='/api/bridge-auth')return Response.json({token});
    if(address.endsWith('/work/session')){
      assert.equal(options?.method,'POST');assert.equal(new Headers(options?.headers).get('X-V2-Token'),token);
      assert.match(JSON.parse(String(options?.body)).sessionId,/^[a-f0-9-]{36}$/);
      return Response.json({codex:null,claude:null,revision:0});
    }
    if(address.endsWith('/work/keep')){
      assert.equal(options?.method,'POST');assert.equal(new Headers(options?.headers).get('X-V2-Token'),token);
      const body=JSON.parse(String(options?.body));assert.equal(body.id,'saved-task');
      if(fail)return Response.json({error:'Task no longer exists'},{status:404});
      kept=body.keep;return Response.json({id:body.id,keep:kept,lastActivityAt:123,expiresAt:kept?null:456});
    }
    assert.ok(address.endsWith('/work?summary=1'));
    return Response.json({vault:'C:/Test Vault',tasks:[{id:'saved-task',keep:kept,lastActivityAt:123,expiresAt:kept?null:456}]});
  });
  await setWorkKeep('saved-task',true);assert.equal(workFeed.getSnapshot().tasks[0].keep,true);
  await setWorkKeep('saved-task',false);assert.equal(workFeed.getSnapshot().tasks[0].keep,false);
  const count=calls.length;fail=true;
  await assert.rejects(setWorkKeep('saved-task',true),/Task no longer exists/);
  assert.equal(calls.length,count+1,'failure does not retry, dispatch a task or fetch another selection');
  assert.equal(workFeed.getSnapshot().tasks[0].keep,false);
  assert.equal(calls.filter(call=>call.url.endsWith('/work/keep')).length,3);
  assert.equal(calls.filter(call=>call.url.endsWith('/work/session')).length,1,'refreshes reuse the app session');
});

test('an older summary response cannot undo an acknowledged Keep or replace other task fields',async t=>{
  const token='a'.repeat(64),other={id:'other',keep:false,title:'Keep this other summary'},old={id:'saved-task',keep:false,lastActivityAt:123,expiresAt:456,title:'Original title',turns:[{text:'Answer'}]};
  workFeed.publish({vault:'C:/Test Vault',error:'',tasks:[old,other]});
  let release:(response:Response)=>void=()=>{};
  t.mock.method(globalThis,'fetch',async(url:RequestInfo|URL)=>{
    if(String(url)==='/api/bridge-auth')return Response.json({token});
    if(String(url).endsWith('/work/session'))return Response.json({codex:null,claude:null,revision:0});
    if(String(url).endsWith('/work/keep'))return Response.json({id:old.id,keep:true,lastActivityAt:999,expiresAt:null,title:'Not a full summary'});
    return new Promise<Response>(resolve=>{release=resolve});
  });
  const priorPoll=workFeed.refresh();await new Promise(resolve=>setImmediate(resolve));
  const mutation=setWorkKeep(old.id,true);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(workFeed.getSnapshot().tasks[0].keep,true);
  release(Response.json({vault:'C:/Test Vault',tasks:[old,other]}));await Promise.all([priorPoll,mutation]);
  assert.deepEqual(workFeed.getSnapshot().tasks[0],{...old,keep:true,lastActivityAt:999,expiresAt:null});
  assert.equal(workFeed.getSnapshot().tasks[1],other);
});

test('voice drops a server-expired target before transcription without adopting another conversation or dispatching work',async t=>{
  const priorWindow=globalThis.window;
  globalThis.window=new EventTarget() as unknown as Window & typeof globalThis;
  t.after(()=>{globalThis.window=priorWindow});
  const reads:string[]=[],dispatches:string[]=[],messages:{text:string;error?:boolean}[]=[];
  t.mock.method(globalThis,'fetch',async(url:RequestInfo|URL,options?:RequestInit)=>{
    if(String(url)==='/api/bridge-auth')return Response.json({token:'a'.repeat(64)});
    if(String(url).endsWith('/work/session')){assert.equal(options?.method,'POST');return Response.json({codex:null,claude:null,revision:0})}
    reads.push(String(url));assert.ok(String(url).endsWith('/work?summary=1'),'a missing target must not fall back to global provider status');
    return Response.json({tasks:[],vault:'C:/Test Vault',current:{codex:null,claude:'other-provider-task'},currentRevision:51});
  });
  await workConversations.startSession();
  setWorkProvider('codex');workFeed.publish({tasks:[],vault:'C:/Test Vault'});
  syncWorkReply({current:{codex:'expired-task',claude:null},currentRevision:50});assert.equal(workTarget(),'expired-task');
  const session=new VoiceSession(async(path,options)=>{dispatches.push(path);assert.equal(JSON.parse(options?.headers?.['X-V2-Work']||'{}').targetId,null);assert.equal(JSON.parse(options?.headers?.['X-V2-Selection']||'{}').provider,'codex');const text=JSON.parse(String(options?.body)).transcript;return {status:200,json:{reply:text==='Start a new task'?'':'What would you like me to work with?'}}},getWorkSelection);
  // This selection test observes the spoken reply without a physical audio device.
  t.mock.method(session,'speak',async(text:string)=>{assert.match(text,/What would you like/);session.mode='idle';return true});
  session.onMessage=(text,error)=>messages.push({text,error});
  try{
    await session.sendText('Continue the research');
    assert.equal(session.mode,'idle');assert.equal(reads.length,1);assert.deepEqual(dispatches,['/voice/text']);
    assert.match(messages.at(-1)?.text||'',/What would you like/);assert.equal(Boolean(messages.at(-1)?.error),false);
    assert.equal(workTarget(),null,'the server expiry clears the automatic target');assert.equal(workTarget('claude'),'other-provider-task');
    await session.sendText('Start a new task');assert.equal(session.mode,'idle');assert.deepEqual(dispatches,['/voice/text','/voice/text']);
  }finally{await session.destroy()}
});
