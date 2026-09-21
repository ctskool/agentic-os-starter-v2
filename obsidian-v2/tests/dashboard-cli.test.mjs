import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {dashboardCommand} from '../scripts/aos/dashboard.mjs';
import {MARKER} from '../shared/contract.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-dashboard-cli-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, MARKER), 'agentic-os-v2-only');
  const options = {home: path.join(root, 'home'), skillRoots: [], cliAvailable: () => true};
  const command = (action, flags = {}) => {
    let result;
    dashboardCommand({words: [action], flags: {vault: root, ...flags}, options,
      log: text => { result = JSON.parse(text); }});
    return result;
  };
  return {root, command, options};
}

test('onboarding CLI saves the approved ordered selection and resets without installing or starting services', t => {
  const {command} = fixture(t);
  const original = command('list');
  assert.equal(original.selected, null);
  const chosen = command('select', {revision: original.revision, skills: 'weekly-review,plan-today'});
  assert.deepEqual(chosen.selected, ['weekly-review', 'plan-today']);
  assert.deepEqual(command('list').selected, chosen.selected);
  assert.throws(() => command('select', {revision: original.revision, skills: 'inbox-brief'}), /changed|revision|conflict/i);
  const empty = command('select', {revision: chosen.revision, skills: 'none'});
  assert.deepEqual(empty.selected, []);
  assert.equal(command('reset', {revision: empty.revision}).selected, null);
});

test('onboarding CLI requires explicit revisions, known IDs and an installed vault', t => {
  const {root, command, options} = fixture(t);
  assert.throws(() => command('select', {skills: 'plan-today'}), /revision/);
  assert.throws(() => command('select', {revision: command('list').revision, skills: 'made-up-skill'}), /unknown|registered|catalog/i);
  assert.throws(() => command('select', {revision: command('list').revision, skills: 'plan-today,plan-today'}), /different|duplicate/i);
  assert.throws(() => command('list', {unexpected: true}), /Unknown dashboard flag/);
  assert.throws(() => dashboardCommand({words: ['list'], flags: {vault: 'relative'}, options}), /absolute/);
  assert.throws(() => dashboardCommand({words: ['list'], flags: {vault: path.join(root, 'missing')}, options}), /ENOENT/);
});

test('onboarding CLI registers only a selected skill file and keeps it out of the button list until approved', t => {
  const {root, command} = fixture(t);
  const folder = path.join(root, 'my-skill');
  fs.mkdirSync(folder);
  const file = path.join(folder, 'SKILL.md');
  fs.writeFileSync(file, '---\nname: proposal\ndescription: Draft a client proposal.\n---\nAsk for the brief, then draft the proposal.\n');
  const added = command('add', {revision: command('list').revision, path: file, provider: 'claude'});
  assert.equal(added.selected, null);
  assert.ok(added.registeredId);
  const skill = added.catalog.find(item => item.id === added.registeredId);
  assert.deepEqual(skill.providers, ['claude']);
  assert.equal(skill.kind, 'installed');
  const saved = command('select', {revision: added.revision, skills: 'plan-today,' + added.registeredId});
  assert.deepEqual(saved.selected, ['plan-today', added.registeredId]);
  assert.throws(() => command('discover', {provider: 'both'}), /claude or codex/);
});
