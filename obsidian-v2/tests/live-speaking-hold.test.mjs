// The orb must not flip between speaking and listening in the gaps between Live's words (2026-11-22).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{fsCache:false});
const {speakingHold,SPEAKING_HOLD_MS}=jiti('../shared/live-session.ts');

const run=levels=>{let until=0;return levels.map((level,index)=>{const step=speakingHold(until,level,index*125);until=step.until;return step.speaking})};

test('speech with gaps between words stays "speaking" the whole time', () => {
 // Loud, silent, loud, silent… sampled every 125 ms, as the renderer does.
 const states=run([.3,0,.2,.01,0,.4,0,.02,.3,0]);
 assert.deepEqual(states,states.map(()=>true));
});

test('it returns to "listening" once Live has been quiet for the hold time', () => {
 const quietSamples=Math.ceil(SPEAKING_HOLD_MS/125)+1;
 const states=run([.3,...Array(quietSamples).fill(0)]);
 assert.equal(states[0],true);
 assert.equal(states.at(-1),false);
 assert.equal(states.filter((speaking,index)=>index>0&&!speaking&&states[index-1]===false&&states[index+1]===true).length,0,'no flicker back');
});

test('silence from the start is "listening"', () => {
 assert.deepEqual(run([0,.01,.04]),[false,false,false]);
});
