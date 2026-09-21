import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const built=await build({entryPoints:['shared/voice-turn-taking.ts'],bundle:true,platform:'node',format:'esm',outdir:'unused',write:false});
const {VoiceCaptureGate}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));

// The orb samples the microphone on a DOM timer. A hidden or busy window can
// stretch the 80 ms cadence to hundreds of milliseconds or a full second;
// continuous speech must still qualify instead of expiring as silence.
function drive(step,loud,until=6000){
 const gate=new VoiceCaptureGate(0);let firstSpeech=null,result=null;
 for(let now=0;now<=until&&!result;now+=step){result=gate.update(loud(now)?0.15:0,now);if(firstSpeech===null&&gate.heardSpeech)firstSpeech=now}
 return {gate,firstSpeech,result};
}
const speaking=(from,to)=>now=>now>=from&&now<to;

test('the ideal 80 ms cadence is unchanged: speech qualifies after 160 ms and finishes after the 1.6-second pause',()=>{
 const run=drive(80,speaking(300,1500));
 assert.equal(run.firstSpeech,480);assert.equal(run.result,'finish');
});

test('continuous speech sampled every 200 ms, 500 ms or 1000 ms still qualifies within the five-second budget',()=>{
 for(const step of [200,500,1000]){
  const run=drive(step,speaking(300,4800));
  assert.equal(run.gate.heardSpeech,true,`cadence ${step}`);assert.ok(run.firstSpeech<=2000,`cadence ${step} qualified at ${run.firstSpeech}`);
  assert.notEqual(run.result,'quiet',`cadence ${step}`);
 }
});

test('isolated clicks separated by observed silence still expire quietly at every cadence',()=>{
 for(const step of [80,200,1000]){
  const gate=new VoiceCaptureGate(0);let result=null;
  for(let now=0;now<=5200&&!result;now+=step)result=gate.update(now===step*3||now===step*9?0.15:0,now);
  assert.equal(gate.heardSpeech,false,`cadence ${step}`);assert.equal(result,'quiet',`cadence ${step}`);
 }
});

test('a single stalled sample inside a speech run does not restart the run',()=>{
 const gate=new VoiceCaptureGate(0);const times=[0,80,160,240,320,400,650,730,810];
 let first=null;for(const now of times){gate.update(now>=240?0.15:0,now);if(first===null&&gate.heardSpeech)first=now}
 assert.equal(first,400);
});
