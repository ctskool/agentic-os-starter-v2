import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReplayCases} from '../scripts/jev-replay-lib.mjs';

const base=Date.UTC(2026,8,20,15,0,0);
const receipt=(fields={})=>({id:`r-${Math.random().toString(16).slice(2)}`,provider:'codex',appScope:'web',conversationEpoch:7,engine:'luna',tier:2,reply:'',workIds:[],workTarget:null,...fields});

test('an explicit new task is replayed in the epoch before its reset, and its carried reference is never called certain',()=>{
 const answer=receipt({ts:base,transcript:'What was the biggest AI story today?',engine:'rules',lookupRoute:'local',tier:1,reply:'From the saved brief: the RubyGems incident.'});
 // Saved with epoch N+1 and its completion time, ten seconds after the quick answer.
 const request=receipt({ts:base+10000,routingMs:4000,conversationEpoch:8,tier:3,transcript:'Start a new conversation: tell me more about that answer',workIds:['w1']});
 const {cases}=buildReplayCases([request,answer]);
 assert.equal(cases.length,1);
 assert.equal(cases[0].transcript,'tell me more about that answer');assert.equal(cases[0].state.newConversation,true);
 assert.deepEqual(cases[0].state.exchanges,[{you:'What was the biggest AI story today?',jarvis:'From the saved brief: the RubyGems incident.',lookupRoute:'local'}]);
 assert.ok(cases[0].reconstruction.some(note=>/pre-reset epoch/.test(note)));
});
test('the carried reference respects the three-minute window measured from routing time, and work is never carried',()=>{
 const old=receipt({ts:base,transcript:'What was the biggest AI story today?',engine:'rules',tier:1,reply:'The RubyGems incident.'});
 const late=receipt({ts:base+185000,routingMs:1000,conversationEpoch:8,tier:3,transcript:'New task: write a post about that story',workIds:['w2']});
 assert.deepEqual(buildReplayCases([old,late]).cases[0].state.exchanges,[]);
 // Completion lands past three minutes, but routing began inside the window.
 const slow=receipt({ts:base+183000,routingMs:6000,conversationEpoch:8,tier:3,transcript:'New task: write a post about that story',workIds:['w3']});
 assert.equal(buildReplayCases([old,slow]).cases[0].state.exchanges.length,1);
 const work=receipt({ts:base,transcript:'Draft the launch email.',tier:3,reply:'Working on that.',workIds:['w0']});
 const after=receipt({ts:base+10000,conversationEpoch:8,tier:3,transcript:'New task: summarize those findings',workIds:['w4']});
 assert.deepEqual(buildReplayCases([work,after]).cases.at(-1).state.exchanges,[]);
});
test('history follows production order, exclusions use the router\'s own definition, and unreconstructable requests are skipped',()=>{
 const filler=Array.from({length:7},(_,i)=>receipt({ts:base+i*1000,transcript:`Quick question ${i}`,engine:'rules',tier:1,reply:`Answer ${i}`,...(i===0?{pendingSkill:'content-cascade'}:{})}));
 const next=receipt({ts:base+9000,transcript:'What I need next is a checklist for launching the course.',tier:3,workIds:['w5']});
 const built=buildReplayCases([...filler,next]).cases.at(-1);
 // The pending argument is seven exchanges back: outside production's six, so it cannot exclude this request.
 assert.deepEqual(built.state.exchanges.map(item=>item.you),['Quick question 5','Quick question 6']);assert.equal(built.state.exchanges.some(item=>item.pendingSkill),false);
 assert.equal(built.state.compound,false);assert.equal(built.label,null);
 assert.equal(buildReplayCases([receipt({ts:base,transcript:'What is on Hacker News and also draft a summary of it',tier:3,workIds:['w6']})]).cases[0].state.compound,true);
 assert.deepEqual(buildReplayCases([receipt({ts:base,transcript:'Yes, do that.'}),receipt({ts:base+1,transcript:'Worker status.',engine:'rules',tier:1})]),{cases:[],skipped:1});
 const selected=buildReplayCases([receipt({ts:base,transcript:'Why did you choose that layout?',workTarget:'task-1',tier:3,workIds:['task-1']})]).cases[0];
 assert.equal(selected.state.target.lastAnswer,'');assert.ok(selected.reconstruction.includes("selected worker's last result unavailable"));
});
