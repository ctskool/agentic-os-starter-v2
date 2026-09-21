import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const built=await build({stdin:{contents:`export * from './src/lib/work';export {server,calls} from './src/lib/v2-voice';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'native-work-transport',setup(builder){
 builder.onResolve({filter:/v2-voice$/},()=>({path:'transport',namespace:'fixture'}));
 builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'js',contents:`
 export const calls=[],server={tasks:[],current:{codex:null,claude:null},currentRevision:1,sessionIds:[]};
 export async function v2VoiceTransport(path,options={}){
  calls.push({path,options});
  if(path==='/work/session'){
   const {sessionId}=JSON.parse(options.body);
   if(!server.sessionIds.includes(sessionId)){
    let changed=false;
    for(const provider of ['codex','claude']){
     const task=server.tasks.find(task=>task.id===server.current[provider]&&task.provider===provider);
     if(!task||!['starting','working','needs input','stopping','editing'].includes(task.state)){server.current[provider]=null;changed=true}
    }
    if(changed)server.currentRevision++;
    server.sessionIds.push(sessionId);
   }
   return {status:200,json:{...server.current,revision:server.currentRevision}};
  }
  if(path==='/work?summary=1')return {status:200,json:structuredClone(server)};
  if(path==='/work/current'){
   const {provider,id}=JSON.parse(options.body),task=server.tasks.find(task=>task.id===id);
   if(id&&(!task||task.provider!==provider||task.execution==='script'))return {status:400,json:{error:'Wrong conversation provider'}};
   server.current[provider]=id;server.currentRevision++;
   return {status:200,json:{...server.current,revision:server.currentRevision}};
  }
  throw new Error('Unexpected transport '+path);
 }`}));
}}]});
let moduleId=0;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const task=(id,provider,execution)=>({id,provider,execution,model:provider==='codex'?'gpt-6-astra':'sonnet',title:id,state:'working',sessionId:null,error:null,turns:[]});
async function fixture(t){
 const prior=globalThis.window;globalThis.window=new EventTarget();t.after(()=>{if(prior===undefined)delete globalThis.window;else globalThis.window=prior});
 return import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text+`\n// fixture ${++moduleId}`).toString('base64'));
}

test('native feed initializes the current map without a mounted orb, subscriptions, or extra timer',async t=>{
 const f=await fixture(t);f.server.tasks=[task('codex-current','codex'),task('claude-current','claude')];f.server.current={codex:'codex-current',claude:'claude-current'};
 const previous=globalThis.setInterval;let timers=0;globalThis.setInterval=(...args)=>{timers++;return previous(...args)};
 try{await f.refreshWorkConversations()}finally{globalThis.setInterval=previous}
 assert.equal(f.workTarget('codex'),'codex-current');assert.equal(f.workTarget('claude'),'claude-current');assert.equal(timers,0);assert.deepEqual(f.calls.map(call=>call.path),['/work/session','/work?summary=1']);
});

test('a returned Codex task selects Codex even if the top provider flipped while creation awaited',async t=>{
 const f=await fixture(t);f.server.tasks=[task('old-codex','codex'),task('old-claude','claude')];f.server.current={codex:'old-codex',claude:'old-claude'};await f.refreshWorkConversations();
 f.setWorkProvider('claude');const created=task('new-codex','codex');f.server.tasks.push(created);f.publishWorkTask(created);f.chooseWork(created.id);await flush();
 assert.equal(f.workTarget('codex'),created.id);assert.equal(f.workTarget('claude'),'old-claude');assert.equal(f.workConversations.provider(),'claude');
 const writes=f.calls.filter(call=>call.path==='/work/current');assert.equal(writes.length,1);assert.deepEqual(JSON.parse(writes[0].options.body),{provider:'codex',id:'new-codex'});assert.equal(f.workConversations.error('claude'),null);
});

test('unknown and script terminal IDs cannot infer or overwrite another provider current selection',async t=>{
 const f=await fixture(t);f.server.tasks=[task('codex-current','codex'),task('claude-current','claude'),task('refresh','codex','script')];f.server.current={codex:'codex-current',claude:'claude-current'};await f.refreshWorkConversations();
 const errors=[];window.addEventListener('aos-work-error',event=>errors.push(event.detail));f.setWorkProvider('claude');f.chooseWork('not-loaded');f.chooseWork('refresh');await flush();
 assert.deepEqual(f.workConversations.current(),{codex:'codex-current',claude:'claude-current'});assert.equal(f.calls.some(call=>call.path==='/work/current'),false);assert.equal(errors.length,1);assert.match(errors[0],/still loading/);assert.equal(f.workConversations.error('claude'),null);
});

test('native runtime resets idle saved targets once while keeping active work and later explicit choices',async t=>{
 const f=await fixture(t);f.server.tasks=[{...task('idle-codex','codex'),state:'ready'},task('working-claude','claude')];f.server.current={codex:'idle-codex',claude:'working-claude'};
 await f.refreshWorkConversations();assert.deepEqual(f.workConversations.current(),{codex:null,claude:'working-claude'});
 await f.workConversations.choose('idle-codex','codex');f.setWorkProvider('claude');await f.refreshWorkConversations();f.setWorkProvider('codex');await f.refreshWorkConversations();
 assert.equal(f.workTarget(),'idle-codex');assert.equal(f.workTarget('claude'),'working-claude');
 const sessions=f.calls.filter(call=>call.path==='/work/session');assert.equal(sessions.length,1);assert.match(JSON.parse(sessions[0].options.body).sessionId,/^[a-f0-9-]{36}$/);
});
