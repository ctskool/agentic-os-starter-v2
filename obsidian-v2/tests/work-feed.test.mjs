import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkFeed,taskSummary} from '../shared/work-feed.mjs';
import {createResourceCache} from '../shared/resource-cache.mjs';

test('background button jobs stay off the terminal feed without changing selected conversations',async()=>{
 const current={codex:'terminal',claude:null},feed=createWorkFeed(async()=>({current,currentRevision:3,tasks:[{id:'terminal'},{id:'native',execution:'native'},{id:'skill',execution:'headless'},{id:'refresh',execution:'script',background:true}]}));
 await feed.refresh();assert.deepEqual(feed.getSnapshot().tasks.map(task=>task.id),['terminal','native']);assert.deepEqual(feed.getSnapshot().current,current);
 assert.equal(taskSummary({id:'refresh',execution:'script',background:true,turns:[]}).background,true);
});

test('voice and terminal consumers share one request and preserve tasks during outages',async()=>{
 let calls=0,fail=false;
 const feed=createWorkFeed(async path=>{calls++;assert.equal(path,'?summary=1');if(fail)throw new Error('Offline');return {vault:'vault',tasks:[{id:'one'}]}});
 const a=feed.subscribe(()=>{}),b=feed.subscribe(()=>{});
 try{await Promise.all([feed.refresh(),feed.refresh()]);assert.equal(calls,1);fail=true;await feed.refresh();assert.equal(feed.getSnapshot().tasks[0].id,'one');assert.match(feed.getSnapshot().error,/Offline/)}finally{a();b()}
});
test('task summaries bound answer payloads without changing full saved conversations',()=>{
 const task={id:'one',provider:'codex',prompt:'private prompt',workflow:{job:{prompt:'large instructions'}},turns:Array.from({length:30},(_,i)=>({id:String(i),ts:i,text:'a'.repeat(100000)}))};
 const summary=taskSummary(task);
 assert.equal(summary.turns.length,1);assert.equal(summary.turns[0].id,'29');assert.equal(summary.turns[0].text.length,650);assert.equal(summary.turns[0].truncated,true);
 assert.equal(task.turns.length,30);assert.equal(task.turns[29].text.length,100000);assert.equal(summary.prompt,undefined);assert.equal(summary.workflow,undefined);
 assert.ok(JSON.stringify(summary).length<1000);
});
test('resource caches bound retained entries instead of accumulating every old answer',async()=>{
 const cache=createResourceCache(30000,()=>0,2);
 await cache.read('a',async()=>1);await cache.read('b',async()=>2);await cache.read('c',async()=>3);
 assert.equal(await cache.read('a',async()=>4),4);
});
