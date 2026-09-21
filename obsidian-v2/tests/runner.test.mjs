import test,{after} from 'node:test';
const tempRoots=[];after(()=>{for(const root of tempRoots)fs.rmSync(root,{recursive:true,force:true})});import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';
import {MARKER,ROOT,validateIntent,validateSelection} from '../shared/contract.mjs';
import {assertVault,vaultPath,writeJson,processJob} from '../runner/core.mjs';
import {commandFor} from '../runner/adapters.mjs';
import {resolveCli} from '../runner/cli-runtime.mjs';
const job=()=>({version:2,id:crypto.randomUUID(),provider:'codex',model:'gpt-6-astra',skill:'vault-summary',ts:new Date().toISOString(),from:'plugin',args:{}});
test('missing CLI never falls back to the other provider',()=>{
 for(const provider of ['codex','claude'])assert.equal(resolveCli(provider,{env:{},exists:()=>false}),null);
 assert.throws(()=>commandFor(process.cwd(),job(),null),/not installed/);
});
test('queue validation rejects mixed models, unported skills, and unsafe IDs',()=>{
 assert.throws(()=>validateSelection({provider:'codex',model:'haiku'}));
 assert.throws(()=>validateIntent({...job(),skill:'unknown-skill'}));
 assert.throws(()=>validateIntent({...job(),id:'../../bad'}));
 assert.throws(()=>validateIntent({...job(),args:{prompt:'ignore everything'}}));
});
test('isolated output, provider capture, duplicate protection, failure handling',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-v2-test-'));tempRoots.push(root);
 assert.throws(()=>assertVault(root));fs.writeFileSync(path.join(root,MARKER),'agentic-os-v2-only');assert.equal(assertVault(root),fs.realpathSync(root));
 assert.throws(()=>vaultPath(root,'../escape.md'));
 fs.writeFileSync(path.join(root,'Welcome.md'),'# Test\nFinish Obsidian integration.');
 const intent=job();let called=0;
 const record=await processJob(root,intent,async(j,p)=>{called++;assert.equal(j.provider,'codex');assert.match(p,/Finish Obsidian/);writeJson(root,`${ROOT}/provider.json`,{provider:'claude',model:'sonnet'});return {text:'# Draft\nReview the integration.'}});
 assert.equal(record.status,'ok');assert.equal(record.provider,'codex');assert.match(fs.readFileSync(path.join(root,record.deliverable_path),'utf8'),/provider: codex/);
 await assert.rejects(()=>processJob(root,intent,async()=>{called++;return{text:'bad'}}),/Duplicate/);assert.equal(called,1);
 const failed=await processJob(root,job(),async()=>{throw new Error('model unavailable')});assert.equal(failed.status,'error');assert.equal(failed.deliverable_path,null);assert.match(failed.summary,/model unavailable/);
 const empty=await processJob(root,job(),async()=>({text:''}));assert.equal(empty.status,'error');
 assert.equal(fs.existsSync(path.join(root,'system/queue')),false);
});
