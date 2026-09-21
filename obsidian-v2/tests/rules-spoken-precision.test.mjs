import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url),{rulesRoute}=jiti('../runner/voice-rules.ts'),{speechText}=jiti('../shared/speech-text.ts');
const state={generated_at:new Date().toISOString(),vault_root:'.',metrics:[],runner:null,latestVideo:null,daily:null,runs:[],queue:[],morning:null,outliers:null,trendingRepos:[],etas:{}};
const metric=(source,name,value)=>({source,metric:name,value,status:'ok',timestamp:new Date().toISOString(),history:[],delta:null,deltaWeek:null});
test('legacy local revenue replies retain cents before reaching speech normalization',()=>{
 for(const value of [0.75,4200.50]){
  const result=rulesRoute('What is my revenue?',{...state,metrics:[metric('stripe','mrr',value)]});
  assert.equal(result.engine,'rules');assert.ok(result.reply.includes('$'+value),result.reply);
  const spoken=speechText(result.reply);assert.match(spoken,value===0.75?/seventy five cents/:/four thousand two hundred dollars and fifty cents/);
 }
});
test('legacy dashboard count answers preserve the exact saved reading',()=>{
 const result=rulesRoute('How many YouTube subscribers do I have?',{...state,metrics:[metric('youtube','subscribers',43127)]});
 assert.equal(result.engine,'rules');assert.match(result.reply,/43127/);assert.doesNotMatch(result.reply,/43 thousand/);
});
