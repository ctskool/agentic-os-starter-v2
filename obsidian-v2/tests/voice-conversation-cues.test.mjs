import test from 'node:test';
import assert from 'node:assert/strict';
import {completionLabel,createWorkAcknowledgments,groundedAcceptance} from '../runner/voice-conversation-cues.mjs';

test('a short classifier acceptance can refer to the actual requested work',()=>{
 assert.equal(groundedAcceptance("Sure, I'll adjust the graphic.",'Please adjust the graphic'),"Sure, I'll adjust the graphic.");
 assert.equal(groundedAcceptance("I'll research the launch plan.",'Help me research the launch plan'),"I'll research the launch plan.");
 assert.equal(groundedAcceptance("Sure, I'll adjust that.",'Make that blue instead'),"Sure, I'll adjust that.");
 assert.equal(groundedAcceptance("I'll revise it.",'Please make it shorter'),"I'll revise it.");
 assert.equal(groundedAcceptance("I'll revise it.",'Do not revise it; research another topic'),null);
 for(const bad of ["I've created the graphic.","I'll get it done in two minutes.","Sure, it's already saved.","I'll research the bank account.","I'll approve it.","I'll work on that. It is done.","I'll work on that, but I can't save it.","I'll create <script>something</script>.","I'll create it?",''])assert.equal(groundedAcceptance(bad,'Create a graphic about a launch plan'),null,bad);
});
test('a classifier cannot echo a long utterance or substitute a revision for unrelated new work',()=>{
 assert.equal(groundedAcceptance("I'll create a graphic depicting all of the events in yesterday's AI news.","Create a graphic depicting all of the events in yesterday's AI news."),null);
 assert.equal(groundedAcceptance("I'll revise that.",'Research a new launch plan'),null);
 const reply=createWorkAcknowledgments({choose:()=>0})({continuation:true,engine:'luna',classifiedReply:"I'll revise that.",request:'Research a new launch plan'});
 assert.doesNotMatch(reply,/revis|updat|continu/i);
});
test('acceptances vary without a fixed cycle and avoid the previous four per provider',()=>{
 const acknowledge=createWorkAcknowledgments({choose:()=>0}),replies=[];
 for(let i=0;i<20;i++){const reply=acknowledge({provider:'codex'});assert.ok(!replies.slice(-4).includes(reply));replies.push(reply)}
 assert.equal(acknowledge({provider:'claude'}),replies[0]);
 const model=createWorkAcknowledgments({choose:()=>0}),input={engine:'haiku',classifiedReply:"I'll adjust the graphic.",request:'Adjust the graphic'};
 assert.equal(model(input),input.classifiedReply);assert.notEqual(model(input),input.classifiedReply);
});
test('named workflows use their known operation and multiple task counts remain exact',()=>{
 const acknowledge=createWorkAcknowledgments({choose:()=>0});
 assert.match(acknowledge({skill:'metrics-pull'}),/metrics refresh/);
 assert.match(acknowledge({skill:'plan-tomorrow'}),/tomorrow's plan/);
 assert.match(acknowledge({count:3,classifiedReply:"I'll create the graphic.",engine:'luna',request:'Create the graphic'}),/3 tasks/);
});
test('completion labels come from workflow or returned artifacts, never the original request',()=>{
 const task={provider:'codex',title:'Can you please create a long graphic with everything from yesterday and show it to me'};
 assert.equal(completionLabel(task),'Codex');
 assert.equal(completionLabel({...task,workflow:{job:{skill:'plan-tomorrow'}}}),"tomorrow's plan");
 assert.equal(completionLabel(task,{text:'Here is [Cipher break graphic](outputs/cipher.svg).'}),'Cipher break graphic');
 assert.equal(completionLabel(task,{text:'[Open](C:/outputs/result.png)'}),'graphic');
 assert.equal(completionLabel(task,{text:'[https://bad](result.pdf)'}),'document');
 assert.equal(completionLabel({provider:'claude'},{text:'The worker could not complete the task.'}),'Claude Code');
});
