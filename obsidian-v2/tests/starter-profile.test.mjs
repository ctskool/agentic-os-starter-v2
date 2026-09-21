import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {DEFAULT_DRIVERS,dailyDrivers,rubricWithDrivers} from '../runner/profile.mjs';
import {mergeDaily,workflowPrompt,pythonCommand} from '../runner/workflows.mjs';
import {TIME_ZONE} from '../shared/timezone.mjs';

function vaultWith(profile){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-profile-'));
 if(profile!==undefined){fs.mkdirSync(path.join(root,'system/v2'),{recursive:true});fs.writeFileSync(path.join(root,'system/v2/profile.json'),typeof profile==='string'?profile:JSON.stringify(profile))}
 return root;
}
const OWNER_NOTE='## Daily Drivers\n- [ ] Skool post\n- [ ] YouTube recording\n- [ ] Inbox triage\n- [ ] Daily review\n\n## Activity Log';

test('a vault without a profile plans exactly as before',()=>{
 for(const root of [vaultWith(),vaultWith('not json'),vaultWith({dailyDrivers:[]}),vaultWith({dailyDrivers:['ok','two\nlines']}),vaultWith({dailyDrivers:['a','a']}),
  vaultWith({dailyDrivers:['[x] done']}),vaultWith({dailyDrivers:Array.from({length:9},(_,index)=>'driver '+index)}),vaultWith({dailyDrivers:'Inbox triage'})])
  assert.equal(dailyDrivers(root),DEFAULT_DRIVERS);
 assert.ok(mergeDaily(null,'2026-01-05','- 09:00 — Planning').includes(OWNER_NOTE));
 assert.ok(mergeDaily(null,'2026-01-05','- 09:00 — Planning',[],dailyDrivers(vaultWith())).includes(OWNER_NOTE));
 const prompt=workflowPrompt(vaultWith(),{skill:'plan-today',id:crypto.randomUUID(),args:{}},'');
 assert.ok(prompt.includes('Default new-note drivers are Skool post, YouTube recording, Inbox triage and Daily review.'));
});

test('a vault with its own Daily Drivers gets them in the new note and in both planning rubrics',()=>{
 const root=vaultWith('\uFEFF'+JSON.stringify({dailyDrivers:['Inbox triage','Deep work block','Daily review']}));
 assert.deepEqual(dailyDrivers(root),['Inbox triage','Deep work block','Daily review']);
 const note=mergeDaily(null,'2026-01-05','- 09:00 — Planning',[],dailyDrivers(root));
 assert.ok(note.includes('## Daily Drivers\n- [ ] Inbox triage\n- [ ] Deep work block\n- [ ] Daily review\n\n## Activity Log'));
 assert.equal(note.includes('Skool'),false);
 const today=workflowPrompt(root,{skill:'plan-today',id:crypto.randomUUID(),args:{}},'');
 assert.ok(today.includes('Default new-note drivers are Inbox triage, Deep work block and Daily review.'));
 const tomorrow=workflowPrompt(root,{skill:'plan-tomorrow',id:crypto.randomUUID(),args:{}},'');
 assert.ok(tomorrow.includes('Driver defaults: Inbox triage, Deep work block, Daily review;'));
 for(const prompt of [today,tomorrow])assert.equal(/Skool post|YouTube recording/.test(prompt),false);
 assert.equal(rubricWithDrivers('Default new-note drivers are Skool post, YouTube recording, Inbox triage and Daily review.',['Only one']),'Default new-note drivers are Only one.');
});

test('an existing note keeps whatever drivers it already has',()=>{
 const before='---\ndate: 2026-01-05\nschema_version: 1\n---\n# 2026-01-05\n\n## Top 3 Priorities\n1. [ ] \n2. [ ] \n3. [ ] \n\n## Schedule\n\n## Daily Drivers\n- [x] My own thing\n\n## Notes\n';
 const after=mergeDaily(before,'2026-01-05','- 10:00 — Call',['Ship it'],['Different','Defaults']);
 assert.ok(after.includes('- [x] My own thing'));assert.equal(after.includes('Different'),false);assert.ok(after.includes('1. [ ] Ship it'));
});

test('planning prompts name this computer\'s time zone, and python resolves per platform',()=>{
 const prompt=workflowPrompt(vaultWith(),{skill:'plan-today',id:crypto.randomUUID(),args:{}},'');
 assert.ok(prompt.includes(`Use ${TIME_ZONE} to determine today.`));
 if(TIME_ZONE!=='America/Chicago')assert.equal(prompt.includes('America/Chicago'),false);
 assert.equal(TIME_ZONE,new Intl.DateTimeFormat().resolvedOptions().timeZone);
 assert.equal(pythonCommand({},'win32'),'python');assert.equal(pythonCommand({},'darwin'),'python3');assert.equal(pythonCommand({},'linux'),'python3');
 assert.equal(pythonCommand({AOS_V2_PYTHON:'/opt/py/bin/python'},'darwin'),'/opt/py/bin/python');
});
