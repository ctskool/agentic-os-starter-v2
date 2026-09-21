import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {hedgeClassifier,readJevConfig,jevState,jevRequestBody,classifyJev,JEV_REVISION,JEV_ACK} from '../runner/jev.mjs';
import {openIntentGiven} from '../runner/voice-targets.mjs';
import {parseUiIntent} from '../runner/voice-ui-intent.mjs';

const tick=(ms=0)=>new Promise(resolve=>setTimeout(resolve,ms));
const config=(fields={})=>({key:'sk-or-test-key-000000',mode:{codex:'fastpath',claude:'fastpath'},theta:0.9,deadlineMs:600,tier2kind:false,rulebook:'v1',openVeto:false,...fields});
const decision=(fields={})=>({route:'tier3',tier:3,skill:null,p:0.98,kind:null,revision:JEV_REVISION,pinned:true,ms:5,socketReused:true,...fields});
function model(text='{"tier":2,"reply":"","obsidian":{"op":"open-note","query":"projects/archive/channel-growth-strategy.md"}}',ms=30){
 const seen={aborted:false};
 return {seen,run:signal=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>resolve({text}),ms);signal?.addEventListener('abort',()=>{clearTimeout(timer);seen.aborted=true;reject(new Error('Voice request cancelled'))},{once:true})})};
}
const hedge=(transcript,fields={})=>{const logs=[],asked=[];return {logs,asked,result:hedgeClassifier({root:'unused',id:'request-1',provider:'codex',state:()=>jevState({transcript}),validate:()=>true,config:config(),classify:async(_state,options)=>{asked.push(options);return decision()},log:(_root,_id,_boundary,entry)=>logs.push(entry),...fields})}};
const read=saved=>readJevConfig({env:{},read:()=>({key:'sk-or-test-key-000000',mode:'fastpath',theta:0.9,...saved})});

test('both settings default to today\'s behaviour and accept only their exact values',()=>{
 assert.equal(read({}).rulebook,'v1');assert.equal(read({}).openVeto,false);
 assert.equal(read({rulebook:'v2',openVeto:true}).rulebook,'v2');assert.equal(read({rulebook:'v2',openVeto:true}).openVeto,true);
 for(const junk of ['V2','2',2,true,null,{},'v3'])assert.equal(read({rulebook:junk}).rulebook,'v1');
 for(const junk of ['true',1,'on',null,{}])assert.equal(read({openVeto:junk}).openVeto,false);
 // Under the test runner the real file is never read, and everything is off.
 assert.deepEqual(readJevConfig(),{key:'',mode:{codex:'off',claude:'off'},theta:null,deadlineMs:600,tier2kind:false,rulebook:'v1',openVeto:false});
});

test('the v1 rulebook text is the text the parent commit sent (fingerprint taken from b87763f)',()=>{
 const body=jevRequestBody(jevState({transcript:'make a guide'}),{tier2kind:true}),route=body.questions.route;
 // Every threshold so far was measured with exactly this text. If this fails, v1 was edited: re-qualify, do not re-hash.
 assert.equal(crypto.createHash('sha256').update(JSON.stringify([route.instructions,route.criteria.tier2,route.criteria.tier3,body.questions.tier2kind])).digest('hex'),'27452be20d658fbfd507686165b63cb62fddae087c8bc55a1389c1d1df9f4ba7');
});

test('rulebook v1 is the unchanged request; v2 only appends to the two tier descriptions',()=>{
 const state=jevState({transcript:'Use your image tool to explain the new model.',reports:['morning-intel']});
 for(const tier2kind of [false,true]){
  const implicit=jevRequestBody(state,{tier2kind}),v1=jevRequestBody(state,{tier2kind,rulebook:'v1'}),v2=jevRequestBody(state,{tier2kind,rulebook:'v2'});
  assert.equal(JSON.stringify(v1),JSON.stringify(implicit));
  assert.equal(JSON.stringify(jevRequestBody(state,{tier2kind,rulebook:'anything else'})),JSON.stringify(implicit));
  const a=v1.questions.route.criteria,b=v2.questions.route.criteria;
  assert.deepEqual(Object.keys(b),Object.keys(a));
  for(const key of Object.keys(a)){
   if(key==='tier2'||key==='tier3'){assert.ok(b[key].startsWith(a[key]));assert.ok(b[key].length>a[key].length)}
   else assert.equal(b[key],a[key]);
  }
  assert.match(b.tier3,/something NEW to be produced/);assert.match(b.tier2,/already exists/);assert.match(b.tier2,/Declining an offer/);
  assert.doesNotMatch(a.tier3,/NEW to be produced/);
  // Nothing but those two strings differs.
  const rest=body=>JSON.stringify({...body,questions:{...body.questions,route:{...body.questions.route,criteria:{...body.questions.route.criteria,tier2:'',tier3:''}}}});
  assert.equal(rest(v2),rest(v1));
 }
});

test('classifyJev sends the v2 text only when asked to',async()=>{
 const sent=[];
 const request=(options,onResponse)=>({on(){},destroy(){},end(raw){sent.push(JSON.parse(raw));queueMicrotask(()=>{const handlers={};onResponse({statusCode:200,on(event,handler){handlers[event]=handler;if(event==='end')queueMicrotask(()=>{handlers.data?.(Buffer.from(JSON.stringify({model:JEV_REVISION,answers:{route:{type:'choice',choice:'tier3',probabilities:{tier3:0.97,tier2:0.03}}}})));handlers.end()})},resume(){}})})}});
 const state=jevState({transcript:'make a guide'});
 await classifyJev(state,{key:'sk-or-test-key-000000',request});
 await classifyJev(state,{key:'sk-or-test-key-000000',request,rulebook:'v2'});
 assert.doesNotMatch(sent[0].questions.route.criteria.tier3,/NEW to be produced/);
 assert.match(sent[1].questions.route.criteria.tier3,/NEW to be produced/);
});

test('the hedge passes the rulebook on and records it only when it is v2',async()=>{
 const before=hedge('make a guide',{run:model().run});await before.result;await tick(5);
 assert.equal('rulebook' in before.asked[0],false);assert.ok(before.logs.every(entry=>!('rulebook' in entry)));
 const after=hedge('make a guide',{run:model().run,config:config({rulebook:'v2'})});await after.result;await tick(5);
 assert.equal(after.asked[0].rulebook,'v2');assert.ok(after.logs.some(entry=>entry.rulebook==='v2'));
});

test('without the veto an open-shaped sentence still takes a confident shortcut, exactly as today',async()=>{
 const m=model(),{result,logs}=hedge('Show me channel growth strategy.',{run:m.run});
 const value=await result;await tick(5);
 assert.equal(value.exited,true);assert.deepEqual(JSON.parse(value.output.text),{tier:3,reply:JEV_ACK});
 assert.ok(logs.every(entry=>!(entry.excluded||[]).includes('openIntent')));
});

test('with the veto an open-shaped sentence never takes the shortcut: the model decides and is never cancelled',async()=>{
 for(const transcript of ['Show me channel growth strategy.','Could you show me B2B AI workshops?','Pop up evergreen rotation strategy.','I wanna see streamlit v2 port.','Can you pull up the launch checklist for me please?']){
  const m=model(),{result,logs,asked}=hedge(transcript,{run:m.run,config:config({openVeto:true})});
  const value=await result;await tick(5);
  assert.equal(value.exited,false,transcript);assert.equal(m.seen.aborted,false,transcript);
  assert.match(value.output.text,/open-note/,transcript);
  // Jev is still asked and still recorded, so the audit trail keeps its opinion.
  assert.equal(asked.length,1,transcript);
  assert.ok(logs.some(entry=>entry.excluded?.includes('openIntent')&&entry.earlyExit===false&&entry.jev?.route==='tier3'),transcript);
 }
});

test('with the veto, work that is not open-shaped keeps the shortcut',async()=>{
 for(const transcript of ['Use your image tool to show me how a transformer\'s attention layer works.','Can you use your image generation tool to sort of explain what this new model is and how it works?','Make me a one page guide comparing two editors.','I\'d love a little visual that walks through how the routing decides.','Show me how attention works as a diagram.']){
  const m=model(),{result,logs}=hedge(transcript,{run:m.run,config:config({openVeto:true,rulebook:'v2'})});
  const value=await result;await tick(5);
  assert.equal(value.exited,true,transcript);assert.ok(logs.every(entry=>!(entry.excluded||[]).includes('openIntent')),transcript);
 }
});

test('the veto adds to the existing exclusions and never removes one',async()=>{
 const m=model(),{result,logs}=hedge('Show me channel growth strategy.',{run:m.run,excluded:['compound'],config:config({openVeto:true})});
 const value=await result;await tick(5);
 assert.equal(value.exited,false);
 assert.deepEqual(logs.find(entry=>entry.excluded)?.excluded,['compound','openIntent']);
});

test('whatever the settings, shadow never exits early and off never asks Jev',async()=>{
 const shadow=hedge('Show me channel growth strategy.',{run:model().run,config:config({mode:{codex:'shadow',claude:'shadow'},openVeto:true,rulebook:'v2'})});
 const value=await shadow.result;await tick(5);
 assert.equal(value.exited,false);assert.equal(shadow.asked[0].rulebook,'v2');
 let classified=0;
 const off=await hedgeClassifier({root:'unused',id:'request-2',provider:'codex',state:()=>jevState({transcript:'Show me channel growth strategy.'}),validate:()=>true,config:config({mode:{codex:'off',claude:'off'},openVeto:true,rulebook:'v2'}),classify:async()=>{classified++;return decision()},run:model().run,log:()=>{}});
 assert.equal(off.exited,false);assert.equal(off.jev,null);assert.equal(classified,0);
});

// The veto runs before either classifier starts, on the event loop. It must stay fast on any input.
test('the open door answers in bounded time on runs of filler words that end in something else',()=>{
 const fillers=['on screen','on the screen','on my screen','up on screen','up on the screen','for me','please','thanks','thank you','jarvis','astra','again','real quick','really quick','quickly','right now','now','in obsidian','inside obsidian','inside of obsidian'];
 const leads=['hey','hi','hello','ok','okay','all right','alright','so','well','um','uh','jarvis','astra','please','just','now','also','actually','and','then','yeah','yes','no'];
 const hostile=['Can I see x'+' on screen'.repeat(24)+' z'];
 for(const filler of fillers)for(const tail of [' z','',' on',',']){let text='Can I see x';while((text+' '+filler+tail).length<=300)text+=' '+filler;hostile.push(text+tail);hostile.push(text.replace('Can I see x','show me x')+tail)}
 for(const lead of leads){let text='';while((text+lead+' open x').length<=300)text+=lead+' ';hostile.push(text+'open x');hostile.push(text+'z')}
 hostile.push('show me '+'a'.repeat(290),'open '+'x '.repeat(140),'pull '+'up '.repeat(95)+'x','can you '.repeat(37)+'open x');
 // The UI door refuses anything over 160 characters before it parses, so it gets its own runs that fit.
 const uiFillers=['for me','please','thanks','thank you','jarvis','astra','real quick','really quick','quickly','right now','now'];
 for(const filler of uiFillers)for(const tail of [' z','',' no',',']){let text='close this tab';while((text+' '+filler+tail).length<=160)text+=' '+filler;hostile.push(text+tail)}
 for(const lead of ['hey','hi','hello','ok','okay','all right','alright','so','well','um','uh','jarvis','astra','please','just','now']){let text='';while((text+lead+' close this tab').length<=160)text+=lead+' ';hostile.push(text+'close this tab');hostile.push(text+'z')}
 hostile.push('can you '.repeat(18)+'close this tab','could you please '.repeat(8)+'go back','close '+'this '.repeat(30)+'tab');
 assert.ok(hostile.filter(text=>text.length<=160).length>=60);
 const started=performance.now();
 for(const text of hostile){const one=performance.now();openIntentGiven(text);parseUiIntent(text,{conversationSelected:false,tables:{}});assert.ok(performance.now()-one<250,`${Math.round(performance.now()-one)} ms on: ${text.slice(0,60)}…`)}
 assert.ok(performance.now()-started<2000);
});

test('removing the duplicate filler did not change what the open door accepts',()=>{
 assert.deepEqual(openIntentGiven('Show me the plan on screen'),{target:'the plan'});
 assert.deepEqual(openIntentGiven('Pull up the backfill plan on my screen please'),{target:'the backfill plan'});
 assert.deepEqual(openIntentGiven('Can I see the roadmap up on the screen'),{target:'the roadmap'});
 assert.deepEqual(openIntentGiven('Open the launch checklist on screen for me'),{target:'the launch checklist'});
});
