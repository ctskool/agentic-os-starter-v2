import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {routeVoice} from '../runner/bridge-core.mjs';
import {invalidateVoiceSnapshot} from '../runner/voice-router.mjs';
import {invalidateTargetIndex} from '../runner/voice-targets.mjs';
import {localDate} from '../runner/brief-voice.mjs';
import {shiftIso} from '../runner/spoken-dates.mjs';

// End-to-end through routeVoice with fake terminals: the exact utterances from
// the 2026-09-15/16 transcripts, plus dated, named, ambiguous and worker-file asks.
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'voice-open-routing-')));
 t.after(()=>{invalidateVoiceSnapshot(root);invalidateTargetIndex(root);fs.rmSync(root,{recursive:true,force:true})});
 const write=(relative,text='# Saved report\n')=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return relative};
 const today=localDate(),yesterday=shiftIso(today,-1),older=shiftIso(today,-4);
 const intel={today:write(`inbox/research/morning-intel/${today}-intel.md`,'## Top Story\nA saved public headline.\n'),yesterday:write(`inbox/research/morning-intel/${yesterday}-intel.md`),older:write(`inbox/research/morning-intel/${older}-intel.md`)};
 write('projects/2026-05-10-skoot-crm-playbook.md');write('projects/2026-04-30-content-backfill-plan.md');write('projects/2026-05-02-content-calendar-plan.md');
 const calls=[],sessions=[],reopened=[];
 const terminals={live:new Map(),list:()=>sessions,get:id=>{const s=sessions.find(s=>s.id===id);if(!s)throw new Error('Task not found');return s},start:task=>{calls.push({kind:'start',...task});return {id:task.id}},send:(id,text)=>{calls.push({kind:'send',id,text})},startWorkflow:task=>{calls.push({kind:'workflow',...task});return {id:task.id}}};
 const speak=(transcript,{provider='codex',appScope='native',workTarget=null,execute=()=>assert.fail(`Opening must not call a model: ${transcript}`),conversationEpoch}={})=>routeVoice(root,{id:crypto.randomUUID(),selection:{provider,model:provider==='codex'?'gpt-6-astra':'sonnet'},appScope,transcript,terminalMode:true,workTarget,conversationEpoch},undefined,execute,terminals,{resolveCli:()=>({command:'unused',prefix:[]}),reopenArtifact:item=>reopened.push(item)});
 return {root,write,speak,terminals,calls,sessions,reopened,intel,today,yesterday,older};
}
const opened=(result,path)=>{assert.equal(result.deliverable,path);assert.equal(result.reveal,'open');assert.equal(result.reply,'');assert.equal(result.model,null);assert.equal(result.engine,'rules');assert.deepEqual(result.workIds,[]);assert.ok([undefined,'open'].includes(result.lookupRoute))};

for(const appScope of ['native','web'])test(`${appScope}: the September 16 phrasing opens today's brief instead of summarizing it`,async t=>{
 const f=fixture(t);
 opened(await f.speak('Can you pull up the morning Intel brief from this morning?',{appScope}),f.intel.today);
 opened(await f.speak('Can you pull up the morning Intel brief for me?',{appScope,provider:'claude'}),f.intel.today);
 opened(await f.speak("Open yesterday's intel brief",{appScope}),f.intel.yesterday);
 assert.equal(f.calls.length,0);
});

test('a dated report that does not exist gets an honest answer and an offer, and a bare yes accepts it',async t=>{
 const f=fixture(t);
 const missingDate=shiftIso(f.today,-2);
 const missing=await f.speak(`Pull up the intel from ${missingDate}`);
 assert.equal(missing.deliverable,null);assert.equal(missing.reveal,null);assert.match(missing.reply,/^I don't have a morning intel report for /);assert.match(missing.reply,/Want me to open that one\?$/);
 assert.equal(missing.lookup.source,'open-offer');assert.equal(missing.lookup.path,f.intel.older);
 opened(await f.speak('yes'),f.intel.older);
 const none=await f.speak('open the inbox brief from last week');
 assert.match(none.reply,/^I don't have an? inbox brief report for last week on file\.$/);assert.equal(none.lookup,undefined);
 assert.equal(f.calls.length,0);
});

test('named notes open by title, speech errors tolerated, and a tie becomes one question with a working follow-up',async t=>{
 const f=fixture(t);
 const note=(result,path)=>{assert.deepEqual(result.obsidian,{op:'open-note',query:path});assert.equal(result.reply,'');assert.equal(result.model,null);assert.equal(result.engine,'rules');assert.deepEqual(result.workIds,[])};
 note(await f.speak('Can you pull the scoot CRM playbook up?'),'projects/2026-05-10-skoot-crm-playbook.md');
 note(await f.speak('open the skoot playbook',{appScope:'web'}),'projects/2026-05-10-skoot-crm-playbook.md');
 const placed=await f.speak('open the skoot playbook on the right');
 assert.deepEqual(placed.obsidian,{op:'open-note',query:'projects/2026-05-10-skoot-crm-playbook.md',where:'right-sidebar'});assert.equal(placed.deliverable,null);
 const ambiguous=await f.speak('open the content plan');
 assert.match(ambiguous.reply,/^I found 2 that could match: content calendar plan or content backfill plan\. Which one\?$/);
 assert.equal(ambiguous.lookup.source,'open-candidates');assert.equal(ambiguous.deliverable,null);
 note(await f.speak('the second one'),'projects/2026-04-30-content-backfill-plan.md');
 const unknown=await f.speak('open the quarterly tax memo');
 assert.match(unknown.reply,/couldn't find anything named "the quarterly tax memo"/);assert.deepEqual(unknown.workIds,[]);
 assert.equal(f.calls.length,0);
});

test('a selected conversation reopens its registered file without a worker turn; an HTML-only result is explained',async t=>{
 const f=fixture(t);
 const png={id:'a'.repeat(40),taskId:'11111111-1111-4111-8111-111111111111',turnId:'t1',path:'system/v2/artifacts/files/'+'0'.repeat(64)+'.png',label:'Jev preview',mime:'image/png',bytes:4,open:true,isFinal:true};
 const task={id:png.taskId,provider:'codex',model:'gpt-6-astra',title:'Jev explainer',state:'ready',execution:'native',created:Date.now(),turns:[{id:'t1',ts:Date.now(),text:'Done.',artifacts:[png]}]};
 f.sessions.push(task);
 const shown=await f.speak("Can't you pull up that explainer in one of the obsidian tabs?",{workTarget:task.id});
 assert.deepEqual(f.reopened.map(r=>({taskId:r.taskId,artifactId:r.artifact.id})),[{taskId:task.id,artifactId:png.id}]);
 assert.deepEqual(shown.reopened,{taskId:task.id,artifactId:png.id,label:'Jev preview'});assert.equal(shown.reply,'');assert.deepEqual(shown.workIds,[]);assert.equal(shown.workTarget,task.id);
 await f.speak('Now, can you just pull it up for me? Can you pull up the report so I can see it inside of Obsidian?',{workTarget:task.id});
 assert.equal(f.reopened.length,2);assert.equal(f.calls.length,0);
 // Real work follow-ups still continue the conversation.
 await f.speak('change the colors to blue',{workTarget:task.id,execute:async()=>({text:JSON.stringify({tier:3,reply:'On it.'})})});
 assert.equal(f.calls.at(-1)?.kind,'send');assert.match(f.calls.at(-1).text,/^change the colors to blue/);
 const html={id:'22222222-2222-4222-8222-222222222222',provider:'codex',model:'gpt-6-astra',title:'HTML explainer',state:'ready',execution:'native',created:Date.now(),turns:[{id:'t1',ts:Date.now(),text:'Done.\n\n[View the explainer](<'+f.root.replace(/\\/g,'/')+'/outputs/jev-explainer/jev-explainer.html>)',artifactErrors:['This artifact type is not supported for preview.']}]};
 f.sessions.push(html);
 const explained=await f.speak('pull it up',{workTarget:html.id});
 assert.match(explained.reply,/^The file from that conversation is a \.html file, which I can't display in Obsidian or the dashboard\. It's saved at outputs\/jev-explainer\/jev-explainer\.html\.$/);
 assert.equal(f.reopened.length,2);assert.equal(f.calls.filter(c=>c.kind==='send').length,1);
});

test('what was just read aloud can be pulled up next, and questions are untouched',async t=>{
 const f=fixture(t);
 const headline=await f.speak('What was the top AI news today?');
 assert.match(headline.reply,/saved public headline/);assert.equal(headline.reveal,null);
 opened(await f.speak('pull that up'),f.intel.today);
 opened(await f.speak('can you show me the brief again'),f.intel.today);
 let calls=0;
 const question=await f.speak('What is my schedule looking like today?',{execute:async()=>{calls++;return {text:JSON.stringify({tier:2,reply:'Nothing scheduled.'})}}});
 assert.equal(question.reveal,null);assert.equal(question.deliverable,null);
 assert.equal(f.calls.length,0);
});

for(const {provider,appScope} of [{provider:'codex',appScope:'native'},{provider:'claude',appScope:'web'}])test(`${provider} on ${appScope}: a work request that only mentions open goes to the worker whole with the open promised, and never opens a saved run`,async t=>{
 const f=fixture(t);
 // The live vault on September 16: the newest run in the ledger was a content
 // cascade whose summary contains "and" and "your".
 f.write('inbox/reports/cascades/2026-09-15-1e089d8f.md','# cascade');
 f.write('system/runs/cascade.json',JSON.stringify({id:'cascade',skill:'content-cascade',status:'ok',summary:'The cascade is complete — blog is live, the LinkedIn post is scheduled, and the X tweet is drafted and waiting for your manual video upload.',deliverable_path:'inbox/reports/cascades/2026-09-15-1e089d8f.md',ts_completed:new Date().toISOString()}));
 invalidateVoiceSnapshot(f.root);invalidateTargetIndex(f.root);
 const ask='Actually, can you instead of explaining that, can you actually create using your image generation tool, a visual explainer of how Jev works? And once you create that, can you open it up for me?';
 const prompts=[];
 const result=await f.speak(ask,{provider,appScope,execute:async(root,_engine,prompt)=>{prompts.push(prompt);return {text:JSON.stringify({tier:3,reply:'Working on it.'})}}});
 assert.equal(result.deliverable,null);assert.equal(result.reveal,null);assert.equal(result.obsidian,null);
 assert.equal(result.skill,'voice-ask');assert.equal(result.workIds.length,1);assert.equal(result.openWhenDone,true);
 const [call]=f.calls;assert.equal(call.kind,'start');assert.equal(call.openWhenDone,true);
 assert.match(call.prompt,/visual explainer of how Jev works/);assert.match(call.prompt,/once you create that, can you open it up for me/);
 assert.match(call.prompt,/register the final file with the dashboard helper using --open/);
 // The saved run is still one ask away by name, without a model.
 assert.equal(call.selection.provider,provider);assert.equal(call.execution,appScope==='native'?'native':undefined);
 opened(await f.speak('show me the content cascade',{provider,appScope}),'inbox/reports/cascades/2026-09-15-1e089d8f.md');
 assert.equal((await f.speak('show me the trend scan',{provider,appScope})).reply,"I don't have an AI trend scan report on file.");
 assert.equal(f.calls.length,1);
});

test('a plain work request does not promise an open, and a continuation carries the promise to the selected conversation',async t=>{
 const f=fixture(t);
 const task={id:'22222222-2222-4222-8222-222222222222',provider:'codex',model:'gpt-6-astra',title:'Jev explainer',state:'ready',execution:'native',created:Date.now(),turns:[{id:'t1',ts:Date.now(),text:'Done.'}]};
 f.sessions.push(task);
 const model=()=>({text:JSON.stringify({tier:3,reply:'Working on it.'})});
 const plain=await f.speak('create a visual explainer of how jev works using your image generation tool',{execute:model});
 assert.equal(plain.workIds.length,1);assert.equal(plain.openWhenDone,undefined);assert.equal(f.calls.at(-1).openWhenDone,undefined);
 const followup=await f.speak("make the title larger and once it's done, open it up for me",{workTarget:task.id,execute:model});
 assert.equal(followup.openWhenDone,true);assert.deepEqual(followup.workIds,[task.id]);
 const sent=f.calls.at(-1);assert.equal(sent.kind,'send');assert.match(sent.text,/register the final file with the dashboard helper using --open/);
});
