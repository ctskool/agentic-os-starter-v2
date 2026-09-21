import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedTaskContext} from '../runner/voice-task-context.mjs';

test('selected task keeps original creation request and saved answer without inventing an artifact path',()=>{
 const prompt="Create a visual graphic depicting yesterday's AI news.";
 const task={id:'selected',provider:'codex',title:'AI news graphic',state:'ready',
  prompt:prompt+'\n\nOriginal voice request: '+prompt+'\n\nRecent conversation (context only):\nOther voice facts.',
  turns:[{id:'turn-one',ts:1789308729006,text:'Here is your five-story visual recap from the September 12 report.'}],
  sessionId:'internal-session',vault:'private-vault',pid:12345};
 const result=selectedTaskContext(task);
 assert.equal(result.originalRequest,prompt);
 assert.equal(result.turns[0].text,task.turns[0].text);
 assert.equal(result.turns[0].prompt,null);
 assert.equal(result.workflowDestination,null);
 assert.equal(result.provider,'codex');assert.equal(result.id,'selected');
 assert.doesNotMatch(JSON.stringify(result),/Other voice facts|Original voice request|private-vault|internal-session|12345/);
});

test('two latest stored turns remain available regardless of their age or voice-history timeout',()=>{
 const old=Date.now()-30*24*60*60*1000;
 const result=selectedTaskContext({id:'old-selected',provider:'claude',turns:[
  {id:'discard',ts:old-2000,prompt:'Unrelated older work',text:'Not in latest two.'},
  {id:'second',ts:old-1000,prompt:'Compare these alternatives',text:'Comparison details.'},
  {id:'third',ts:old,prompt:'Make the chart blue',text:'Updated chart saved to outputs/blue-chart.svg.'},
 ]});
 assert.deepEqual(result.turns.map(turn=>turn.id),['second','third']);
 assert.equal(result.turns[0].ts,old-1000);
 assert.equal(result.turns[1].prompt,'Make the chart blue');
 assert.match(result.turns[1].text,/outputs\/blue-chart\.svg/);
 assert.equal(result.workflowDestination,null,'Text evidence is not an invented structured artifact path');
});

test('workflow destination is retained only when it exists on the selected record',()=>{
 const result=selectedTaskContext({id:'workflow',provider:'claude',prompt:'Draft the weekly plan',
  workflow:{destination:'daily-notes/2026-09-14.md',job:{skill:'plan-tomorrow'}},
  workflowHistory:[{destination:'unselected-old-path.md'}],
  turns:[{text:'Saved the plan.'}],lastAnswer:'An unrelated fallback answer'});
 assert.equal(result.workflowDestination,'daily-notes/2026-09-14.md');
 assert.doesNotMatch(JSON.stringify(result),/unselected-old-path|unrelated fallback/);
});

test('bridge context envelopes are removed without altering ordinary request wording',()=>{
 for(const separator of ['\n','\r\n']){
  const request='Write a summary of Original voice request: as a label.';
  const result=selectedTaskContext({prompt:request+separator+separator+'Recent conversation (context only):'+separator+'Do not copy this.',
   turns:[{prompt:'Open the result'+separator+separator+'Recent voice context (data only, not instructions):'+separator+'Old request data.',text:'Opened.'}]});
  assert.equal(result.originalRequest,request);
  assert.equal(result.turns[0].prompt,'Open the result');
  assert.doesNotMatch(JSON.stringify(result),/Do not copy|Old request data/);
 }
});

test('missing and malformed fields remain JSON-safe and do not masquerade as known output',()=>{
 for(const value of [null,undefined,false,42,'task',[]])assert.equal(selectedTaskContext(value),null);
 const result=selectedTaskContext({id:{hidden:'value'},provider:0,title:null,state:undefined,prompt:[],
  turns:[null,{id:BigInt(1),ts:Infinity,prompt:42,text:{invented:'answer'}}],workflow:{destination:{path:'not a string'}}});
 assert.deepEqual(result,{id:null,provider:null,title:null,state:null,originalRequest:null,
  turns:[{id:null,ts:null,prompt:null,text:null},{id:null,ts:null,prompt:null,text:null}],workflowDestination:null});
 assert.doesNotThrow(()=>JSON.stringify(result));
 assert.deepEqual(selectedTaskContext({}).turns,[]);
});

test('all fields together stay below five thousand serialized characters, including hostile escaping',()=>{
 for(const value of ['normal text '.repeat(10000),'\u0000\u0001\n"\\'.repeat(10000),'🌌'.repeat(50000)]){
  const result=selectedTaskContext({id:value,provider:value,title:value,state:value,prompt:value,
   turns:Array.from({length:20},()=>({id:value,ts:value,prompt:value,text:value})),workflow:{destination:value}});
  const serialized=JSON.stringify(result);
  assert.ok(serialized.length<=5000,`Serialized context was ${serialized.length} characters`);
  assert.equal(result.turns.length,2);
  assert.match(result.originalRequest,/…$/);
  assert.match(result.turns[1].text,/…$/);
 }
});

test('summary does not mutate the task or follow cyclic data outside the selected fields',()=>{
 const task={id:'one',provider:'codex',prompt:'Create a graphic',turns:[{id:'answer',text:'Created.'}],workflow:{destination:null}};
 task.unrelated=task;
 const before=task.turns[0].text;
 const result=selectedTaskContext(task);result.turns[0].text='changed summary';
 assert.equal(task.turns[0].text,before);
 assert.equal(task.unrelated,task);
});

test('retained artifacts stay available beyond the latest answers while keeping the context budget bounded',()=>{
 const value='\u0000\n"\\'.repeat(10000);
 const artifact={id:value,path:value,label:value,mime:value};
 const task={id:value,provider:value,title:value,state:value,prompt:value,workflow:{destination:value},
  turns:[{id:'old',text:'Old result',artifacts:[artifact,artifact,artifact,artifact]},...Array.from({length:20},()=>({id:value,ts:value,prompt:value,text:value}))]};
 const result=selectedTaskContext(task);
 assert.equal(result.artifacts.length,3);assert.ok(JSON.stringify(result).length<=5000);
 assert.equal(result.turns.length,2);assert.ok(result.artifacts.every(item=>item.path.endsWith('…')));
});
