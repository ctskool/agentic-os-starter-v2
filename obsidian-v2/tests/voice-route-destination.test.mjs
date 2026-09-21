import test from 'node:test';
import assert from 'node:assert/strict';
import {rules} from '../runner/voice-router.mjs';

for(const engine of ['luna','haiku']){
 test(`${engine}: a worker decision cannot be replaced by a suggested workspace action`,()=>{
  // These report suggestions were captured from the real Haiku classifier.
  for(const obsidian of [{op:'report',target:'voice-ask'},{op:'report',target:'morning-intel',where:'tab'},{op:'open-note',query:'that output'},{op:'command',id:'arbitrary:delete'}]){
   const result=rules.validateRouted({tier:3,reply:'Continuing the selected work.',obsidian},engine,'Could you show me the result?');
   assert.equal(result.tier,3);assert.equal(result.obsidian,undefined);assert.equal(result.deliverable,undefined);assert.equal(result.write,undefined);
  }
 });
 test(`${engine}: invalid work and mixed writes still fail validation`,()=>{
  for(const parsed of [{tier:3,reply:''},{tier:3,reply:'x'.repeat(901)},{tier:3,reply:'Done',write:{kind:'top3',index:1}}])assert.equal(rules.validateRouted(parsed,engine,'check the first priority'),null);
 });
 test(`${engine}: explicit tier-two note navigation retains its validated action`,()=>{
  const result=rules.validateRouted({tier:2,reply:'',obsidian:{op:'open-note',query:'Project plan.md'}},engine,'Open Project plan.md');
  assert.equal(result.tier,2);assert.equal(result.obsidian.query,'Project plan.md');
 });
}
