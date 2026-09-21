import test,{after} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';
import {SKILLS,ROOT,validateIntent} from '../shared/contract.mjs';
import {mergeDaily,destinationFor} from '../runner/workflows.mjs';
import {processJob,writeJson} from '../runner/core.mjs';
import {routeVoice} from '../runner/bridge-core.mjs';
import {parseWorkerResult} from '../runner/adapters.mjs';
import {spawn} from 'node:child_process';
import {MARKER} from '../shared/contract.mjs';
const job=(skill,args={})=>({version:2,id:crypto.randomUUID(),provider:'codex',model:'gpt-6-astra',skill,args,ts:new Date().toISOString(),from:'plugin'});
const tempRoots=[];after(()=>{for(const root of tempRoots)fs.rmSync(root,{recursive:true,force:true})});
const temp=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-parity-'));tempRoots.push(root);return root};
const note='---\nschema_version: 1\nfocus: Keep this\n---\n# Today\n\n## Current Focus\nMy words.\n\n## Top 3 Priorities\n1. [x] Shipped thing\n2. [ ] Existing commitment\n3. [ ] \n\n## Schedule\n- 10:00 — Old event\n\n## Daily Drivers\n- [x] Recorded\n\n## Notes\nPrivate notes stay here.\n\n## EOD Reflection\nKeep reflection.\n';
test('daily merge fills empty slots and preserves all other content and checked items',()=>{
 const out=mergeDaily(note,'2026-09-06','- 14:00 — Real event',['New priority']);
 assert.match(out,/1\. \[x\] Shipped thing/);assert.match(out,/2\. \[ \] Existing commitment/);assert.match(out,/3\. \[ \] New priority/);assert.match(out,/14:00 — Real event/);assert.doesNotMatch(out,/Old event/);
 assert.equal(out.slice(out.indexOf('## Daily Drivers')),note.slice(note.indexOf('## Daily Drivers')));
 assert.equal(out.slice(0,out.indexOf('## Top 3')),note.slice(0,note.indexOf('## Top 3')));
 const windows=mergeDaily(note.replace(/\n/g,'\r\n'),'2026-09-06','- 14:00 — Event',['New priority']);assert.match(windows,/3\. \[ \] New priority\r\n/);assert.equal(windows.slice(windows.indexOf('## Daily Drivers')),note.slice(note.indexOf('## Daily Drivers')).replace(/\n/g,'\r\n'));
 assert.throws(()=>mergeDaily(note.replace('schema_version: 1','schema_version: 2'),'2026-09-06',''),/unsupported/);
});
test('calendar failure never changes the daily note or calls a planner',async()=>{
 const root=temp(),j=job('plan-today'),file=path.join(root,destinationFor(j));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,note);
 const result=await processJob(root,j,async()=>assert.fail('planner must not run'),{calendar:async()=>{throw new Error('Google sign-in required')}});
 assert.equal(result.status,'error');assert.equal(fs.readFileSync(file,'utf8'),note);
});
test('concurrent note edit is preserved; successful merge creates a byte-exact backup',async()=>{
 const root=temp(),j=job('plan-today'),file=path.join(root,destinationFor(j));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,note);
 const result=await processJob(root,j,async()=>{fs.writeFileSync(file,note+'User typing\n');return{text:'{"priorities":["Next"]}'}},{calendar:async()=>'- 14:00 — Event'});
 assert.equal(result.status,'error');assert.match(fs.readFileSync(file,'utf8'),/User typing/);
 const j2=job('refresh-schedule'),before=fs.readFileSync(file,'utf8');const ok=await processJob(root,j2,async()=>assert.fail('refresh is deterministic'),{calendar:async()=>'- 15:00 — Event'});
 assert.equal(ok.status,'ok');assert.equal(fs.readFileSync(path.join(root,`${ROOT}/backups/${j2.id}.md`),'utf8'),before);
});
test('all original workflows have deliverables and required args cannot be omitted or injected',()=>{
 for(const [id,spec] of Object.entries(SKILLS)){const args=spec.arg?{[spec.arg]:spec.arg==='url'?'https://example.com/video':'Test topic'}:{};const j=job(id,args);assert.equal(validateIntent(j),j);assert.ok(destinationFor(j).endsWith('.md'));if(spec.arg)assert.throws(()=>validateIntent(job(id)),/needs/)}
 assert.throws(()=>validateIntent(job('content-cascade',{url:'file:///secrets'})),/HTTP/);assert.throws(()=>validateIntent(job('voice-ask',{prompt:'Test',command:'delete'})),/Invalid workflow/);
});
test('open-ended voice reaches Astra with the original request and provider-scoped context',async()=>{
 const root=temp(),id=crypto.randomUUID();writeJson(root,`${ROOT}/runner-status.json`,{ts:new Date().toISOString(),busy:false});writeJson(root,`${ROOT}/voice-results/old.json`,{ts:Date.now()-1000,provider:'codex',transcript:'My topic is agents',reply:'Okay'});
 const r=await routeVoice(root,{id,selection:{provider:'codex',model:'gpt-5.6-luna'},transcript:'Compare those approaches using my notes'},null,async()=>({text:'{"action":"task","skill":"voice-ask","args":{"prompt":"rewritten"},"reply":"Working on it"}'}));
 assert.equal(r.tier,3);const queued=JSON.parse(fs.readFileSync(path.join(root,`${ROOT}/queue/${id}.json`),'utf8'));assert.equal(queued.args.prompt,'Compare those approaches using my notes');assert.match(queued.args.context,/My topic is agents/);assert.equal(queued.model,'gpt-6-astra');
});
test('a blocked structured result is a failed run, never a successful deliverable',async()=>{
 assert.throws(()=>parseWorkerResult('Plain prose claiming completion'));
 const root=temp(),j=job('voice-ask',{prompt:'Read a missing source'});
 const result=await processJob(root,j,async()=>parseWorkerResult({status:'blocked',summary:'Required source unavailable',markdown:'Could not verify the answer.'}));
 assert.equal(result.status,'error');assert.equal(result.deliverable_path,null);assert.match(result.summary,/Required source/);
});
test('vault MCP reads notes without a shell and rejects traversal and hidden folders',async()=>{
 const root=temp();fs.writeFileSync(path.join(root,MARKER),'agentic-os-v2-only');fs.writeFileSync(path.join(root,'CLAUDE.md'),'# Conventions\nPreserve daily note schema.');
 const child=spawn(process.execPath,['runner/vault-mcp.mjs'],{env:{...process.env,AOS_V2_VAULT:root},stdio:['pipe','pipe','pipe'],windowsHide:true});
 try{
  const replies=new Map();let buffer='';child.stdout.on('data',data=>{buffer+=data;let index;while((index=buffer.indexOf('\n'))>=0){const r=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);replies.get(r.id)?.(r.result)}});
  const request=(id,method,params)=>new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('MCP test timeout')),5000);replies.set(id,r=>{clearTimeout(timeout);resolve(r)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')});
  const call=(id,name,args)=>request(id,'tools/call',{name,arguments:args});
  const read=await call(1,'read_note',{path:'CLAUDE.md'});assert.match(read.content[0].text,/Preserve daily/);
  assert.equal((await call(2,'read_note',{path:'../outside.md'})).isError,true);
  assert.equal((await call(3,'list_notes',{path:'.claude'})).isError,true);
  const {tools}=await request(4,'tools/list',{}),youtube=tools.find(tool=>tool.name==='youtube_review_data');
  assert.ok(youtube);assert.deepEqual(youtube.annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true});
  assert.ok(!tools.some(tool=>['calendar_events','inbox_messages'].includes(tool.name)),'retired Google adapter must not be advertised');
  assert.equal((await call(5,'youtube_review_data',{channel:'arbitrary-channel'})).isError,true,'unrecognized arguments cannot reach the API');
  const research=tools.find(tool=>tool.name==='youtube_research_data');assert.ok(research);
  assert.deepEqual(research.annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true});
  assert.deepEqual(research.inputSchema.properties.operation.enum,['search','videos','channels','channel_uploads']);
  assert.equal((await call(6,'youtube_research_data',{operation:'search',query:'topic',url:'https://example.com'})).isError,true,'arbitrary endpoints cannot reach the API');
 }finally{child.kill()}
});
