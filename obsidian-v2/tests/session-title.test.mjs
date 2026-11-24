// A task asked for by voice was named after the first words said ("Yeah, can you do some research on…"). Claude Code
// writes a short title for every session, and the task takes that as its name (Chase, 2026-11-24).
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {claudeSessionTitle,claudeProjectFolder,cleanSessionTitle} from '../runner/session-title.mjs';
import {TerminalManager,TITLE_CHECK_MS,TITLE_RECHECK_MS} from '../runner/terminals.mjs';
import {taskStatusReply} from '../runner/task-updates.mjs';

const session='01a09b1a-fb81-4433-a9d7-d8333de6cbe0';
const row=value=>JSON.stringify(value)+'\n';

test('the title is the newest ai-title row of that session, and anything else is no title',t=>{
 const projects=fs.mkdtempSync(path.join(os.tmpdir(),'aos-title-'));t.after(()=>fs.rmSync(projects,{recursive:true,force:true}));
 const cwd=path.join('C:','Users','Member','My Vault'),folder=claudeProjectFolder(projects,cwd);
 assert.match(path.basename(folder),/^C-+Users-Member-My-Vault$/,'every character that is not a letter or digit becomes a dash');
 fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,session+'.jsonl');
 assert.equal(claudeSessionTitle(session,cwd,{projects}),null,'no session file yet');
 fs.writeFileSync(file,row({type:'user',sessionId:session,message:{content:'Yeah, can you do some research on Unreal Engine pricing'}}));
 assert.equal(claudeSessionTitle(session,cwd,{projects}),null,'the title has not been written yet');
 fs.appendFileSync(file,row({type:'ai-title',aiTitle:'Unreal Engine pricing research',sessionId:session})+'not json\n'+row({type:'assistant',sessionId:session,message:{content:[{type:'text',text:'"ai-title" is only mentioned here'}]}}));
 assert.equal(claudeSessionTitle(session,cwd,{projects}),'Unreal Engine pricing research');
 // A later title wins; a title for another session in the same file does not count.
 fs.appendFileSync(file,row({type:'ai-title',aiTitle:'  “Unreal vs Unity pricing” ',sessionId:session})+row({type:'ai-title',aiTitle:'Someone else',sessionId:'11111111-1111-4111-8111-111111111111'}));
 assert.equal(claudeSessionTitle(session,cwd,{projects}),'Unreal vs Unity pricing');
 assert.equal(claudeSessionTitle('not-a-session',cwd,{projects}),null);assert.equal(claudeSessionTitle(session,'',{projects}),null);
 for(const bad of ['',' ','ab','…','x'.repeat(81),null,42])assert.equal(cleanSessionTitle(bad),null);
 assert.equal(cleanSessionTitle('Plan\ttomorrow\nnotes'),'Plan tomorrow notes');
});

function fixture(t,titles={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-titled-'));let time=100000,reads=0;
 const manager=new TerminalManager(root,{directory:path.join(root,'work'),now:()=>time,schedule:()=>({unref(){}}),cancelSchedule(){},
  defer:()=>({unref(){}}),cancelDeferred(){},sessionTitle:id=>{reads++;return titles[id]??null},
  spawn:()=>({pid:900,write(){},onData(){},onExit(){},resize(){},kill(){}}),
 });
 t.after(()=>{manager.close();fs.rmSync(root,{recursive:true,force:true})});
 return {manager,titles,advance(ms){time+=ms},reads:()=>reads,get:id=>manager.list().find(task=>task.id===id)};
}

test('a free-form Claude task takes the session title while it works, and keeps the words it was asked in',t=>{
 const f=fixture(t);
 const task=f.manager.start({selection:{provider:'claude',model:'opus'},prompt:'Yeah, can you do some research on Unreal Engine pricing'});
 assert.equal(f.get(task.id).title,'Yeah, can you do some research on Unreal Engine pricing');
 const first=f.reads();f.manager.list();f.manager.list();
 assert.equal(f.reads(),first,'looked for at most once every few seconds, however often the list is read');
 f.titles[task.id]='Unreal Engine pricing research';f.advance(TITLE_CHECK_MS);
 const named=f.get(task.id);
 assert.deepEqual({title:named.title,requestTitle:named.requestTitle,titleSource:named.titleSource},{title:'Unreal Engine pricing research',requestTitle:'Yeah, can you do some research on Unreal Engine pricing',titleSource:'session'});
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.manager.folder(task.id),'session.json'),'utf8')).title,'Unreal Engine pricing research','the name is saved with the task');
 // Once it has a name it is looked at rarely, and a changed title is still picked up, at a turn's end at the latest.
 f.titles[task.id]='Unreal vs Unity pricing';f.advance(TITLE_CHECK_MS);assert.equal(f.get(task.id).title,'Unreal Engine pricing research');
 f.advance(TITLE_RECHECK_MS);assert.equal(f.get(task.id).title,'Unreal vs Unity pricing');
 f.titles[task.id]='Game engine pricing';
 f.manager.accept(task.id,{type:'Stop',sessionId:task.id,turnId:'turn-1',text:'Done.'});
 assert.deepEqual({title:task.title,requestTitle:task.requestTitle},{title:'Game engine pricing',requestTitle:'Yeah, can you do some research on Unreal Engine pricing'});
});

test('workflows, slash skills and Codex tasks keep their own names',t=>{
 const f=fixture(t),everything=new Proxy({},{get:()=>'A session title'});f.titles.__proto__=everything;
 const codex=f.manager.start({selection:{provider:'codex',model:'astra'},prompt:'Research RubyGems'});
 const slash=f.manager.start({selection:{provider:'claude',model:'opus'},prompt:'/today',slashSkill:true});
 f.advance(TITLE_CHECK_MS);f.manager.list();
 assert.equal(f.get(codex.id).title,'Research RubyGems');assert.equal(f.get(slash.id).title,'/today');
 for(const record of [{provider:'claude',workflow:{job:{skill:'inbox-brief'}},title:'inbox brief'},{provider:'claude',execution:'headless',title:'Morning Intel'},{provider:'claude',execution:'script',title:'metrics'}]){
  assert.equal(f.manager.refreshTitle({id:'x',state:'working',...record},{force:true}),false);
 }
});

test('a spoken status uses the name plainly once Claude Code has given one',()=>{
 const now=Date.now(),base={id:'a',state:'working',created:now-130000,turns:[]};
 const ask="What's going on? Why is this taking so long";
 assert.equal(taskStatusReply(ask,()=>[{...base,title:'Yeah, can you do some research on Unreal Engine pricing'}],['a'],now).reply,'Your request “Yeah, can you do some research on Unreal Engine pricing” is still running, 2 min in.');
 assert.equal(taskStatusReply(ask,()=>[{...base,title:'Unreal Engine pricing research',titleSource:'session'}],['a'],now).reply,'Unreal Engine pricing research is still running, 2 min in.');
});
