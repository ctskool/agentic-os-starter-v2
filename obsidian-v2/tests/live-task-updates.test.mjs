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

test('in standby the caller’s screen says the update, once, and Live is told silently that it was said',()=>{
 // Chase's call, 2026-11-26: the one-pager finished in standby and nothing was said. Standby wakes only on speech.
 const f=fixture();f.call.paused=true;
 f.receive('Review the request.',100,{kind:'attention'});
 assert.equal(f.cards[0].chime,true);
 assert.equal(f.cards[0].text,"Research needs your OK. It's in the terminal tray.");
 f.flush(3100);
 assert.equal(f.commentary().length,0);assert.equal(f.call.answers.held.length,0,'nothing waits to be said by Live later');
 const announce=f.cards.find(card=>card.type==='announce');assert.ok(announce);
 assert.equal(f.updates.takeAnnouncement(announce.say),"Research needs your OK. It's in the terminal tray.");
 assert.equal(f.updates.takeAnnouncement(announce.say),null,'each one is played once');
 const told=f.frames.filter(frame=>frame.type==='session.thinking.append');
 assert.equal(told.length,1);assert.match(told[0].content,/^Already said out loud on the user's screen.*don't repeat it unless asked: Research needs your OK/);
 // Awake, the same update is Live's to say, as before.
 f.call.paused=false;f.receive('Saved the page.',4000);f.flush(7100);
 assert.equal(f.commentary().length,1);assert.match(f.commentary()[0].content,/Research is done: Saved the page/);
 assert.equal(f.cards.filter(card=>card.type==='announce').length,1);
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

// Open hand-offs (real calls, 2026-11-26): an unanswered delegation keeps GPT-Live awake, and a commentary sent on it
// later is said in Live's own voice. Chase asked for a five-minute cap.
test('a task started by a hand-off has its news said on that hand-off, and other lines leave it open',()=>{
 const f=fixture();
 f.updates.hold(['research'],'del-1',0);
 f.receive('Review the request.',1000,{kind:'attention'});f.flush(4100);
 assert.equal(f.commentary().at(-1).delegation_id,null,'"needs your OK" is a plain line');
 assert.equal(f.updates.open.has('research'),true);
 f.receive('Found three sources.',60000);f.flush(63100);
 const news=f.commentary().at(-1);
 assert.equal(news.delegation_id,'del-1');assert.match(news.content,/^Research is done: Found three sources/);
 assert.equal(f.updates.open.size,0);
 f.receive('Another result.',70000);f.flush(73100);assert.equal(f.commentary().at(-1).delegation_id,null,'once said, later news is a plain line');
});

test('an open hand-off is closed in Live’s voice after five minutes, or soon after its task was stopped',()=>{
 const f=fixture();
 f.tasks.push({id:'research',title:'Research',state:'working',created:0});
 f.updates.hold(['research'],'del-1',0);
 f.flush(299999);assert.equal(f.commentary().length,0);
 f.flush(300000);
 assert.equal(f.commentary()[0].delegation_id,'del-1');assert.equal(f.commentary()[0].content,"Research is still working. I'll tell you when it's done.");
 assert.equal(f.updates.open.size,0);
 const g=fixture();g.tasks.push({id:'report',title:'Report',state:'stopped',created:0});
 g.updates.hold(['report'],'del-2',0);
 g.flush(1000);assert.equal(g.commentary().length,0,'a short grace in case its news is on the way');
 g.flush(11000);assert.equal(g.commentary()[0].content,'Report was stopped.');assert.equal(g.commentary()[0].delegation_id,'del-2');
});

test('news in standby renews the call so Live says it; if no renewal can start, the screen says it',()=>{
 const f=fixture();let wakes=0;f.call.paused=true;f.call.requestWake=()=>{wakes++;return true};
 f.receive('Saved the page.',100);f.flush(3200);
 assert.equal(wakes,1);assert.equal(f.cards.some(card=>card.type==='announce'),false);
 assert.equal(f.call.answers.held.length,1,'held for the fresh session');assert.match(f.call.answers.held[0].content,/Research is done/);
 f.updates.wakeFailed();
 assert.equal(f.call.answers.held.length,0);
 const announce=f.cards.find(card=>card.type==='announce');assert.ok(announce);
 assert.match(f.updates.takeAnnouncement(announce.say),/Research is done/);
 const g=fixture();g.call.paused=true;g.call.requestWake=()=>false;g.receive('Saved.',100);g.flush(3200);
 assert.ok(g.cards.some(card=>card.type==='announce'));
});

test('a line refused on its hand-off is still said, and only unanswered hand-offs count as open',()=>{
 const f=fixture();
 assert.equal(f.call.answers.isOpen('del-1'),true);
 f.call.answers.result('del-1',{reply:'Working on that.'},undefined,{keepOpen:true});
 assert.equal(f.call.answers.isOpen('del-1'),true,'a task result leaves the hand-off open');
 assert.equal(f.frames.find(frame=>frame.delegation_id==='del-1').type,'session.thinking.append');
 assert.equal(f.commentary().at(-1).delegation_id,null);
 f.call.answers.speak('del-1','The page is done.');assert.equal(f.call.answers.isOpen('del-1'),false);
 const refused=f.commentary().at(-1);
 f.call.answers.acknowledge({type:'error',error:{client_event_id:refused.event_id}});
 assert.equal(f.commentary().at(-1).delegation_id,null);assert.equal(f.commentary().at(-1).content,'The page is done.');
});

test('a call hears the worker’s own opening, and a file-link hiccup is not told as a failure',async()=>{
 const {replyOpening,taskUpdate}=await import('../runner/task-updates.mjs');
 const text="Your calendar has six things today and nothing all-day. Tomorrow you have one: Skool Email from 4 to 4:15 p.m. Nothing else is booked.\n\n**Details:**\n- 8 a.m. Practice";
 assert.equal(replyOpening(text),'Your calendar has six things today and nothing all-day. Tomorrow you have one: Skool Email from 4 to 4:15 p.m. Nothing else is booked.');
 assert.equal(replyOpening('# Heading only'),'');
 const done=taskUpdate({label:'Hooks',kind:'completion-error',failed:false,summary:'There are important limitations in the result.',reply:'I wrote three hooks and saved them.'});
 assert.deepEqual(done,{state:'done',text:'Hooks is done: I wrote three hooks and saved them.'});
 assert.equal(taskUpdate({label:'Hooks',kind:'completion-error',summary:'BLOCKED: no access'}).state,'failed');
});
