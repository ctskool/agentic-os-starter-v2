import test from 'node:test';
import assert from 'node:assert/strict';
import {directGeneralWork} from '../runner/lookup-fallback.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {classifyVoice} from '../runner/voice-router.mjs';

test('clear general delegation needs a concrete request and preserves deferred/capability questions',()=>{
 for(const text of ['Create a PDF about the RubyGems incident','Can you create a visual document about that story?','Research RubyGems and draft a launch email','Please write a comparison of the two deployment approaches'])assert.equal(directGeneralWork(text),true,text);
 for(const text of ['Create nothing for now','Write no code until I approve','Create a report only after I confirm','Can you write code?','Can you create PDFs?','Are you able to research any topic?','Could you create some sort of visual document?','Create a report, actually cancel that','Create a report or just explain the topic','Create a report if the numbers are ready','Run morning intel','Research my leads','Pull metrics','Can you explain how to create the diagram?'])assert.equal(directGeneralWork(text),false,text);
});

function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'lookup-context-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=(relative,value)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
 write('system/v2/voice-results/previous.json',{ts:Date.now()-100,provider:'codex',workTarget:'project-a',tier:1,transcript:'What was the main story today?',reply:'UNRELATED_REPORT_SENTINEL',lookup:{source:'brief'}});
 return {root,write};
}
test('direct work stays inside its captured conversation; explicit new reference can carry the last quick answer',async t=>{
 const {root}=fixture(t),base={id:'lookup-test',chosen:{provider:'codex',model:'gpt-6-astra'},execute:()=>assert.fail('No classifier')};
 const other=await classifyVoice(root,{...base,transcript:'Create a chart about project B',workTarget:'project-b'});
 assert.equal(other.tier,3);assert.doesNotMatch(other.context,/UNRELATED_REPORT_SENTINEL/);
 const explicit=await classifyVoice(root,{...base,transcript:'Create a document about that story',workTarget:null,newConversation:true});
 assert.match(explicit.context,/UNRELATED_REPORT_SENTINEL/);
});
test('scoped metric answers do not expose data-file links or unrelated saved report context',async t=>{
 const {root,write}=fixture(t);
 write('system/metrics/metrics.csv',`timestamp,source,metric,value,status,error\n${new Date().toISOString()},instagram,followers,42,ok,\n`);
 const result=await classifyVoice(root,{id:'lookup-test',chosen:{provider:'codex',model:'gpt-6-astra'},transcript:'What does my Instagram follower count mean?',workTarget:'project-a',terminals:{list:()=>assert.fail('No dashboard task snapshot')},execute:async(_root,_job,_prompt,options)=>{
  assert.doesNotMatch(options.system,/UNRELATED_REPORT_SENTINEL/);assert.match(options.system,/"value":42/);
  return {text:JSON.stringify({tier:2,reply:'The saved reading says your Instagram account has 42 followers.'})};
 }});
 assert.equal(result.deliverable,null);assert.equal(result.lookupRoute,'scoped-model');
});
