import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {routeVoice} from '../runner/bridge-core.mjs';
import {calendarQuestion,calendarCheck} from '../runner/calendar-check.mjs';
import {localDate} from '../runner/brief-voice.mjs';

test('calendar questions are told apart from changes, news and prices', () => {
 for (const text of [
  'do I have anything on my schedule for tomorrow? I need to know',
  "mind, never mind. Uh, do I have anything on my schedule for tomorrow? I need to know",
  "What's on my calendar Friday?",
  'Am I free Friday afternoon?',
  'Check my calendar for next week',
  'Do I have any meetings tomorrow?',
  "what's my schedule today",
  'Any appointments on the 3rd?',
 ]) assert.ok(calendarQuestion(text), text);
 for (const text of [
  'Add a meeting with Karla tomorrow at 10',
  'Can you schedule a call with Adilet on Friday?',
  'Cancel my 4 p.m. tomorrow',
  'Open my calendar',
  'Any big AI events this week?',
  'Is that tool free?',
  'What is the release schedule for Opus?',
  'Plan tomorrow',
  'Research what creators are posting for Black Friday',
 ]) assert.equal(calendarQuestion(text), null, text);
});

test('today’s own note answers a loose schedule question; another day or the calendar by name is checked', t => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-check-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
 assert.ok(calendarCheck(root, "what's my schedule today"), 'no note yet, so the calendar is read');
 fs.mkdirSync(path.join(root, 'daily-notes'));
 fs.writeFileSync(path.join(root, 'daily-notes', localDate() + '.md'), '---\ndate: x\n---\n## Schedule\n- 09:00 — Record\n\n## Daily Drivers\n');
 assert.equal(calendarCheck(root, "what's my schedule today"), null);
 assert.ok(calendarCheck(root, 'do I have anything on my schedule tomorrow?'));
 assert.ok(calendarCheck(root, 'check my calendar'));
 const check = calendarCheck(root, 'Am I free Friday?');
 assert.equal(check.title, 'Calendar check');
 assert.match(check.prompt, /Google Calendar/); assert.match(check.prompt, /Only read/); assert.match(check.prompt, /Am I free Friday\?/);
});

function fixture(t) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-route-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
 const selection = {provider: 'claude', model: 'opus'}, calls = [], tasks = [];
 const get = id => { const task = tasks.find(task => task.id === id); if (!task) throw new Error('Task not found'); return task; };
 const terminals = {live: new Map(), list: () => tasks, get,
  send(id, text) { calls.push({kind: 'send', id, text}); return get(id); },
  sendWhenFree(id, text) { calls.push({kind: 'queue', id, text}); return get(id); },
  start(options) { const task = {id: options.id, ...options.selection, title: options.title, state: 'working', turns: []}; tasks.push(task); calls.push({kind: 'start', ...options}); return task; },
 };
 const speak = (transcript, workTarget = null, extra = {}) => routeVoice(root, {id: crypto.randomUUID(), transcript, selection, terminalMode: true, workTarget, ...extra}, undefined,
  () => assert.fail('A calendar question needs no model'), terminals, {resolveCli: () => ({command: 'unused-test-cli', prefix: []}), updateCurrent: () => {}});
 return {calls, tasks, speak};
}

test('on a call, a calendar question starts its own Calendar check, even while another task is working', async t => {
 const f = fixture(t), live = {transport: 'live', liveCallId: crypto.randomUUID()};
 const busy = {id: crypto.randomUUID(), provider: 'claude', model: 'opus', title: 'Opus 5.6 one-pager', state: 'working', created: Date.now(), turns: []};
 f.tasks.push(busy);
 const result = await f.speak('do I have anything on my schedule for tomorrow?', busy.id, live);
 assert.equal(result.action, 'task');
 assert.equal(result.reply, 'Checking your calendar.');
 assert.equal(result.decision.rule, 'router.calendarCheck');
 const started = f.calls.filter(call => call.kind === 'start');
 assert.equal(started.length, 1); assert.equal(started[0].title, 'Calendar check');
 assert.match(started[0].prompt, /Google Calendar/);
 assert.equal(f.calls.some(call => call.id === busy.id), false, 'the busy task is left alone');
 assert.notDeepEqual(result.workIds, [busy.id]);
});
