import test from 'node:test';
import assert from 'node:assert/strict';
import {fullAnswer} from '../lib/work';
test('opening the same long answer shares its fetch and returns the complete text',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async url=>{calls++;assert.match(String(url),/\/work\/answer\?id=task&turn=turn/);return new Response(JSON.stringify({text:'x'.repeat(3000)}))};
 try{const task={id:'task',turns:[{id:'turn',ts:1,text:'x'.repeat(650),truncated:true}]} as any;
  const [a,b]=await Promise.all([fullAnswer(task),fullAnswer(task)]);assert.equal(a.length,3000);assert.equal(a,b);assert.equal(calls,1);
 }finally{globalThis.fetch=original}
});
