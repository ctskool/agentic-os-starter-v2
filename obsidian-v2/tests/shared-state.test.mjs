import test from 'node:test';
import assert from 'node:assert/strict';
import {createPollStore} from '../shared/poll-store.mjs';
import {createResourceCache} from '../shared/resource-cache.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};

test('multiple provider consumers share one timer/request and release polling on last unsubscribe',async()=>{
 let loads=0,starts=0,stops=0,events=0;const pending=deferred();
 const store=createPollStore({initial:'claude',load:()=>{loads++;return pending.promise},startTimer:()=>{starts++;return 1},stopTimer:()=>stops++,onStart:()=>{events++;return()=>events--}});
 const offA=store.subscribe(()=>{}),offB=store.subscribe(()=>{}),offC=store.subscribe(()=>{});
 const a=store.refresh(),b=store.refresh();assert.equal(a,b);
 await Promise.resolve();assert.equal(loads,1);assert.equal(starts,1);
 pending.resolve('codex');await a;assert.equal(store.getSnapshot(),'codex');
 offA();offB();assert.equal(stops,0);offC();assert.equal(stops,1);assert.equal(events,0);
});
test('a slow old poll cannot undo a newly saved provider selection',async()=>{
 const pending=deferred();const store=createPollStore({initial:'claude',load:()=>pending.promise});
 const poll=store.refresh();store.publish('codex');pending.resolve('claude');await poll;
 assert.equal(store.getSnapshot(),'codex');
});
test('metrics reads share in-flight work, expire, isolate vaults, and recover after failure',async()=>{
 let now=0,loads=0;const cache=createResourceCache(10000,()=>now);const load=async()=>++loads;
 assert.deepEqual(await Promise.all([cache.read('vault-a',load),cache.read('vault-a',load)]),[1,1]);
 assert.equal(await cache.read('vault-b',load),2);assert.equal(await cache.read('vault-a',load),1);
 now=10001;assert.equal(await cache.read('vault-a',load),3);
 cache.invalidate('vault-a');await assert.rejects(cache.read('vault-a',async()=>{throw new Error('offline')}),/offline/);
 assert.equal(await cache.read('vault-a',load),4);
});
test('invalidation during an old read cannot poison the newer metrics snapshot',async()=>{
 const cache=createResourceCache(10000),old=deferred();const first=cache.read('vault',()=>old.promise);
 cache.invalidate('vault');assert.equal(await cache.read('vault',async()=> 'new'),'new');
 old.resolve('old');await first;assert.equal(await cache.read('vault',async()=> 'unexpected'),'new');
});
