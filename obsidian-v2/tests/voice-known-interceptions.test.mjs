import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {routeVoice} from '../runner/bridge-core.mjs';

// Known keyword-lookup interceptions, pinned so they are not forgotten. All are
// marked todo: they document today's behavior without failing the suite, and
// start passing when the lookup boundary is hedged (integration plan, D4).
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-known-interceptions-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const calls=[],tasks=[],selection={provider:'codex',model:'gpt-6-astra'};
 const terminals={live:new Map(),list:()=>tasks,get:id=>tasks.find(task=>task.id===id),
  start(options){calls.push({kind:'start'});return {id:options.id}},
  startWorkflow(options){calls.push({kind:'workflow',skill:options.skill,args:options.args});return {id:options.id}}};
 const speak=(transcript,answer)=>routeVoice(root,{id:crypto.randomUUID(),transcript,selection,terminalMode:true},undefined,async()=>({text:JSON.stringify(answer)}),terminals,{resolveCli:()=>({command:'unused-test-cli',prefix:[]}),updateCurrent:()=>{}});
 return {calls,speak};
}
test('a placement request that mentions the calendar opens it instead of reading the schedule',{todo:'saved-schedule lookup claims any sentence containing "calendar"'},async t=>{
 const fx=fixture(t);
 const receipt=await fx.speak('I need the workspace to display my calendar in the right sidebar.',{tier:2,reply:'',obsidian:{op:'open-note',query:'calendar',where:'right'}});
 assert.ok(receipt.obsidian,'expected a UI action, not a spoken schedule answer');
});
test('a URL supplied after a workflow clarification reaches that workflow even when the URL contains lookup words',{todo:'brief lookup claims any sentence containing "story", including inside a URL'},async t=>{
 const fx=fixture(t);
 await fx.speak('The Content Cascade workflow is what I want you to execute, but I have not supplied a URL yet.',{tier:1,skill:'content-cascade',reply:'On it.'});
 await fx.speak('Here it is: https://example.com/story',{tier:1,skill:'content-cascade',args:{url:'https://example.com/story'},reply:'Starting.'}).catch(()=>{});
 assert.deepEqual(fx.calls,[{kind:'workflow',skill:'content-cascade',args:{url:'https://example.com/story'}}]);
});
test('a request to see a vault note is not answered from the inbox section of the morning brief',{todo:'inbox-section lookup claims any sentence containing "sponsor"'},async t=>{
 const fx=fixture(t);
 const receipt=await fx.speak('Can I see the sponsor playbook?',{tier:2,reply:'',obsidian:{op:'open-note',query:'sponsor playbook'}});
 assert.notEqual(receipt.decision?.rule,'lookup.section','the brief reader answered a request to open a note');
});
