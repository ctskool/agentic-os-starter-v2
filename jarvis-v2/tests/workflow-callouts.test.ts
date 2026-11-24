import test from 'node:test';
import assert from 'node:assert/strict';
import {liveActivityCallout,queueWorkflowCallout,reconcileTaskCallouts,reconcileWorkflowCallouts,taskCardLabel,TASK_CARD_MISSING_MS,TASK_CARD_SETTLE_MS} from '../lib/workflow-callouts';
import type {RunEntry} from '../lib/vault';

const run=(id:string,status:string,extra:Partial<RunEntry>={}):RunEntry=>({id,skill:'morning-report',label:'Morning Intel',status,summary:'',link:null,ts_started:'2026-09-14T12:00:00Z',ts_completed:null,duration_s:null,deliverable_path:null,...extra});

test('queued workflow becomes a report card in place even when completion precedes the first poll',()=>{
  let seq=0;
  const queued=queueWorkflowCallout([],'quick-report','Morning Intel',()=>++seq);
  assert.equal(queued[0].phase,'queued');
  const done=reconcileWorkflowCallouts(queued,[run('quick-report','ok',{deliverable_path:'inbox/reports/morning.md'})],{},()=>++seq);
  assert.deepEqual(done.map(card=>[card.id,card.slot,card.kind,card.target]),[[queued[0].id,queued[0].slot,'doc','inbox/reports/morning.md']]);
  assert.equal(done[0].phase,undefined);
});

test('workflow failures remain visible with the actual error and never become report links',()=>{
  const queued=queueWorkflowCallout([],'failed','Deep Research',()=>1);
  const failed=reconcileWorkflowCallouts(queued,[run('failed','error',{summary:'Provider sign-in expired.',deliverable_path:'stale.md'})],{},()=>2);
  assert.equal(failed[0].kind,'task');assert.equal(failed[0].phase,'failed');assert.equal(failed[0].detail,'Provider sign-in expired.');
  assert.equal(failed[0].target,'run:failed');
});

test('running polls preserve the card and successful scripts without a report finish cleanly',()=>{
  let seq=0;
  const first=reconcileWorkflowCallouts([],[run('refresh','running')],{'morning-report':30},()=>++seq);
  assert.equal(first[0].phase,'working');assert.equal(first[0].etaS,30);
  assert.strictEqual(reconcileWorkflowCallouts(first,[run('refresh','running')],{},()=>++seq),first);
  const completed=reconcileWorkflowCallouts(first,[run('refresh','ok')],{},()=>++seq);
  assert.equal(completed[0].phase,'done');assert.equal(seq,1);
});

test('queue receipt deduplication and fresh-page snapshots do not replay old reports',()=>{
  const queued=queueWorkflowCallout([],'same','Morning Intel',()=>1);
  assert.strictEqual(queueWorkflowCallout(queued,'same','Morning Intel',()=>2),queued);
  assert.deepEqual(reconcileWorkflowCallouts([],[run('historical','ok',{deliverable_path:'old.md'})],{},()=>3),[]);
});

test('a Live hand-off is one card that updates in place, clears when dropped, and never disturbs a workflow run',()=>{
  let seq=0;const next=()=>++seq;
  const running=queueWorkflowCallout([],'intel-run','Morning Intel',next);
  let cards=liveActivityCallout(running,{key:'del_1',phase:'handoff',label:''},next,1000);
  assert.equal(cards.length,2);
  const card=()=>cards.find(item=>item.target==='live:del_1');
  assert.deepEqual({label:card()?.label,phase:card()?.phase,note:card()?.note,kind:card()?.kind,startedAt:card()?.startedAt},{label:'Handing off',phase:'working',note:'V2 is working it out',kind:'task',startedAt:1000});
  const slot=card()?.slot,id=card()?.id;
  cards=liveActivityCallout(cards,{key:'del_1',phase:'starting',label:'Start Inbox Brief'},next);
  assert.deepEqual({label:card()?.label,phase:card()?.phase,note:card()?.note,slot:card()?.slot,id:card()?.id},{label:'Inbox Brief',phase:'working',note:'starting',slot,id});
  cards=liveActivityCallout(cards,{key:'del_1',phase:'started',label:'Start Inbox Brief'},next);
  assert.deepEqual({phase:card()?.phase,note:card()?.note},{phase:'done',note:'started'});
  cards=liveActivityCallout(cards,{key:'del_2',phase:'answered',label:'the morning brief'},next);
  assert.equal(cards.find(item=>item.target==='live:del_2')?.label,'Morning brief');
  cards=liveActivityCallout(cards,{key:'del_2',phase:'dropped',label:''},next);
  assert.equal(cards.some(item=>item.target==='live:del_2'),false);
  assert.equal(liveActivityCallout(cards,{key:'del_9',phase:'dropped',label:''},next),cards);
  assert.equal(liveActivityCallout(cards,{key:'del_9',phase:'unknown',label:''},next),cards);
  // The run's own card is untouched by all of it, and reconciling runs leaves the Live card alone.
  assert.equal(cards.find(item=>item.target==='run:intel-run')?.phase,'queued');
  assert.equal(reconcileWorkflowCallouts(cards,[run('intel-run','running')],{},next).find(item=>item.target==='live:del_1')?.note,'started');
});

// Chase, 2026-11-23: a task started on a call showed "started" and cleared after six seconds while the task kept working.
const convo=(state:string,extra:Record<string,unknown>={})=>({id:'task-1',title:'Actually pager, make me a one-pager on black holes',state,turns:[] as {id:string;ts:number;text:string}[],...extra});
const startedCard=(taskIds=['task-1'],now=1000)=>{
  let seq=0;const next=()=>++seq;
  let cards=liveActivityCallout([],{key:'del_1',phase:'starting',label:'Start “Actually pager, make me a one-pager” in your Claude terminal'},next,now);
  assert.equal(cards[0].label,'Pager, make me a one-pager','the spoken words are the name, without the quote marks or the opening filler');
  cards=liveActivityCallout(cards,{key:'del_1',phase:'started',label:'Start “Actually pager, make me a one-pager” in your Claude terminal',taskIds},next,now+2500);
  return {cards,next};
};

test('a card for work a call started stays up while the conversation works and completes when it finishes',()=>{
  let {cards}=startedCard();
  assert.deepEqual({phase:cards[0].phase,note:cards[0].note,taskId:cards[0].taskId,startedAt:cards[0].startedAt},{phase:'working',note:'working',taskId:'task-1',startedAt:1000});
  // Still working a minute later: the same card, same slot, never cleared.
  const working=reconcileTaskCallouts(cards,[convo('working')],true,60000);
  assert.deepEqual({id:working[0].id,slot:working[0].slot,phase:working[0].phase,note:working[0].note},{id:cards[0].id,slot:cards[0].slot,phase:'working',note:'working'});
  assert.strictEqual(reconcileTaskCallouts(working,[convo('working')],true,61000),working,'an unchanged poll changes nothing');
  const done=reconcileTaskCallouts(working,[convo('ready',{turns:[{id:'t1',ts:90000,text:'Done.'}]})],true,91000);
  assert.deepEqual({phase:done[0].phase,note:done[0].note},{phase:'done',note:undefined});
  assert.strictEqual(reconcileTaskCallouts(done,[convo('ready')],true,95000),done,'a finished card is left for the clear timer');
});

test('the card says when the conversation needs you, and shows a failure with its reason',()=>{
  const {cards}=startedCard();
  const asking=reconcileTaskCallouts(cards,[convo('needs input')],true,5000);
  assert.deepEqual({phase:asking[0].phase,note:asking[0].note,attention:asking[0].attention},{phase:'working',note:'needs you',attention:true});
  const resumed=reconcileTaskCallouts(asking,[convo('working')],true,9000);
  assert.deepEqual({note:resumed[0].note,attention:resumed[0].attention},{note:'working',attention:false});
  const failed=reconcileTaskCallouts(resumed,[convo('error',{error:'Claude sign-in expired.'})],true,12000);
  assert.deepEqual({phase:failed[0].phase,detail:failed[0].detail},{phase:'failed',detail:'Claude sign-in expired.'});
});

test('a task list that is a moment old does not finish a card that was only just started',()=>{
  const {cards}=startedCard();   // bound at 3500
  // A follow-up was sent to a conversation that had already answered once: the list still shows it idle.
  const earlier=convo('ready',{turns:[{id:'t0',ts:500,text:'Earlier answer.'}]});
  const waiting=reconcileTaskCallouts(cards,[earlier],true,4000);
  assert.equal(waiting[0].phase,'working');
  // A turn that ended after the card was bound is a real finish, even if it was never seen working.
  assert.equal(reconcileTaskCallouts(cards,[convo('ready',{turns:[{id:'t1',ts:4200,text:'Quick answer.'}]})],true,4500)[0].phase,'done');
  // Never seen working and no new turn: believed once the settle window has passed.
  assert.equal(reconcileTaskCallouts(cards,[earlier],true,3500+TASK_CARD_SETTLE_MS+1)[0].phase,'done');
  // A follow-up the bridge is holding keeps the card up between turns.
  const held=reconcileTaskCallouts(cards,[convo('ready',{queuedFollowups:1,turns:[{id:'t1',ts:4200,text:'First part.'}]})],true,4500);
  assert.deepEqual({phase:held[0].phase,note:held[0].note},{phase:'working',note:'waiting its turn'});
});

test('a stopped conversation, a background run with its own card, and a conversation that never appears all let the card go',()=>{
  const {cards,next}=startedCard();
  const working=reconcileTaskCallouts(cards,[convo('working')],true,5000);
  assert.deepEqual(reconcileTaskCallouts(working,[convo('stopped')],true,9000),[]);
  // Stopped after it answered is a finish, not a disappearance.
  assert.equal(reconcileTaskCallouts(working,[convo('stopped',{turns:[{id:'t1',ts:8000,text:'Done.'}]})],true,9000)[0].phase,'done');
  // A background workflow gets a run card with its report link: the hand-off's card steps aside.
  const withRun=queueWorkflowCallout(cards,'task-1','Inbox Brief',next);
  assert.deepEqual(reconcileTaskCallouts(withRun,[],true,4000).map(card=>card.target),['run:task-1']);
  // Not listed yet is not gone; not listed after the wait is.
  assert.strictEqual(reconcileTaskCallouts(cards,[],false,3500+TASK_CARD_MISSING_MS+1),cards);
  assert.strictEqual(reconcileTaskCallouts(cards,[],true,5000),cards);
  assert.deepEqual(reconcileTaskCallouts(cards,[],true,3500+TASK_CARD_MISSING_MS+1),[]);
});

test('one card per conversation: a follow-up on the same conversation takes over from the earlier card',()=>{
  let {cards,next}=startedCard();
  cards=reconcileTaskCallouts(cards,[convo('working')],true,5000);
  cards=liveActivityCallout(cards,{key:'del_2',phase:'handoff',label:''},next,20000);
  cards=liveActivityCallout(cards,{key:'del_2',phase:'starting',label:'Add to “that task” when it is free'},next,21000);
  assert.equal(cards.length,2);assert.equal(cards.find(card=>card.target==='live:del_2')?.label,'Follow-up');
  cards=liveActivityCallout(cards,{key:'del_2',phase:'started',label:'Add to “that task” when it is free',taskIds:['task-1']},next,23500);
  assert.deepEqual(cards.map(card=>[card.target,card.taskId,card.phase]),[['live:del_2','task-1','working']]);
  // The conversation's title replaces "Follow-up" once the list is read.
  assert.equal(reconcileTaskCallouts(cards,[convo('working')],true,24000)[0].label,'Pager, make me a one-pager on black holes');
  // A hand-off that started nothing the page can follow keeps the old behavior: "started", then cleared.
  const plain=liveActivityCallout([],{key:'del_3',phase:'started',label:'Start Inbox Brief'},next);
  assert.deepEqual({phase:plain[0].phase,note:plain[0].note,taskId:plain[0].taskId},{phase:'done',note:'started',taskId:undefined});
});

test('four working cards are never bumped by a finished one, and card names drop quotes and filler',()=>{
  let seq=0;const next=()=>++seq;let cards:ReturnType<typeof liveActivityCallout>=[];
  for(const n of [1,2,3,4])cards=liveActivityCallout(cards,{key:'del_'+n,phase:'started',label:'Start “Job '+n+'”',taskIds:['task-'+n]},next,1000*n);
  assert.deepEqual(cards.map(card=>card.slot).sort(),[0,1,2,3]);
  cards=reconcileTaskCallouts(cards,[1,2,3,4].map(n=>convo(n===2?'ready':'working',{id:'task-'+n,turns:n===2?[{id:'t',ts:9000,text:'Done.'}]:[]})),true,10000);
  assert.equal(cards.find(card=>card.taskId==='task-2')?.phase,'done');
  const fifth=liveActivityCallout(cards,{key:'del_5',phase:'handoff',label:''},next,11000);
  assert.deepEqual(fifth.map(card=>card.taskId).filter(Boolean).sort(),['task-1','task-3','task-4'],'the finished card gives up its slot');
  assert.equal(taskCardLabel('“Okay so, actually make the intro shorter”'),'Make the intro shorter');
  // The way of asking comes off the front, so the card reads as the thing asked for (Chase, 2026-11-24).
  assert.equal(taskCardLabel('Yeah, can you do some research on Unreal Engine pricing'),'Research on Unreal Engine pricing');
  assert.equal(taskCardLabel('Actually, I want you to build me an HTML um, one-pager explaining the Riemann hypothesis'),'HTML one-pager explaining the Riemann hypothesis');
  assert.equal(taskCardLabel('Hey Jarvis, could you please go ahead and draft me a launch post'),'Launch post');
  // A name the bridge already took from Claude Code is left as it is.
  assert.equal(taskCardLabel('Riemann hypothesis one-pager'),'Riemann hypothesis one-pager');
  assert.equal(taskCardLabel('Can you'),'Can you');assert.equal(taskCardLabel('um'),'Um');
  assert.equal(taskCardLabel('inbox brief'),'Inbox brief');assert.equal(taskCardLabel('  ','Task'),'Task');
});
