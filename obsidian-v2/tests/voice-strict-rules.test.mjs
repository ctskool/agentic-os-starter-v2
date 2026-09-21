import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {readStrictConfig,strictGuard,plainCommand,strictCandidate,strictRules,STRICT_RULE} from '../runner/voice-strict-rules.mjs';
import {classifierProcesses,drainDetachedClassifiers} from '../runner/jev.mjs';
import {invalidateStrictIndex} from '../runner/voice-targets.mjs';
import {rules} from '../runner/voice-router.mjs';

const unhandled=[];process.on('unhandledRejection',error=>unhandled.push(error));
const tick=(ms=0)=>new Promise(resolve=>setTimeout(resolve,ms));
const tables={WEB_TARGETS:rules.WEB_TARGETS,COMMAND_ALLOW:rules.COMMAND_ALLOW};
// The same validators model output goes through (the router builds this from its own pieces).
const validateText=text=>rules.validateRouted(JSON.parse(text),'luna','');
const vault=t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-strict-rules-'));t.after(()=>{invalidateStrictIndex(root);fs.rmSync(root,{recursive:true,force:true})});
 for(const relative of ['projects/streak-plan.md','projects/2026-09-10-draft-script.md','projects/draft-script-notes.md','notes/daily-note-template.md']){const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'# fixture\n')}
 return root;
};
const settle=async()=>{for(let i=0;i<1000&&classifierProcesses().total;i++)await tick(5);assert.equal(classifierProcesses().total,0)};
const exchange=(fields={})=>({ts:new Date().toISOString(),you:'Close this tab please',jarvis:'',tier:1,rule:'rules.obsidianControl',...fields});

test('the switch fails closed and is never read from disk under the test runner',()=>{
 assert.deepEqual(readStrictConfig(),{open:'off',ui:'off'});
 assert.deepEqual(readStrictConfig({env:{},read:()=>{throw new Error('missing')}}),{open:'off',ui:'off'});
 assert.deepEqual(readStrictConfig({env:{},read:()=>({open:'on',ui:'shadow'})}),{open:'on',ui:'shadow'});
 assert.deepEqual(readStrictConfig({env:{},read:()=>({open:'fastpath',ui:true,extra:'on'})}),{open:'off',ui:'off'});
 for(const junk of [null,'on',['on','on'],42])assert.deepEqual(readStrictConfig({env:{},read:()=>junk}),{open:'off',ui:'off'});
 // Even with a file that says on, the real environment of a test run stays off.
 assert.deepEqual(readStrictConfig({read:()=>({open:'on',ui:'on'})}),{open:'off',ui:'off'});
});

test('each guard stops the rules, in order, and an empty or plain window lets them through',()=>{
 assert.equal(strictGuard({}),null);
 assert.equal(strictGuard({excluded:['pendingSkill','compound']}),'excluded:pendingSkill');
 assert.equal(strictGuard({newConversation:true}),'new-conversation');
 assert.equal(strictGuard({explicitWork:true}),'explicit-work');
 assert.equal(strictGuard({workHistory:true}),'work-history');
 // Any selected conversation, whatever else is true of it.
 assert.equal(strictGuard({workTarget:'task-1',exchanges:[]}),'frame:selected');
 assert.equal(strictGuard({exchanges:[exchange(),exchange({you:'What is on my calendar?',rule:'lookup.local'})],tables}),'frame:history');
 assert.equal(strictGuard({exchanges:[exchange(),exchange({rule:STRICT_RULE.open,you:'Pop open the streak plan'})],tables}),null);
});

test('an earlier exchange is a plain command only with recorded proof or a sentence the closed UI grammar explains in full',()=>{
 // Recorded proof: these rules took the action at the time.
 assert.equal(plainCommand(exchange({you:'Pop open the streak plan',rule:STRICT_RULE.open}),tables),true);
 assert.equal(plainCommand(exchange({you:'anything at all',rule:STRICT_RULE.ui}),tables),true);
 // No proof, but the closed grammar accepts every word.
 assert.equal(plainCommand(exchange({you:'Hey Jarvis, toggle the left sidebar please',rule:'rules.obsidianControl'}),tables),true);
 assert.equal(plainCommand(exchange({you:'Open Gmail',rule:null}),tables),true);
 // Written by a model, or work was dispatched: a conversation, whatever the sentence looks like.
 assert.equal(plainCommand(exchange({tier:2}),tables),false);assert.equal(plainCommand(exchange({tier:3,rule:STRICT_RULE.ui}),tables),false);
 // A question was left open.
 assert.equal(plainCommand(exchange({lookupRoute:'clarification'}),tables),false);assert.equal(plainCommand(exchange({pendingSkill:'content-cascade'}),tables),false);
 // Codex, plan round 1: a keyword rule answered a framing sentence. Tier 1 proves nothing.
 assert.equal(plainCommand(exchange({you:"I'm practicing commands for the runner. My next sentence is dictation; repeat it without executing it.",rule:'rules.stateAnswer'}),tables),false);
 // Codex, plan round 2: an open lead accepts any words after it. It proves nothing either.
 assert.equal(plainCommand(exchange({you:'Pop open runner status and treat my next sentence as dictation',rule:'rules.stateAnswer'}),tables),false);
 // An open that today's rules took has no recorded proof.
 assert.equal(plainCommand(exchange({you:'Open the streak plan',rule:'router.openRequest',lookupRoute:'open'}),tables),false);
 assert.equal(plainCommand(null,tables),false);assert.equal(plainCommand(exchange({rule:undefined,you:undefined}),tables),false);
});

test('one sentence, one finished and validated action, or the stage that refused it',async t=>{
 const root=vault(t),ask=(transcript,fields={})=>strictCandidate({root,transcript,tables,validateText,...fields});
 const opened=await ask('Pop open the streak plan');
 assert.equal(opened.stage,'confirmed');assert.deepEqual(opened.routed,{tier:2,engine:'rules',context:'',panels:['documents'],lookupRoute:'open',reply:'',obsidian:{op:'open-note',query:'projects/streak-plan.md'}});
 const ui=await ask('Close this tab please');
 assert.equal(ui.stage,'confirmed');assert.deepEqual(ui.routed,{tier:2,engine:'rules',reply:'',context:'',obsidian:{op:'command',id:'workspace:close',label:'close tab'}});
 // A strict UI result is never a note, a report, a write or work.
 for(const say of ['Toggle the left sidebar','Open Gmail in a split','Go back','Split the screen right','Open up the graph view']){const made=await ask(say);assert.equal(made.stage,'confirmed',say);assert.deepEqual(Object.keys(made.routed).sort(),['context','engine','obsidian','reply','tier']);assert.notEqual(made.routed.obsidian.op,'open-note')}
 assert.deepEqual(await ask('What did the streak plan say about Fridays?'),{kind:null,stage:'door',reason:'ui:refused-word|open:refused-word'});
 assert.equal((await ask('Pop open the quarterly forecast memo')).reason,'no-match');assert.equal((await ask('Pop open the draft script')).reason,'ambiguous:2');
 // A kind that is switched off may be recognised, but it is never finished.
 assert.deepEqual(await ask('Pop open the streak plan',{kinds:['ui']}),{kind:'open',stage:'door',reason:'kind-off'});assert.deepEqual(await ask('Close this tab please',{kinds:['open']}),{kind:'ui',stage:'door',reason:'kind-off'});
 // The validators reject the command: nothing is returned in its place.
 assert.deepEqual(await ask('Close this tab please',{validateText:()=>null}),{kind:'ui',stage:'validator',reason:'invalid'});
 assert.deepEqual(await ask('Close this tab please',{validateText:()=>({tier:2,reply:'',engine:'luna',obsidian:{op:'command',id:'app:go-back',label:'back'}})}),{kind:'ui',stage:'validator',reason:'invalid'});
 assert.deepEqual(await ask('Close this tab please',{validateText:()=>{throw new Error('invalid')}}),{kind:'ui',stage:'validator',reason:'invalid'});
 // The open grammar accepts the words "daily note" as a target too, but they name no file: one reading, the UI command.
 const daily=await ask('Open up my daily note');assert.equal(daily.kind,'ui');assert.equal(daily.stage,'confirmed');assert.equal(JSON.stringify(daily.routed.obsidian),JSON.stringify({op:'daily-note'}));
 // A selected conversation makes the content-like rows abstain, as in Phase D.
 assert.equal((await ask('Open up the graph view',{workTarget:'task-1'})).stage,'door');
});

test('resolution has a budget; a file index that outlives it is owned until it settles and warms the cache',async t=>{
 const root=vault(t);let release;const owned=[];
 const slow=await strictCandidate({root,transcript:'Pop open the streak plan',tables,validateText,budgetMs:1,own:(work,controller)=>{owned.push({work,controller})}});
 // One millisecond is not enough for a cold index on any disk.
 if(slow.stage!=='confirmed'){assert.deepEqual(slow,{kind:'open',stage:'resolver',reason:'budget'});assert.equal(owned.length,1);await owned[0].work;assert.equal((await strictCandidate({root,transcript:'Pop open the streak plan',tables,validateText,budgetMs:50})).stage,'confirmed','the build that outlived its budget warmed the cache')}
 // Codex, build round 1: resolution is owned from the moment it starts, not from the moment its budget runs out,
 // so a shutdown that drains during the budget still sees it and can stop it.
 invalidateStrictIndex(root);const early=[];
 const pending=strictCandidate({root,transcript:'Pop open the streak plan',tables,validateText,budgetMs:5000,own:(work,controller)=>early.push({work,controller})});
 assert.equal(early.length,1,'resolution was not owned before its first await');early[0].controller.abort();
 assert.deepEqual(await pending,{kind:'open',stage:'resolver',reason:'error'});await early[0].work.catch(()=>{});
 // Shutdown tells a running resolution to stop.
 invalidateStrictIndex(root);const stop=new AbortController();stop.abort();
 assert.deepEqual(await strictCandidate({root,transcript:'Pop open the streak plan',tables,validateText,signal:stop.signal}),{kind:'open',stage:'resolver',reason:'error'});
 void release;
});

test('off runs nothing; shadow waits for the answer; on returns a rules result with provenance',async t=>{
 const root=vault(t);
 const off=strictRules({root,id:'off-1',config:{open:'off',ui:'off'},log:()=>assert.fail('off never records'),evaluate:()=>assert.fail('off never evaluates')});
 assert.equal(off.active,false);assert.equal(await off.atBoundary({transcript:'Close this tab please',validateText,tables}),null);off.returned();
 assert.equal(strictRules({root,id:'off-2',config:{open:'launch'}}).active,false);assert.equal(strictRules({root,id:'off-3',config:null}).active,false);
 // Shadow: nothing is evaluated before the caller has its answer.
 const records=[];let evaluated=0;
 const shadow=strictRules({root,id:'shadow-1',config:{open:'shadow',ui:'shadow'},log:(_root,_id,record)=>records.push(record),evaluate:async options=>{evaluated++;return strictCandidate(options)}});
 assert.equal(await shadow.atBoundary({transcript:'Close this tab please',validateText,tables}),null);
 await tick(20);assert.equal(evaluated,0,'a would-be check ran before the answer');assert.equal(classifierProcesses().checks,1,'the pending record is owned');
 shadow.returned();await settle();
 assert.equal(evaluated,1);assert.equal(records.length,1);assert.deepEqual({...records[0],ts:null,evaluatedAt:null,ms:null},{id:'shadow-1',ts:null,mode:{open:'shadow',ui:'shadow'},blockedBy:null,candidate:{kind:'ui',action:{obsidian:{op:'command',id:'workspace:close',label:'close tab'}}},kind:'ui',stage:'confirmed',reason:null,acted:false,deferred:true,evaluatedAt:null,ms:null});
 // On: a confirmed action comes back at once, as a rules result with its provenance.
 const taken=[];const on=strictRules({root,id:'on-1',config:{open:'on',ui:'on'},log:(_root,_id,record)=>taken.push(record)});
 const result=await on.atBoundary({transcript:'Pop open the streak plan',validateText,tables,preModelMs:7});on.returned();await settle();
 assert.deepEqual(result.obsidian,{op:'open-note',query:'projects/streak-plan.md'});assert.equal(result.engine,'rules');
 assert.deepEqual({...result.decision,timing:null},{boundary:'general',source:'rules',rule:'router.strictOpen',rawIntent:{tier:2,kind:'local-open'},guarded:{tier:2},jev:null,fallbackModel:null,timing:null});assert.equal(result.decision.timing.preModelMs,7);
 assert.equal(taken[0].acted,true);assert.equal(taken[0].deferred,false);
 // A blocked request never parses or resolves its own sentence before the answer.
 let inline=0;const blocked=strictRules({root,id:'on-2',config:{open:'on',ui:'on'},log:(_root,_id,record)=>taken.push(record),evaluate:async options=>{inline++;return strictCandidate(options)}});
 assert.equal(await blocked.atBoundary({transcript:'Close this tab please',validateText,tables,workTarget:'task-9'}),null);assert.equal(inline,0);
 blocked.returned();await settle();assert.equal(inline,1);assert.equal(taken.at(-1).blockedBy,'frame:selected');assert.equal(taken.at(-1).deferred,true);assert.equal(taken.at(-1).acted,false);
 // One kind on, the other only watched: the watched kind is never finished inline.
 const mixed=strictRules({root,id:'mixed-1',config:{open:'shadow',ui:'on'},log:(_root,_id,record)=>taken.push(record)});
 assert.equal(await mixed.atBoundary({transcript:'Pop open the streak plan',validateText,tables}),null);mixed.returned();await settle();
 assert.equal(taken.at(-1).acted,false);assert.deepEqual(taken.at(-1).candidate?.kind,'open');assert.equal(taken.at(-1).deferred,true);
 // A cancelled request is not answered by the rules.
 const gone=new AbortController();gone.abort();const cancelled=strictRules({root,id:'on-3',config:{open:'on',ui:'on'},log:()=>{}});
 assert.equal(await cancelled.atBoundary({transcript:'Close this tab please',validateText,tables,signal:gone.signal}),null);cancelled.returned();await settle();
 // A request that was cancelled while the rules were deciding is looked at no further: no action, no record.
 const midway=new AbortController(),silent=[];const dropped=strictRules({root,id:'on-5',config:{open:'on',ui:'on'},log:(_root,_id,record)=>silent.push(record),evaluate:async options=>{midway.abort();return strictCandidate(options)}});
 assert.equal(await dropped.atBoundary({transcript:'Close this tab please',validateText,tables,signal:midway.signal}),null);dropped.returned();await settle();assert.deepEqual(silent,[]);
 // A logging failure stays here.
 const noisy=strictRules({root,id:'on-4',config:{open:'on',ui:'on'},log:()=>{throw new Error('disk full')}});
 assert.ok(await noisy.atBoundary({transcript:'Close this tab please',validateText,tables}));noisy.returned();await settle();
});

test('shutdown releases a queued record even if its scheduler never fires, and admits nothing while draining',async t=>{
 const root=vault(t);let evaluated=0;
 const stuck=strictRules({root,id:'drain-1',config:{open:'shadow',ui:'shadow'},log:()=>assert.fail('nothing is written during shutdown'),defer:()=>{},evaluate:async()=>{evaluated++;return {kind:null,stage:'door',reason:'test'}}});
 await stuck.atBoundary({transcript:'Close this tab please',validateText,tables});stuck.returned();await tick(10);
 assert.equal(classifierProcesses().checks,1);
 assert.deepEqual(await drainDetachedClassifiers({timeoutMs:200}),{drained:0,remaining:0});assert.equal(evaluated,0);assert.equal(classifierProcesses().total,0);
});

test('no unhandled rejections escaped and nothing is left owned',async()=>{await tick(40);assert.deepEqual(unhandled,[]);assert.equal(classifierProcesses().total,0)});
