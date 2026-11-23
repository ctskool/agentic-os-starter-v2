// What a voice-started terminal receives besides the request (2026-11-22: a one-line request arrived as 3.3 KB,
// the request twice, the same conversation twice, UTC stamps, an empty heading and a wrongly omitted offer).
import test from 'node:test';
import assert from 'node:assert/strict';
import {workerConversation} from '../runner/voice-router.mjs';

const offer='I can’t run a live web search from this voice layer, so I answer from your saved morning brief. Want me to start a deep research task on the biggest AI news from this past week?';
const exchanges=[
 {ts:'2026-11-23T03:54:44.619Z',you:'Tell me how our Jarvis system works',jarvis:'The Agentic OS is your Obsidian vault with a voice layer on top.'},
 {ts:'2026-11-23T03:55:08.209Z',you:'Walk me through the flow of a request',jarvis:'A request comes in by voice and I classify it into one of three paths.'},
 {ts:'2026-11-23T03:55:40.754Z',you:'How do you decide what you handle?',jarvis:'Named workflows and snapshot questions stay with me.'},
 {ts:'2026-11-23T03:56:16.975Z',you:'Are you able to do your own form of web search or no?',jarvis:offer},
];
const noDailyNote={daily:{isToday:false}};

test('a Local request keeps the last three exchanges once, without timestamps, and "able to do" is not a to-do list',()=>{
 const text=workerConversation(exchanges,noDailyNote);
 assert.ok(text.includes(offer),'the accepted offer survives');
 assert.doesNotMatch(text,/daily-plan answer omitted|\d{4}-\d\d-\d\dT|Background work/);
 assert.doesNotMatch(text,/Tell me how our Jarvis system works/,'only the last three exchanges');
 assert.equal(text.split('\n').length,6);
});

test('stale schedule answers are still withheld when there is no daily note',()=>{
 const text=workerConversation([{you:'What are my priorities?',jarvis:'1, Record the demo'},{you:'Anything on my to-do list?',jarvis:'Call Sam'}],noDailyNote);
 assert.doesNotMatch(text,/Record the demo|Call Sam/);
 assert.equal(text.match(/daily-plan answer omitted/g).length,2);
 assert.match(workerConversation([{you:'What are my priorities?',jarvis:'1, Record the demo'}],{daily:{isToday:true}}),/Record the demo/);
});

test('in a Live call the spoken transcript is used once, clipped from the end, and empty turns are dropped',()=>{
 const turns=[...Array.from({length:8},(_,i)=>({role:i%2?'assistant':'user',text:'turn '+i})),{role:'assistant',text:' '},{role:'assistant',text:offer}];
 const text=workerConversation(exchanges,noDailyNote,turns);
 assert.ok(text.endsWith('Assistant: '+offer));
 assert.doesNotMatch(text,/Assistant:\s*\n|turn 0|turn 3|Tell me how our Jarvis/);
 const long=workerConversation([],noDailyNote,Array.from({length:6},(_,i)=>({role:'user',text:'x'.repeat(500)+i})));
 assert.ok(long.length<=1800);assert.ok(long.endsWith('5'));
 assert.equal(workerConversation([],noDailyNote,[]),'');
});
