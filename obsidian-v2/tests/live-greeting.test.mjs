// The Live call greets the user by name once, with varied wording (2026-11-22).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {userName,pickGreeting,greetingOptions,liveGreeting} from '../runner/live/greeting.mjs';

test('the name comes from About me in the usual ways', () => {
 assert.equal(userName("I'm Chase. I run Chase AI."), 'Chase');
 assert.equal(userName('My name is Dana and I coach runners.'), 'Dana');
 assert.equal(userName('Name: Priya'), 'Priya');
 assert.equal(userName("I'm building a studio."), null, 'a lowercase word is not a name');
 assert.equal(userName("I'm a designer."), null);
 assert.equal(userName(''), null);
});

test('greetings use the name, or none, and never repeat back to back', () => {
 const morning = new Date(2026, 10, 23, 9, 0);
 let previous = null;
 for (let i = 0; i < 40; i++) {
  const line = pickGreeting({name: 'Chase', now: morning, previous, random: () => (i * 0.37) % 1});
  assert.match(line, /Chase/);
  assert.notEqual(line, previous);
  previous = line;
 }
 assert.doesNotMatch(pickGreeting({name: null, now: morning, random: () => 0}), /,\s*[,.?]|undefined|null/);
});

test('there are several options, and time-of-day ones only at the right time', () => {
 const at = hour => greetingOptions(new Date(2026, 10, 23, hour)).map(make => make(', Chase'));
 assert.ok(at(9).length >= 6);
 assert.ok(at(9).some(line => /^(?:Good m|M)orning/.test(line)));
 assert.ok(!at(15).some(line => /orning|vening/.test(line)));
 assert.ok(at(20).some(line => /vening|still at it/i.test(line)));
 assert.ok(!at(20).some(line => /orning/.test(line)));
});

test('liveGreeting reads the vault About me', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-greet-'));
 fs.writeFileSync(path.join(root, 'AGENTS.md'), "# Vault\n\n## About me\n\nI'm Sam. I make furniture.\n\n## Vault conventions\n");
 assert.match(liveGreeting(root, {random: () => 0}), /Sam/);
 const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-greet-'));
 assert.doesNotMatch(liveGreeting(empty, {random: () => 0}), /undefined|null/);
});
