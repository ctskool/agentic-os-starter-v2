import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {waitForResponseDrain} from '../runner/stream-backpressure.mjs';

test('repeated audio backpressure drains do not accumulate response close listeners',async()=>{
 const response=new EventEmitter();let upstreamAborts=0;const abortUpstream=()=>upstreamAborts++;response.on('close',abortUpstream);
 for(let cycle=0;cycle<32;cycle++){
  const pending=waitForResponseDrain(response);assert.equal(response.listenerCount('drain'),1);assert.equal(response.listenerCount('close'),2);assert.equal(response.listenerCount('error'),1);
  response.emit('drain');assert.equal(await pending,true);
  assert.equal(response.listenerCount('drain'),0);assert.equal(response.listenerCount('close'),1);assert.equal(response.listenerCount('error'),0);
 }
 assert.equal(upstreamAborts,0);response.emit('close');assert.equal(upstreamAborts,1,'the stream cancellation listener is preserved');
});

test('a disconnected response resolves the pending drain and removes both race listeners',async()=>{
 const response=new EventEmitter(),pending=waitForResponseDrain(response);response.destroyed=true;response.emit('close');assert.equal(await pending,false);
 assert.equal(response.listenerCount('drain'),0);assert.equal(response.listenerCount('close'),0);assert.equal(response.listenerCount('error'),0);
 response.emit('drain');assert.equal(await waitForResponseDrain(response),false);assert.equal(response.eventNames().length,0);
 const ended=new EventEmitter();ended.writableEnded=true;assert.equal(await waitForResponseDrain(ended),false);assert.equal(ended.eventNames().length,0);
});

test('a response write error rejects the wait and removes unused drain and close listeners',async()=>{
 const response=new EventEmitter(),pending=waitForResponseDrain(response),error=new Error('Fixture stream write failed');response.emit('error',error);
 await assert.rejects(pending,error);assert.equal(response.eventNames().length,0);
});
