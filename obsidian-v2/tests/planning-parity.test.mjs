import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {prepareWorkflow,saveWorkflowResult} from '../runner/terminal-workflows.mjs';
import {destinationFor} from '../runner/workflows.mjs';

const selection={provider:'codex',model:'gpt-6-astra'};
function fixture(t,skill='plan-tomorrow'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'v2-planner-parity-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const id=crypto.randomUUID(),workflow=prepareWorkflow(root,{id,skill,selection,args:{}});
 return {root,workflow,record:{id,created:Date.now(),execution:'terminal',workflow},file:path.join(root,workflow.destination),date:path.basename(workflow.destination,'.md')};
}
function note(date){return `---
date: ${date}
schema_version: 1
focus: "A concrete focus"
top3:
  - "Prepare the recording"
  - ""
  - ""
top3_done: [false, false, false]
effort: null
focus_blocks: null
posts_shipped:
  youtube: 0
  blog: 0
  linkedin: 0
  x: 0
  instagram: 0
  tiktok: 0
videos_shipped_today: 0
---
# ${date}

## Current Focus
A concrete focus

## Top 3 Priorities
1. [ ] Prepare the recording
2. [ ]\x20
3. [ ]\x20

## Schedule

## Daily Drivers
- [ ] Skool post
- [ ] YouTube recording
- [ ] Inbox triage
- [ ] Daily review
- [ ] Review the documented cascade draft

## Activity Log

## Notes
Yesterday's blocker was the missing recording outline. Preserve this context.

## EOD Reflection
`}

test('new plans retain frozen frontmatter, conditional drivers and Notes in the actual saved file',t=>{
 for(const skill of ['plan-today','plan-tomorrow']){
  const f=fixture(t,skill),answer=note(f.date),run=saveWorkflowResult(f.root,f.record,answer);
  assert.equal(run.status,'ok',run.summary);
  assert.equal(fs.readFileSync(f.file,'utf8'),answer.trim());
  assert.equal(fs.readFileSync(path.join(f.root,run.artifact_path),'utf8'),answer);
  assert.equal(fs.existsSync(path.join(f.root,'system/v2/backups',f.record.id+'.md')),false);
 }
});

test('invalid frozen fields, duplicate YAML, section order and automatic completion cannot create a daily note',t=>{
 const mutations=[
  text=>text.replace('focus: "A concrete focus"\n',''),
  text=>text.replace('schema_version: 1','schema_version: 2'),
  text=>text.replace('effort: null','effort: 8'),
  text=>text.replace('focus_blocks: null','focus_blocks: 0'),
  text=>text.replace('  linkedin: 0\n',''),
  text=>text.replace('  blog: 0','  blog: 1'),
  text=>text.replace('videos_shipped_today: 0','videos_shipped_today: 2'),
  text=>text.replace('top3_done: [false, false, false]','top3_done: [false, false]'),
  text=>text.replace('top3_done: [false, false, false]','top3_done: [true, false, false]'),
  text=>text.replace('schema_version: 1','schema_version: 1\nschema_version: 1'),
  text=>text.replace('1. [ ] Prepare the recording','1. [ ] Different priority'),
  text=>text.replace('- [ ] Daily review','- [x] Daily review'),
  text=>text.replace('## Current Focus','## Missing Focus'),
  text=>text.replace('## Activity Log\n','## Activity Log\n- Invented completed work\n')
 ];
 for(const mutate of mutations){
  const f=fixture(t),answer=mutate(note(f.date)),run=saveWorkflowResult(f.root,f.record,answer);
  assert.equal(run.status,'error');assert.match(run.summary,/frozen|YAML/);assert.equal(fs.existsSync(f.file),false);
  assert.equal(fs.readFileSync(path.join(f.root,run.artifact_path),'utf8'),answer);
 }
});

test('plan tomorrow refuses an existing note before instructions or work are created',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'v2-tomorrow-existing-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const id=crypto.randomUUID(),skill='plan-tomorrow',relative=destinationFor({id,skill,args:{}}),file=path.join(root,relative),before='User plan that must remain byte exact\r\n';
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,before);
 assert.throws(()=>prepareWorkflow(root,{id,skill,selection,args:{}}),/Tomorrow's note already exists/);
 assert.equal(fs.readFileSync(file,'utf8'),before);
 assert.equal(fs.existsSync(path.join(root,'system/v2/task-instructions',id+'.md')),false);
});

test('a note created after planning started survives completion with the proposal retained',t=>{
 const f=fixture(t),existing='A concurrent user-created tomorrow plan\r\n';
 fs.mkdirSync(path.dirname(f.file),{recursive:true});fs.writeFileSync(f.file,existing);
 const run=saveWorkflowResult(f.root,f.record,note(f.date));
 assert.equal(run.status,'error');assert.match(run.summary,/changed/);assert.equal(fs.readFileSync(f.file,'utf8'),existing);
 assert.match(fs.readFileSync(path.join(f.root,run.artifact_path),'utf8'),/Preserve this context/);
});

test('exclusive daily creation preserves a file appearing after the last comparison',t=>{
 const f=fixture(t),link=fs.linkSync,existing='A last-moment user creation\n';
 fs.linkSync=(source,destination)=>{assert.equal(destination,f.file);fs.writeFileSync(destination,existing,{flag:'wx'});return link(source,destination)};
 t.after(()=>{fs.linkSync=link});
 const run=saveWorkflowResult(f.root,f.record,note(f.date));
 assert.equal(run.status,'error');assert.match(run.summary,/created while this task ran/);
 assert.equal(fs.readFileSync(f.file,'utf8'),existing);assert.equal(fs.existsSync(f.file+'.'+f.record.id+'.tmp'),false);
 assert.match(fs.readFileSync(path.join(f.root,run.artifact_path),'utf8'),/Prepare the recording/);
});
