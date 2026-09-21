import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {readCurrent,readCurrentState,readConversationEpoch,setCurrent,taskInScope} from '../runner/current-conversations.mjs';

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-current-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const codex={id:crypto.randomUUID(),provider:'codex',state:'working'},claude={id:crypto.randomUUID(),provider:'claude',state:'stopped'},script={id:crypto.randomUUID(),provider:'codex',execution:'script'};
 const records=new Map([codex,claude,script].map(task=>[task.id,task]));
 const terminals={get(id){const task=records.get(id);if(!task)throw new Error('Task not found');return task}};
 return {root,codex,claude,script,terminals,records,file:path.join(root,'system/v2/current-conversations.json')};
}
test('new vaults start with no implicit task adoption and reads never write',t=>{
 const f=fixture(t);assert.deepEqual(readCurrentState(f.root),{codex:null,claude:null,revision:0});assert.equal(fs.existsSync(f.file),false);
});

test('background skill records remain app scoped and cannot become voice conversations',t=>{
 const f=fixture(t);setCurrent(f.root,f.terminals,{provider:'codex',id:f.codex.id});const before=fs.readFileSync(f.file,'utf8');
 for(const execution of ['headless','script'])for(const scope of ['web','native']){
  const record={id:crypto.randomUUID(),provider:'codex',execution,background:true,appScope:scope};f.records.set(record.id,record);
  assert.equal(taskInScope(record,scope),true);assert.equal(taskInScope(record,scope==='web'?'native':'web'),false);
  assert.throws(()=>setCurrent(f.root,f.terminals,{provider:'codex',id:record.id,scope}),/not a voice conversation/);
 }
 assert.equal(fs.readFileSync(f.file,'utf8'),before);
});
test('provider conversations persist independently with monotonic revisions and explicit reset',t=>{
 const f=fixture(t);
 assert.equal(setCurrent(f.root,f.terminals,{provider:'codex',id:f.codex.id}).revision,1);
 assert.equal(setCurrent(f.root,f.terminals,{provider:'claude',id:f.claude.id}).revision,2);
 assert.deepEqual(readCurrent(f.root),{codex:f.codex.id,claude:f.claude.id});
 assert.equal(setCurrent(f.root,f.terminals,{provider:'codex',id:f.codex.id}).revision,2);
 assert.deepEqual(setCurrent(f.root,f.terminals,{provider:'codex',id:null}),{codex:null,claude:f.claude.id,revision:3});
 assert.equal(JSON.parse(fs.readFileSync(f.file)).scopes.web.current.claude,f.claude.id);
});
test('foreign, script and invalid destinations are rejected without overwriting selection',t=>{
 const f=fixture(t);setCurrent(f.root,f.terminals,{provider:'codex',id:f.codex.id});const before=fs.readFileSync(f.file,'utf8');
 for(const change of [{provider:'codex',id:f.claude.id},{provider:'codex',id:f.script.id},{provider:'codex',id:'../../escape'},{provider:'invalid',id:null},{provider:'codex',id:crypto.randomUUID()}])assert.throws(()=>setCurrent(f.root,f.terminals,change));
 assert.equal(fs.readFileSync(f.file,'utf8'),before);
});
test('deleted or expired current tasks remain visibly unavailable until explicitly reset',t=>{
 const f=fixture(t);setCurrent(f.root,f.terminals,{provider:'codex',id:f.codex.id});f.records.delete(f.codex.id);
 assert.equal(readCurrent(f.root).codex,f.codex.id);
 assert.equal(setCurrent(f.root,f.terminals,{provider:'codex',id:null}).codex,null);
});
test('corrupt persisted state fails closed instead of silently starting another conversation',t=>{
 const f=fixture(t);setCurrent(f.root,f.terminals,{provider:'codex',id:f.codex.id});
 for(const text of ['{broken',JSON.stringify({version:1,revision:1,current:{codex:'invalid',claude:null}})]){fs.writeFileSync(f.file,text);assert.throws(()=>readCurrentState(f.root),/conversation/);assert.throws(()=>setCurrent(f.root,f.terminals,{provider:'claude',id:f.claude.id}),/conversation/)}
});

test('each app keeps provider selections, revisions, and fresh-start epochs independently',t=>{
 const f=fixture(t),nativeCodex={id:crypto.randomUUID(),provider:'codex',execution:'native'},nativeClaude={id:crypto.randomUUID(),provider:'claude',execution:'native'};
 f.records.set(nativeCodex.id,nativeCodex);f.records.set(nativeClaude.id,nativeClaude);
 assert.equal(setCurrent(f.root,f.terminals,{provider:'codex',id:f.codex.id}).revision,1);
 assert.equal(setCurrent(f.root,f.terminals,{provider:'claude',id:f.claude.id}).revision,2);
 assert.deepEqual(readCurrentState(f.root,'native'),{codex:null,claude:null,revision:0});
 assert.equal(setCurrent(f.root,f.terminals,{scope:'native',provider:'codex',id:nativeCodex.id}).revision,1);
 assert.equal(setCurrent(f.root,f.terminals,{scope:'native',provider:'claude',id:nativeClaude.id}).revision,2);
 const web=readCurrentState(f.root);
 assert.equal(setCurrent(f.root,f.terminals,{scope:'native',provider:'codex',id:null}).revision,3);
 assert.deepEqual(readCurrentState(f.root),web);
 assert.deepEqual(readCurrent(f.root,'native'),{codex:null,claude:nativeClaude.id});
 assert.equal(readConversationEpoch(f.root,'codex','native'),1);
 assert.equal(readConversationEpoch(f.root,'claude','native'),0);
 assert.equal(readConversationEpoch(f.root,'codex'),0);
 assert.equal(setCurrent(f.root,f.terminals,{provider:'claude',id:null}).revision,3);
 assert.equal(readConversationEpoch(f.root,'claude'),1);
 assert.equal(readConversationEpoch(f.root,'claude','native'),0);
});

test('legacy state remains web-owned and migration never adopts bridge sessions for native',t=>{
 const f=fixture(t);fs.mkdirSync(path.dirname(f.file),{recursive:true});
 const legacy={version:1,current:{codex:f.codex.id,claude:f.claude.id},revision:41,contextEpochs:{codex:6,claude:9}};
 fs.writeFileSync(f.file,JSON.stringify(legacy));const before=fs.readFileSync(f.file,'utf8');
 assert.deepEqual(readCurrentState(f.root),{...legacy.current,revision:41});
 assert.deepEqual(readCurrentState(f.root,'native'),{codex:null,claude:null,revision:0});
 assert.equal(readConversationEpoch(f.root,'codex','native'),0);
 assert.equal(fs.readFileSync(f.file,'utf8'),before,'Reads do not migrate or rewrite sessions');
 setCurrent(f.root,f.terminals,{scope:'native',provider:'codex',id:null});
 const saved=JSON.parse(fs.readFileSync(f.file));assert.equal(saved.version,2);
 assert.deepEqual(saved.scopes.web,{current:legacy.current,revision:41,contextEpochs:legacy.contextEpochs});
 assert.deepEqual(readCurrentState(f.root,'native'),{codex:null,claude:null,revision:1});
 assert.equal(readConversationEpoch(f.root,'codex'),6);assert.equal(readConversationEpoch(f.root,'codex','native'),1);
});

test('native and web conversations cannot be selected by the other app',t=>{
 const f=fixture(t),native={id:crypto.randomUUID(),provider:'codex',execution:'native'};f.records.set(native.id,native);
 setCurrent(f.root,f.terminals,{provider:'codex',id:f.codex.id});
 setCurrent(f.root,f.terminals,{scope:'native',provider:'codex',id:native.id});const before=fs.readFileSync(f.file,'utf8');
 assert.throws(()=>setCurrent(f.root,f.terminals,{scope:'native',provider:'codex',id:f.codex.id}),/different app/);
 assert.throws(()=>setCurrent(f.root,f.terminals,{provider:'codex',id:native.id}),/different app/);
 assert.equal(fs.readFileSync(f.file,'utf8'),before);
 assert.equal(taskInScope(native,'native'),true);assert.equal(taskInScope(native),false);
 assert.equal(taskInScope(f.codex),true);assert.equal(taskInScope(f.codex,'native'),false);
 assert.equal(taskInScope(undefined),false);
 for(const scope of ['web','native']){
  assert.equal(taskInScope(f.script,scope),true);
  assert.throws(()=>setCurrent(f.root,f.terminals,{scope,provider:'codex',id:f.script.id}),/not a voice conversation/);
 }
});

test('invalid app scopes and invalid scoped persistence fail without changing the saved state',t=>{
 const f=fixture(t);setCurrent(f.root,f.terminals,{provider:'codex',id:f.codex.id});const before=fs.readFileSync(f.file,'utf8');
 for(const scope of ['obsidian','__proto__','',null]){
  assert.throws(()=>readCurrentState(f.root,scope),/app/);
  assert.throws(()=>setCurrent(f.root,f.terminals,{scope,provider:'codex',id:null}),/app/);
 }
 assert.equal(fs.readFileSync(f.file,'utf8'),before);
 for(const invalid of [undefined,{revision:0,current:{codex:null,claude:'broken'}},{revision:0,current:{codex:null,claude:null},contextEpochs:{codex:-1,claude:0}}]){
  const saved=JSON.parse(before);saved.scopes.native=invalid;fs.writeFileSync(f.file,JSON.stringify(saved));
  assert.throws(()=>readCurrentState(f.root,'native'),/conversation/);
  assert.throws(()=>setCurrent(f.root,f.terminals,{provider:'codex',id:null}),/conversation/);
 }
});
