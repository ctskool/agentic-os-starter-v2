import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveAnswers} from '../runner/live/answers.mjs';
import {LiveTaskUpdates} from '../runner/live/task-updates.mjs';
import {taskStatusReply} from '../runner/task-updates.mjs';
import {LIVE_PREF_DEFAULTS,livePrefsFrom} from '../shared/live-prefs.mjs';

function fixture(mode='done'){
 const frames=[],cards=[],call={callId:'this-call',state:'active',paused:false,socket:{send:event=>frames.push(event)},updates:{push:event=>cards.push(event)}};
 const prefs={liveTaskUpdates:mode},tasks=[];
 call.answers=new LiveAnswers(call);
 const updates=new LiveTaskUpdates(call);
 const receive=(summary,now,metadata={})=>updates.receive({taskId:'research',label:'Research',kind:'completion',liveCallId:call.callId,summary,...metadata},prefs,now);
 return {call,frames,cards,tasks,updates,receive,commentary:()=>frames.filter(frame=>frame.type==='session.commentary.append'),flush:now=>updates.flush(prefs,now,()=>tasks)};
}

test('outcome cards appear immediately and batch speech waits for turn end and 1200 ms of silence',()=>{
 const f=fixture();
 f.updates.transcript({user:true,text:'Still talking',at:1000,offset:1000,turnId:'user'});
 f.receive('Found three sources. Two include data.',1400);
 f.receive('BLOCKED: Calendar access expired.',2300,{taskId:'plan',label:'Plan Today'});
 assert.equal(f.cards[0].text,'Research is done: Found three sources. Two include data.');
 assert.match(f.cards[1].text,/Plan Today didn't finish: Calendar access expired. Open the task/);
 assert.equal(f.cards[1].state,'failed');
 f.flush(6000);assert.equal(f.frames.length,0);
 f.updates.transcript({user:true,text:' and one more thing',at:6100,offset:6100,turnId:'user'});
 f.updates.endTurn({turn_id:'user'});
 f.flush(7299);assert.equal(f.frames.length,0);
 f.flush(7300);assert.equal(f.commentary().length,1);
 assert.match(f.commentary()[0].content,/^By the way, Research is done.*Plan Today didn't finish/);
 assert.equal(f.frames[0].type,'session.thinking.append');
 assert.doesNotMatch(JSON.stringify(f.frames),/want to hear/i);
});

test('standby chimes on the card and holds commentary until wake and a pause',()=>{
 const f=fixture();f.call.paused=true;
 f.receive('Review the request.',100,{kind:'attention'});
 assert.equal(f.cards[0].chime,true);
 assert.equal(f.cards[0].text,"Research needs your OK. It's in the terminal tray.");
 f.flush(3100);assert.equal(f.call.answers.held.length,1);assert.equal(f.commentary().length,0);
 f.call.paused=false;f.updates.transcript({user:true,text:'Hello',at:4000,offset:4000,turnId:'wake'});
 f.call.answers.resume({tasks:false});f.flush(5300);assert.equal(f.commentary().length,0);
 f.updates.endTurn({turn_id:'wake'});f.flush(5301);
 assert.equal(f.commentary().length,1);assert.equal(f.call.answers.held.length,0);
});

test('screen-only stays quiet and chatty checks in every three minutes for this call’s tasks',()=>{
 const f=fixture('silent');f.call.paused=true;f.receive('Saved.',100);f.flush(5000);
 assert.equal(f.cards[0].chime,false);assert.equal(f.frames.length,0);assert.equal(f.call.answers.held.length,0);
 assert.equal(LIVE_PREF_DEFAULTS.liveTaskUpdates,'done');assert.equal(livePrefsFrom({liveTaskUpdates:'unknown'}).liveTaskUpdates,'done');
 const chatty=fixture('chatty');
 chatty.tasks.push({id:'research',title:'Research',state:'working',created:1000},{id:'external',title:'External work',state:'working',created:1000});
 chatty.updates.started(['research'],1000);
 chatty.flush(180999);assert.equal(chatty.frames.length,0);
 chatty.flush(181000);chatty.flush(184000);assert.equal(chatty.commentary()[0].content,'Research is still going, 3 minutes in.');
 chatty.flush(361000);chatty.flush(364000);assert.equal(chatty.commentary()[1].content,'Research is still going, 6 minutes in.');
 chatty.receive('Private output.',365000,{taskId:'external',liveCallId:'another-call'});chatty.flush(368000);
 assert.equal(chatty.commentary().length,2);assert.equal(chatty.cards.length,1);
});

test('status prefers call work, can select a named running task, and lists concurrent tasks',()=>{
 const tasks=[{id:'latest',title:'Planning',state:'ready',turns:[{ts:240000,text:'Saved the plan. More details.'}]},
  {id:'research',title:'Research',state:'working',created:180000},{id:'report',title:'Report',state:'working',created:240000}];
 const ask=text=>taskStatusReply(text,()=>tasks,['latest'],300000)?.reply;
 assert.equal(ask('How’s it going?'),'Planning finished 1 min ago: Saved the plan.');
 assert.equal(ask('Status of the research task'),'Research is still running, 2 min in.');
 assert.equal(ask('What’s running?'),'Report is still running, 1 min in. Research is still running, 2 min in.');
 assert.equal(taskStatusReply('Is that done yet?',()=>[])?.reply,'Nothing is running right now.');
 assert.equal(ask('Show me the report.'),undefined);
});
