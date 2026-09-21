import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startLifecycle} from '../runner/lifecycle.mjs';

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'v2-lifecycle-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let heartbeat,unref=0,stops=0,now=0;
 const timer={unref(){unref++}};
 const options={now:()=>now,processInfo:()=>({pid:123,uptimeSeconds:30,rssMiB:42}),startTimer(callback,delay){assert.equal(delay,30000);heartbeat=callback;return timer},stopTimer(value){assert.equal(value,timer);stops++}};
 const read=()=>fs.readFileSync(path.join(root,'bridge-lifecycle.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 return {root,options,read,tick(){now+=30000;heartbeat()},stats:()=>({unref,stops})};
}
test('lifecycle logs bounded operational fields and does not retain prompts, tokens or vault content',t=>{
 const f=fixture(t),log=startLifecycle(f.root,{service:'bridge',version:'0.3.20',prompt:'SECRET_PROMPT',token:'SECRET_TOKEN',providers:{codex:{command:'C:/tools/codex.exe',version:'1.2.3',token:'SECRET_PROVIDER_TOKEN'}}},f.options);
 f.tick();log.mark('listening',{port:3219,transcript:'SECRET_TRANSCRIPT',vault:'SECRET_VAULT'});log.stop('SIGTERM');log.stop('again');f.tick();log.mark('after-stop');
 const records=f.read();assert.deepEqual(records.map(r=>r.event),['boot','heartbeat','listening','shutdown']);assert.deepEqual(f.stats(),{unref:1,stops:1});
 assert.equal(records[0].providers.codex.version,'1.2.3');assert.equal(records[1].rssMiB,42);assert.equal(records[2].port,3219);assert.equal(records[3].reason,'SIGTERM');assert.doesNotMatch(JSON.stringify(records),/SECRET_/);
});
test('next boot reports the previous last event without claiming an abrupt exit was a crash',t=>{
 const f=fixture(t),first=startLifecycle(f.root,{},f.options);f.tick();
 const second=startLifecycle(f.root,{},f.options);const boot=f.read().at(-1);assert.deepEqual(boot.previous,{event:'heartbeat',pid:123,ts:'1970-01-01T00:00:30.000Z',shutdownObserved:false});assert.equal(boot.crashed,undefined);
 second.stop('clean');first.stop('clean');const third=startLifecycle(f.root,{},f.options);assert.equal(f.read().at(-1).previous.shutdownObserved,true);third.stop();
});
test('rotation keeps only current and one previous bounded log',t=>{
 const f=fixture(t),log=startLifecycle(f.root,{}, {...f.options,maxBytes:1024});
 for(let i=0;i<100;i++)log.mark('status',{code:i,status:'x'.repeat(160)});
 log.stop();const names=fs.readdirSync(f.root).sort();assert.deepEqual(names,['bridge-lifecycle.jsonl','bridge-lifecycle.previous.jsonl']);
 for(const name of names)assert.ok(fs.statSync(path.join(f.root,name)).size<=1024);assert.equal(f.read().at(-1).event,'shutdown');
});
test('filesystem failures and malformed event fields are nonfatal',t=>{
 const f=fixture(t),blocked=path.join(f.root,'file');fs.writeFileSync(blocked,'not a directory');
 assert.doesNotThrow(()=>{const log=startLifecycle(blocked,{},f.options);f.tick();log.mark('error',{code:'EIO'});log.stop()});
 const log=startLifecycle(f.root,{},f.options);log.mark('an event containing task text');log.mark('error',{get reason(){throw new Error('getter')}});assert.equal(f.read().length,1);log.stop();
});
