import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {startPreviewSnapshots} from '../preview/snapshots.mjs';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('preview mounts without credentials and its snapshot recovers after bridge startup',async()=>{
 const entry=fs.readFileSync(new URL('../preview/entry.tsx',import.meta.url),'utf8');
 assert.ok(entry.indexOf('render(<Cockpit')<entry.indexOf('const stopSnapshots=startPreviewSnapshots('));
 assert.doesNotMatch(entry,/await rpc\(['"]snapshot['"]\)/);
 let tick,calls=0,cleared=false;
 const snapshots=[],statuses=[];
 const stop=startPreviewSnapshots({
  load:async()=>{if(++calls===1)throw new Error('Bridge authentication unavailable');return {'daily-notes/today.md':'Current plan'}},
  apply:value=>snapshots.push(value),status:value=>statuses.push(value),
  schedule:callback=>{tick=callback;return 42},unschedule:id=>{assert.equal(id,42);cleared=true}
 });
 await settle();
 assert.equal(calls,1);assert.equal(snapshots.length,0);
 assert.match(statuses.at(-1),/Waiting for V2 bridge.*retrying automatically.*authentication unavailable/);
 tick();await settle();
 assert.deepEqual(snapshots,[{'daily-notes/today.md':'Current plan'}]);
 assert.equal(statuses.at(-1),'Connected vault · Live V2 bridge');
 stop();assert.equal(cleared,true);tick();await settle();assert.equal(calls,2);
});

test('snapshot retries do not overlap or replace the last good data on restart failure',async()=>{
 let tick,resolveRead,rejectRead,calls=0;
 const snapshots=[],statuses=[];
 const stop=startPreviewSnapshots({
  load:()=>{calls++;return new Promise((resolve,reject)=>{resolveRead=resolve;rejectRead=reject})},
  apply:value=>snapshots.push(value),status:value=>statuses.push(value),schedule:callback=>{tick=callback;return 1},unschedule:()=>{}
 });
 tick();tick();assert.equal(calls,1);
 resolveRead({saved:'first'});await settle();
 tick();assert.equal(calls,2);
 rejectRead(new Error('Bridge restarting'));await settle();
 assert.deepEqual(snapshots,[{saved:'first'}]);
 assert.match(statuses.at(-1),/retrying automatically.*Bridge restarting/);
 tick();assert.equal(calls,3);
 stop();resolveRead({saved:'late'});await settle();
 assert.deepEqual(snapshots,[{saved:'first'}]);
 assert.match(statuses.at(-1),/Bridge restarting/);
});
