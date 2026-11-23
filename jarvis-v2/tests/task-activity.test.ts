import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskActivity,activityElapsed,type ActivityTask} from '../../obsidian-v2/shared/task-activity';
import {VoiceSession} from '../../obsidian-v2/shared/voice-session';
import {openWork,workFeed} from '../lib/work';
import {voice,voicePrefs} from '../lib/voiceClient';

test('background work refreshes the feed and an explicit view opens the requested task',t=>{
  const previous=globalThis.window;
  globalThis.window=new EventTarget() as unknown as Window & typeof globalThis;
  t.after(()=>{globalThis.window=previous});
  const opened:string[][]=[];
  window.addEventListener('jarvis-open-work',event=>opened.push((event as CustomEvent<{ids:string[]}>).detail.ids));
  const refresh=t.mock.method(workFeed,'refresh',async()=>workFeed.getSnapshot());
  openWork(['voice-task']);
  openWork(['skill-task']);
  assert.deepEqual(opened,[]);
  assert.equal(refresh.mock.callCount(),2);
  openWork(['voice-task'],true);
  assert.deepEqual(opened,[['voice-task']]);
});

test('task activity tracks distinct approval episodes and shows the elapsed time',()=>{
  const activity=createTaskActivity();
  activity.update([],0);
  const task:ActivityTask={id:'research',title:'Research',state:'working',created:0};
  const running=activity.update([task],12000).changes[0];
  assert.equal(running.state,'working');
  assert.equal(activityElapsed(running,12000),'0:12');
  const first=activity.update([{...task,state:'needs input'}],16000).changes[0];
  assert.equal(activity.update([{...task,state:'needs input'}],16500).changes.length,0);
  activity.update([task],17000);
  const second=activity.update([{...task,state:'needs input'}],18000).changes[0];
  assert.notEqual(first.key,second.key);
  const completed=activity.update([{...task,state:'ready',turns:[{id:'answer',ts:20000,text:'Saved the research.'}]}],21000).changes[0];
  assert.equal(completed.state,'done');
  assert.equal(activityElapsed(completed,25000),'0:20');
});

test('a finished task stays visible with no Live call and Local speech only runs in Local mode',async t=>{
  const announce=t.mock.method(VoiceSession.prototype,'announce',async()=>{});
  const enqueue=t.mock.method(VoiceSession.prototype,'enqueue',()=>{});
  t.mock.method(VoiceSession.prototype,'connect',()=>{});
  let mode='live';
  t.mock.method(globalThis,'fetch',async(url:RequestInfo|URL)=>{
    if(String(url)==='/api/bridge-auth')return Response.json({token:'a'.repeat(64)});
    return Response.json({spokenReplies:true,voice:null,rate:1,voiceMode:mode});
  });
  t.after(()=>voice.destroy());
  await voicePrefs.save({voiceMode:'live'});
  const activity=createTaskActivity();
  activity.update([],0);
  const run={id:'done',title:'Research',state:'ready',turns:[{id:'answer',ts:500,text:'Saved.'}]};
  assert.equal(activity.update([run],500).changes[0].state,'done');
  await voice.announce('run:done','Saved.');
  voice.speak('Saved.');
  assert.equal(announce.mock.callCount(),0);
  assert.equal(enqueue.mock.callCount(),0);
  mode='local';
  await voicePrefs.save({voiceMode:'local'});
  await voice.announce('run:local','Saved.');
  voice.speak('Saved.');
  assert.equal(announce.mock.callCount(),1);
  assert.equal(enqueue.mock.callCount(),1);
});
