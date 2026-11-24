// Every built-in button tells the member what it produces and what it needs. Until 2026-11-23 all 21 said only
// "Complete the X workflow.", and a new member's first two buttons (Plan Today, Inbox Brief) ended "blocked" with
// nothing to explain why. The needs below are what each workflow asked for on a blank vault with no accounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SKILLS} from '../shared/contract.mjs';
import {builtinDescription} from '../shared/dashboard.mjs';
import {readDashboard} from '../runner/dashboard.mjs';

const buttons = Object.entries(SKILLS).filter(([id]) => id !== 'voice-ask');

test('every built-in workflow has a plain description and a needs list; none is the old placeholder', () => {
  assert.equal(buttons.length, 21);
  for (const [id, skill] of buttons) {
    assert.ok(typeof skill.about === 'string' && skill.about.length >= 40 && skill.about.length <= 200, `${id} about`);
    assert.doesNotMatch(skill.about, /^Complete the .* workflow\.$/, id);
    assert.match(skill.about, /\.$/, `${id} ends as a sentence`);
    assert.ok(Array.isArray(skill.needs), `${id} needs`);
    for (const need of [...skill.needs, ...(skill.better || [])]) assert.ok(typeof need === 'string' && need.length > 3 && !/\.$/.test(need), `${id}: ${need}`);
    assert.doesNotMatch(JSON.stringify([skill.about, skill.needs, skill.better]), /chase|skool/i, `${id} carries nothing personal`);
  }
});

test('what stopped on a blank vault says what it needs, and what finished needs nothing it did not have', () => {
  const needs = id => SKILLS[id].needs.join(' | ');
  for (const id of ['plan-today', 'plan-tomorrow', 'refresh-schedule']) assert.match(needs(id), /Google Calendar/, id);
  for (const id of ['inbox-brief', 'morning']) assert.match(needs(id), /Gmail/, id);
  for (const id of ['yt-week-review', 'outlier-radar', 'yt-pipeline', 'metrics-pull']) assert.match(needs(id), /YouTube API key/, id);
  assert.match(needs('lead-research'), /leads database/);
  for (const id of ['content-cascade', 'yt-pipeline']) assert.match(needs(id), /yt-dlp/, id);
  // These finished with nothing connected.
  for (const id of ['vault-summary', 'vault-cleanup', 'deep-research-chase', 'morning-intel', 'morning-report', 'ai-trend-scan', 'angle-brainstorm', 'outline-build']) assert.deepEqual(SKILLS[id].needs, [], id);
  assert.match(SKILLS['morning-intel'].better.join(' '), /Gmail.*YouTube API key/);
});

test('the description a member sees is the sentence, then what it needs, then what makes it better', () => {
  assert.equal(builtinDescription(SKILLS['vault-summary']), SKILLS['vault-summary'].about);
  assert.equal(builtinDescription(SKILLS['plan-today']), `${SKILLS['plan-today'].about} Needs Google Calendar connected in your coding tool.`);
  assert.match(builtinDescription(SKILLS['refresh-schedule']), /Needs Google Calendar connected in your coding tool; today's daily note\.$/);
  assert.match(builtinDescription(SKILLS['deep-research-chase']), /disagreements\. Better with a YouTube API key .*\(adds video sources\)\.$/);
  assert.equal(builtinDescription({instruction: 'Old text.'}), 'Old text.', 'an entry without the new fields keeps its old text');
  assert.equal(builtinDescription(undefined), '');
});

test('dashboard list hands the agent and both apps the description and the needs for each built-in', t => {
  const vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-catalog-')));
  t.after(() => fs.rmSync(vault, {recursive: true, force: true}));
  fs.writeFileSync(path.join(vault, '.agentic-os-v2-test-vault'), 'agentic-os-v2-only');
  const listed = readDashboard(vault), builtins = listed.catalog.filter(entry => entry.kind === 'builtin');
  assert.equal(builtins.length, 21);
  const plan = builtins.find(entry => entry.id === 'plan-today');
  assert.equal(plan.description, builtinDescription(SKILLS['plan-today']));
  assert.deepEqual(plan.needs, ['Google Calendar connected in your coding tool']);
  assert.equal('better' in plan, false);
  assert.ok(builtins.find(entry => entry.id === 'morning-intel').better.length === 2);
  for (const entry of builtins) assert.doesNotMatch(entry.description, /^Complete the/, entry.id);
});
