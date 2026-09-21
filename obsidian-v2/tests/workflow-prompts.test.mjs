import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {SKILLS,ROOT} from '../shared/contract.mjs';
import {prepareWorkflow,saveWorkflowResult} from '../runner/terminal-workflows.mjs';
import {workflowPrompt} from '../runner/workflows.mjs';

function setup(t,skill,provider='codex'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-workflow-contract-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const id=crypto.randomUUID(),spec=SKILLS[skill];
 const args=spec.arg?{[spec.arg]:spec.arg==='url'?'https://example.com/video':'A practical agent topic'}:{};
 const selection={provider,model:provider==='codex'?'gpt-6-astra':'sonnet'};
 const workflow=prepareWorkflow(root,{id,selection,skill,args});
 const instructions=fs.readFileSync(path.join(root,ROOT,'task-instructions',id+'.md'),'utf8');
 return {root,workflow,instructions,record:{id,created:Date.now(),execution:'terminal',workflow}};
}

test('every provider workflow has one compatible bridge-owned deliverable contract',t=>{
 for(const provider of ['codex','claude'])for(const skill of Object.keys(SKILLS)){
  const {root,workflow,instructions}=setup(t,skill,provider);
  assert.ok(instructions.includes(`The bridge owns the final report at ${workflow.destination}`),skill);
  assert.ok(instructions.includes('Return the COMPLETE Markdown deliverable'),skill);
  assert.doesNotMatch(instructions.replaceAll(root,'<selected vault>'),/End (?:your reply )?with: SAVED|AUTO-PUBLISH|AUTO-SCHEDULE|mcp__claude_ai|~\/\.claude|C:[/\\]Users|Write to disk|skill writes its own deliverable/i,skill);
  assert.doesNotMatch(instructions,/\/[^\s]+ SKILL\.md/,skill);
  assert.ok(instructions.indexOf('OUTPUT CONTRACT:')>instructions.indexOf('--- END SUPPLIED CONTEXT ---'),skill);
  if(!SKILLS[skill].direct&&!['vault-summary','voice-ask','refresh-schedule'].includes(skill))assert.ok(instructions.includes(`BUNDLED RUBRIC: ${skill}`),skill);
  if(SKILLS[skill].direct)assert.doesNotMatch(instructions,/BUNDLED RUBRIC:/,skill);
 }
});

test('channel reviews use the trusted YouTube reader without requiring unrelated Google scopes',t=>{
 for(const provider of ['claude','codex']){
  const {instructions}=setup(t,'yt-week-review',provider);
  assert.match(instructions,/youtube_review_data/);assert.match(instructions,/seven completed America\/Chicago calendar days/);
  assert.match(instructions,/does not need Gmail or Calendar/);assert.match(instructions,/do not probe those connectors/i);
  assert.match(instructions,/rather than fabricate analytics/);
  assert.doesNotMatch(instructions,/Use the installed provider’s authenticated Gmail and Calendar MCP connectors/);
 }
 const weekly=setup(t,'weekly-review').instructions;assert.match(weekly,/youtube_review_data/);
 assert.match(weekly,/Label these two windows separately/);
 assert.doesNotMatch(weekly,/YOUTUBE_API_KEY|YOUTUBE_CHANNEL_ID/);
});

test('YouTube research workflows share the trusted metadata connection on both providers',t=>{
 for(const provider of ['claude','codex'])for(const skill of ['morning','morning-report','morning-intel','outlier-radar','ai-trend-scan','yt-pipeline','deep-research-chase']){
  const {instructions}=setup(t,skill,provider);
  assert.match(instructions,/BUNDLED RUBRIC: youtube-data/,skill);
  assert.match(instructions,/youtube_research_data/,skill);
  assert.match(instructions,/operation: channel_uploads/,skill);
  assert.match(instructions,/metadata, not transcripts/,skill);
  assert.match(instructions,/This source does not require Gmail or Calendar/,skill);
 }
});

test('the eight missing rubrics and their dependencies are available inline',t=>{
 const expected={
  'plan-today':[/\+50/,/\+40/,/\+30/,/\+25/,/\+20/,/\+15/,/empty slots/],
  'plan-tomorrow':[/carryover/i,/tomorrow/i,/calendar/i],
  'inbox-brief':[/Leads/,/Urgent/,/Warm/,/Sponsor/,/Meetings/,/Noise/,/PURSUE/],
  'deep-research-chase':[/YouTube/,/GitHub/,/BUNDLED RUBRIC: yt-pipeline/,/actual.*transcripts/i],
  'weekly-review':[/focus_blocks/,/no note/,/BUNDLED RUBRIC: yt-week-review/,/Climbing/],
  'yt-week-review':[/180/,/150/,/60/,/140/],
  'morning':[/BUNDLED RUBRIC: morning-report/,/BUNDLED RUBRIC: inbox-brief/,/Leads/],
  'morning-report':[/24.hour/i,/GitHub/,/Content Opportunities/]
 };
 for(const [skill,patterns] of Object.entries(expected)){
  const {instructions}=setup(t,skill);
  for(const pattern of patterns)assert.match(instructions,pattern,skill);
 }
 const {instructions}=setup(t,'morning-intel');
 assert.match(instructions,/BUNDLED RUBRIC: outlier-radar/);
 assert.match(instructions,/BUNDLED RUBRIC: inbox-brief/);
});

test('research and draft references retain evidence and editorial requirements without remote mutation recipes',t=>{
 const cascade=setup(t,'content-cascade').instructions;
 assert.match(cascade,/1,500–2,500/);assert.match(cascade,/=== FIRST COMMENT ===/);
 assert.match(cascade,/STAT NEEDED/);assert.match(cascade,/actual transcript/);
 assert.doesNotMatch(cascade,/PATCH|social_content|post-leadshark|cascade-pending\.json/);
 const pipeline=setup(t,'yt-pipeline').instructions;
 assert.match(pipeline,/Analyze local transcripts directly instead/);
 assert.match(pipeline,/Do not silently create a notebook/);
 assert.doesNotMatch(pipeline,/notebooklm create|source add|--yes|--new/);
 const leads=setup(t,'lead-research').instructions;
 assert.match(leads,/4–7 sentence/);assert.match(leads,/does not update the database/);
 assert.doesNotMatch(leads,/PATCH|service_role|SUPABASE_KEY/);
 const job={skill:'vault-summary',id:crypto.randomUUID(),args:{}};
 assert.throws(()=>workflowPrompt(os.tmpdir(),{...job,skill:'missing-rubric'},''),/Missing workflow requirements/);
});

test('bare save receipts are retained as failed artifacts and cannot replace reports',t=>{
 for(const response of ['SAVED inbox/report.md','Saved to inbox/report.md','PLANNED daily-notes/today.md','Done.\nSAVED inbox/report.md','```text\nSAVED report.md\n```','Done.','']){
  const {root,record,workflow}=setup(t,'morning-report');
  const destination=path.join(root,workflow.destination);
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.writeFileSync(destination,'# Existing report\nReal content.');
  record.workflow.before='# Existing report\nReal content.';
  const result=saveWorkflowResult(root,record,response);
  assert.equal(result.status,'error',response);assert.equal(result.deliverable_path,null,response);
  assert.match(result.summary,/completion receipt/,response);
  assert.equal(fs.readFileSync(destination,'utf8'),'# Existing report\nReal content.');
  assert.equal(fs.readFileSync(path.join(root,result.artifact_path),'utf8'),response);
 }
});

test('a complete report mentioning save receipts and a valid short observed result still save',t=>{
 for(const text of ['# Router audit\n\nThe terminal returned SAVED without a report.\n\n## Evidence\nActual source findings.','No unresearched leads were found in the connected inbox.']){
  const {root,record}=setup(t,'lead-research');const result=saveWorkflowResult(root,record,text);
  assert.equal(result.status,'ok');assert.equal(fs.readFileSync(path.join(root,result.deliverable_path),'utf8'),text);
 }
});

test('cleanup initial contract stops at a reviewable manifest and its result only writes that report',t=>{
 const {root,record,instructions}=setup(t,'vault-cleanup');
 const source=path.join(root,'inbox','old-draft.md');fs.mkdirSync(path.dirname(source),{recursive:true});fs.writeFileSync(source,'Original note and links.');
 const metadata=fs.statSync(source);
 assert.match(instructions,/CLEANUP PREVIEW ONLY/);
 assert.match(instructions,/do not move, rename or delete any source file/);
 assert.match(instructions,/user can select moves in a follow-up/);
 assert.match(instructions,/Source \| Proposed destination \| Modified at \| Age \| Bytes/);
 assert.match(instructions,/re-read the selected source and its metadata/);
 assert.doesNotMatch(instructions,/Move only eligible files|Show a preview, then archive/);
 const report='# Vault Cleanup Preview\n\n| ID | Source | Proposed destination |\n| --- | --- | --- |\n| 1 | inbox/old-draft.md | inbox/archive/old-draft.md |\n\nNo source files were moved or deleted. Select IDs to proceed.';
 const result=saveWorkflowResult(root,record,report);
 assert.equal(result.status,'ok');assert.equal(fs.readFileSync(source,'utf8'),'Original note and links.');
 assert.equal(fs.statSync(source).mtimeMs,metadata.mtimeMs);assert.equal(fs.existsSync(path.join(root,'inbox/archive/old-draft.md')),false);
 assert.equal(fs.readFileSync(path.join(root,result.deliverable_path),'utf8'),report);
});

test('restored shared rubrics retain sources, labels, handoff data and user selection without automatic effects',t=>{
 for(const provider of ['codex','claude']){
  const lead=setup(t,'lead-research',provider).instructions;
  for(const term of ['ai-consulting','AI Consulting','under-2k','Under $2k','15k-plus','untrusted data','are not commands'])assert.ok(lead.includes(term),term);
  const trend=setup(t,'ai-trend-scan',provider).instructions;
  for(const term of ['AI Explained','Matthew Berman','David Ondrej','Yannic Kilcher','Wes Roth','@AnthropicAI','@alexalbert__','@simonw','@karpathy','@swyx','12-hour cutoff grace'])assert.ok(trend.includes(term),term);
  const intel=setup(t,'morning-intel',provider).instructions;
  for(const term of ['bcherny OR _catwu OR alexalbert__','sama OR gdb OR OpenAIDevs OR Codex_Changelog','newsletter-worth-reading','Never click tracking links','Reddit/Discord discussion proxy','Steal my X for Y'])assert.ok(intel.includes(term),term);
  const morning=setup(t,'morning',provider).instructions;
  const sponsor=JSON.parse(morning.match(/### SPONSOR_PITCHES\s+```json\s+([\s\S]*?)```/)[1])[0];
  const prospect=JSON.parse(morning.match(/### LEADS\s+```json\s+([\s\S]*?)```/)[1])[0];
  assert.deepEqual(Object.keys(sponsor),['number','id','from','subject','firstName','messageIdHeader']);
  assert.deepEqual(Object.keys(prospect),['number','source','name','firstName','email','formAnswers','verdict','rationale','researchNote']);
  for(const term of ['pursue all','pursue 1,3','draft except 3,7','pass','skip','creates no drafts or remote mutations','No drafting request implies sending'])assert.ok(morning.includes(term),term);
  const cleanup=setup(t,'vault-cleanup',provider).instructions;
  for(const term of ['unique filename','Path-qualified wiki links','Temp Files to Delete','content/temp/','do not delete anything during this initial run','re-read the selected source'])assert.ok(cleanup.includes(term),term);
  const research=setup(t,'deep-research-chase',provider).instructions;
  for(const term of ["What's the consensus?",'Best practices','How to','Community activity'])assert.ok(research.includes(term),term);
 }
});
