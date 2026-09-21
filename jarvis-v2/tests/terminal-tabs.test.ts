import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TerminalTabs} from '../components/TerminalTabs';
import {rememberOpenTerminals,tabCloseAction,visibleTerminalTabs} from '../lib/terminal-tabs';
import type {WorkTask} from '../lib/work';

function task(id:string,state='stopped',extra:Partial<WorkTask>={}):WorkTask {
  return {id,title:id,provider:'codex',model:'gpt-6-astra',state,sessionId:null,error:null,pid:null,keep:false,lastActivityAt:1,expiresAt:2,turns:[],...extra};
}
const ids=(tasks:WorkTask[])=>tasks.map(item=>item.id);

test('background skill runs never enter the terminal strip, even through remembered or selected IDs',()=>{
  const tasks=[task('voice','working'),task('report','working',{execution:'headless'}),task('saved-report','stopped',{execution:'headless'}),task('metrics','working',{execution:'script',background:true})];
  assert.deepEqual(ids(visibleTerminalTabs(tasks,['report','saved-report'],[],'report')),['voice']);
  assert.deepEqual(rememberOpenTerminals(['report','saved-report'],tasks,'report'),['voice']);
});

test('a fresh terminal strip hides old stopped records, including kept ones, while showing every live session',()=>{
  const saved=Array.from({length:10},(_,index)=>task('old-'+index,'stopped',{keep:index===0}));
  const active=[task('codex-working','working'),task('claude-ready','ready',{provider:'claude',model:'sonnet'}),task('hooks','needs input'),task('live-error','error',{pid:123}),task('direct-refresh','working',{execution:'script'})];
  const all=[...saved,task('old-error','error'),...active];
  assert.deepEqual(ids(visibleTerminalTabs(all,[],[],null)),ids(active));
  assert.equal(all.length,16,'presentation does not delete or stop hidden history');
  assert.deepEqual(ids(visibleTerminalTabs(all,[],[],'old-3')),['old-3',...ids(active)]);
});

test('tabs observed open stay visible after closing, and explicit history selection restores a hidden tab without altering its state',()=>{
  const initial=[task('new-live','working'),task('old-history')];
  const opened=rememberOpenTerminals([],initial,null);
  assert.deepEqual(opened,['new-live']);
  const closed=[task('new-live'),initial[1]];
  assert.deepEqual(ids(visibleTerminalTabs(closed,rememberOpenTerminals(opened,closed,null),[],null)),['new-live']);
  assert.deepEqual(visibleTerminalTabs(closed,opened,['new-live'],null),[]);
  const restored=rememberOpenTerminals(opened,closed,'old-history');
  assert.deepEqual(ids(visibleTerminalTabs(closed,restored,['new-live'],'old-history')),['old-history']);
  assert.equal(closed[1].state,'stopped');assert.equal(closed[1].pid,null);
});

test('all independently dispatched IDs survive an early empty summary and remain separate even if one immediately fails',()=>{
  const pending=['voice-codex','voice-claude'];
  const opened=rememberOpenTerminals(pending,[],'voice-codex');
  const received=[task('voice-codex','working'),task('voice-claude','error',{provider:'claude',model:'sonnet'}),task('unrelated-old')];
  const tabs=visibleTerminalTabs(received,opened,[],'voice-codex');
  assert.deepEqual(ids(tabs),pending);
  assert.deepEqual(tabs.map(item=>[item.provider,item.model]),[['codex','gpt-6-astra'],['claude','sonnet']]);
  assert.equal(received[1].state,'error','showing the failed request does not resume it');
});

test('the rendered terminal strip keeps history behind its button and uses honest compact status labels',()=>{
  const live=task('Current CLI','needs input'),old=task('Old stopped fixture','stopped',{keep:true});
  const props={tabs:[live],history:[old,live],target:live.id,historyOpen:false,loaded:true,onHistory:()=>{},onSelect:()=>{},onClose:()=>{}};
  const collapsed=renderToStaticMarkup(React.createElement(TerminalTabs,props));
  assert.match(collapsed,/aria-label="Terminal tabs"/);assert.match(collapsed,/Current CLI/);assert.match(collapsed,/Needs input/);
  assert.match(collapsed,/aria-expanded="false"[^>]*>History/);assert.doesNotMatch(collapsed,/Old stopped fixture|terminal-history" aria-label/);
  const expanded=renderToStaticMarkup(React.createElement(TerminalTabs,{...props,historyOpen:true}));
  assert.match(expanded,/Old stopped fixture/);assert.match(expanded,/Closed · Kept/);assert.doesNotMatch(expanded,/completed|successful/i);
  assert.match(expanded,/Opening history does not resume a session/);
});

function elements(node:React.ReactNode):React.ReactElement<any>[] {
  const found:React.ReactElement<any>[]=[];
  React.Children.forEach(node,child=>{if(React.isValidElement(child)){const element=child as React.ReactElement<{children?:React.ReactNode}>;found.push(element,...elements(element.props.children))}});
  return found;
}

test('history selection exposes the exact Claude conversation and closes history without any request or resume',t=>{
  const chosen:string[]=[],historyChanges:boolean[]=[],closed:string[]=[];
  const claude=task('Claude history','stopped',{provider:'claude',model:'opus',sessionId:'saved-cli-session'});
  t.mock.method(globalThis,'fetch',async()=>{assert.fail('Viewing history must not make a provider or resume request')});
  const tree=TerminalTabs({tabs:[],history:[claude],target:null,historyOpen:true,loaded:true,onSelect:id=>chosen.push(id),onHistory:value=>historyChanges.push(value),onClose:id=>closed.push(id)});
  const section=elements(tree).find(element=>element.type==='section'&&element.props['aria-label']==='Terminal history');
  const button=elements(section).find(element=>element.type==='button');
  assert.ok(button);button.props.onClick();
  assert.deepEqual(chosen,[claude.id]);assert.deepEqual(historyChanges,[false]);assert.deepEqual(closed,[]);
  assert.equal(claude.provider,'claude');assert.equal(claude.model,'opus');assert.equal(claude.state,'stopped');
});

test('the tab strip itself only reports a close request; what closing means is decided by the terminal state',t=>{
  const closed:string[]=[],chosen:string[]=[],live=task('Running Codex','working',{pid:123});
  t.mock.method(globalThis,'fetch',async()=>{assert.fail('The strip never talks to the bridge itself')});
  const tree=TerminalTabs({tabs:[live],history:[live],target:live.id,historyOpen:false,loaded:true,onSelect:id=>chosen.push(id),onHistory:()=>{},onClose:id=>closed.push(id)});
  const close=elements(tree).find(element=>element.props['aria-label']==='Close tab: Running Codex');
  assert.ok(close);close.props.onClick();
  assert.deepEqual(closed,[live.id]);assert.deepEqual(chosen,[]);assert.equal(live.pid,123);assert.equal(live.state,'working');
});

test('× ends an idle terminal, asks once more for a busy one, and only removes the tab of a conversation that is not running',()=>{
  assert.equal(tabCloseAction(task('idle','ready',{pid:7})),'stop');
  for(const state of ['starting','working','needs input','editing'])assert.equal(tabCloseAction(task(state,state,{pid:7})),'confirm-stop',state);
  assert.equal(tabCloseAction(task('live-error','error',{pid:7})),'confirm-stop','an error with a live CLI is still a running terminal');
  assert.equal(tabCloseAction(task('refresh','working',{execution:'script'})),'confirm-stop');
  assert.equal(tabCloseAction(task('going','stopping',{pid:7})),'wait');
  for(const closed of [task('old'),task('failed','error'),null,undefined])assert.equal(tabCloseAction(closed),'remove');
});

test('a running terminal can never be hidden, so the open count always matches the tabs on screen',()=>{
  const live=[task('codex-ready','ready',{pid:1}),task('claude-ready','ready',{pid:2,provider:'claude',model:'sonnet'}),task('busy','working'),task('going','stopping',{pid:3})];
  const all=[...live,task('old-a'),task('old-b')];
  const hidden=all.map(item=>item.id);
  assert.deepEqual(ids(visibleTerminalTabs(all,hidden,hidden,'old-a')),ids(live),'hiding everything still shows every running terminal, and only those');
  assert.equal(visibleTerminalTabs(all,[],hidden,null).length,all.filter(item=>item.pid||!['stopped','error'].includes(item.state)).length);
  // Once the bridge reports it closed, the hidden tab is gone.
  const after=all.map(item=>item.id==='codex-ready'?task('codex-ready','stopped',{sessionId:'saved'}):item);
  assert.equal(ids(visibleTerminalTabs(after,['codex-ready'],['codex-ready'],null)).includes('codex-ready'),false);
});

test('an armed tab says Stop? and names what the next press does; a stopping tab cannot be pressed',()=>{
  const busy=task('Busy CLI','working',{pid:9}),going=task('Going CLI','stopping',{pid:10}),idle=task('Idle CLI','ready',{pid:11}),old=task('Old CLI');
  const props={tabs:[busy,going,idle,old],history:[],target:null,historyOpen:false,loaded:true,onHistory:()=>{},onSelect:()=>{},onClose:()=>{}};
  const plain=renderToStaticMarkup(React.createElement(TerminalTabs,props));
  assert.match(plain,/aria-label="Close tab: Busy CLI" title="This terminal is still busy\. Press again to stop it; text typed in the CLI but not sent is lost\."/);
  assert.match(plain,/aria-label="Close tab: Idle CLI" title="Close: ends this terminal\. The conversation stays in History\."/);
  assert.match(plain,/aria-label="Close tab: Old CLI" title="Remove this tab\. The conversation stays in History\."/);
  assert.match(plain,/aria-label="Close tab: Going CLI"[^>]*disabled/);assert.doesNotMatch(plain,/Stop\?|running sessions continue/);
  const armed=renderToStaticMarkup(React.createElement(TerminalTabs,{...props,armed:busy.id}));
  assert.match(armed,/class="is-armed" aria-label="Stop and close: Busy CLI"[^>]*>Stop\?</);assert.equal((armed.match(/Stop\?/g)||[]).length,1);
});
