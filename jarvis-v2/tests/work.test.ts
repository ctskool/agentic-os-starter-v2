import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseWork,getWorkSelection,setWorkProvider,workFeed,workTarget,workProvider,syncWorkReply,workConversations} from '../lib/work';
import {replayTerminal} from '../../obsidian-v2/shared/terminal-playback';

test('terminal replay waits for asynchronous writes before applying the next resize',async()=>{
  const calls:string[]=[];
  const term={cols:110,rows:30,resize(cols:number,rows:number){this.cols=cols;this.rows=rows;calls.push(`resize:${cols}`)},reset(){calls.push('reset')},write(data:string,done:()=>void){setTimeout(()=>{calls.push(`${data}:${this.cols}`);done()},5)}};
  await replayTerminal(term,{reset:true,data:'',frames:[{cols:110,rows:30,data:'wide'},{cols:80,rows:20,data:'narrow'}]},()=>false);
  assert.deepEqual(calls,['reset','wide:110','resize:80','narrow:80']);
});

test('authoritative voice replies update the originating conversation without switching providers or accepting stale replies',async t=>{
  let sessions=0;
  t.mock.method(globalThis,'fetch',async(url:RequestInfo|URL,options?:RequestInit)=>{
    if(String(url)==='/api/bridge-auth')return Response.json({token:'a'.repeat(64)});
    assert.ok(String(url).endsWith('/work/session'));assert.equal(options?.method,'POST');
    const session=JSON.parse(String(options?.body));assert.match(session.sessionId,/^[a-f0-9-]{36}$/);assert.equal(session.mode,'adopt');
    sessions++;return Response.json({codex:'existing-web-conversation',claude:null,revision:0});
  });
  await workConversations.startSession();assert.equal(sessions,1);assert.equal(workTarget('codex'),'existing-web-conversation');
  setWorkProvider('claude');
  syncWorkReply({current:{codex:'new-codex-conversation',claude:'remembered-claude'},currentRevision:10});
  assert.equal(workProvider(),'claude');
  assert.equal(workTarget(),'remembered-claude');
  assert.equal(workTarget('codex'),'new-codex-conversation');
  syncWorkReply({current:{codex:'older-codex',claude:null},currentRevision:9});
  assert.equal(workTarget('codex'),'new-codex-conversation');
  assert.equal(workFeed.getSnapshot().currentRevision,10);
  syncWorkReply({current:{codex:null,claude:'remembered-claude'},currentRevision:11});
  assert.equal(workTarget('codex'),null,'explicit new request clears its provider');
  assert.equal(workTarget(),'remembered-claude');
});

test('voice captures its task and provider across an asynchronous target change',async()=>{
  const priorFetch=globalThis.fetch,priorWindow=globalThis.window;
  globalThis.window=new EventTarget() as unknown as Window & typeof globalThis;
  let current={codex:null as string|null,claude:null as string|null,revision:20},hold=false;
  const tasks=[{id:'claude-conversation',provider:'claude',model:'sonnet'},{id:'codex-conversation',provider:'codex',model:'gpt-6-astra'}];
  let release:(r:Response)=>void=()=>{};
  globalThis.fetch=async(url,options)=>{
    if(String(url)==='/api/bridge-auth')return Response.json({token:'a'.repeat(64)});
    if(String(url).endsWith('/work/session')){assert.equal(options?.method,'POST');return Response.json(current)}
    if(String(url).endsWith('/work/current')){const b=JSON.parse(String(options?.body));current={...current,[b.provider]:b.id,revision:current.revision+1};return Response.json(current)}
    assert.ok(String(url).endsWith('/work?summary=1'));
    if(hold)return new Promise<Response>(resolve=>{release=resolve});
    return Response.json({tasks,current:{codex:current.codex,claude:current.claude},currentRevision:current.revision});
  };
  try{
    workFeed.publish({tasks,current:{codex:null,claude:null},currentRevision:20,vault:'test'});
    setWorkProvider('claude');await chooseWork('claude-conversation');hold=true;const pending=getWorkSelection();await new Promise(resolve=>setImmediate(resolve));
    setWorkProvider('codex');await chooseWork('codex-conversation');
    release(Response.json({tasks,current:{codex:current.codex,claude:current.claude},currentRevision:current.revision}));
    assert.deepEqual(await pending,{provider:'claude',model:'sonnet',terminalMode:true,targetId:'claude-conversation'});
    hold=false;await chooseWork(null);
    assert.deepEqual(await getWorkSelection(),{provider:'codex',model:'gpt-6-astra',terminalMode:true,targetId:null});
    setWorkProvider('claude');assert.equal(workTarget(),'claude-conversation','New request cleared only Codex');
  }finally{globalThis.fetch=priorFetch;globalThis.window=priorWindow}
});
