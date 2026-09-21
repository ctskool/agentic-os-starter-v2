import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDailyPost } from '../lib/daily-edit';
import { setVaultRoot, readCachedVaultState } from '../lib/vault';
import { replaceDaily } from '../../obsidian-v2/runner/note-edits.mjs';
import { readVoiceReport } from '../../obsidian-v2/runner/voice-documents.mjs';

const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const relative = `daily-notes/${date}.md`;
const before = '\ufeff---\r\nschema_version: 1\r\n---\n## Top 3 Priorities\r\n1. [ ] Write the script\r\n2. [ ] Review edit\n3. [x] Publish\r\n\r\n## Notes\r\nUnrelated words.\r\n';
const input = { index: 0, done: true, date, text: 'Write the script' };
const request = (body: unknown = input, origin = 'http://127.0.0.1:3217') => new Request('http://127.0.0.1:3217/api/daily', {
  method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-daily-'));
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, before);
  const calls: string[] = [];
  const transport = async (route: string, body?: any) => {
    calls.push(route);
    if (route === '/status') return { vault: root };
    if (route.startsWith('/report?')) return readVoiceReport(root, new URL('http://local' + route).searchParams.get('path'), [], []);
    if (route === '/notes/replace') return replaceDaily(root, body);
    throw new Error('Unexpected bridge request ' + route);
  };
  return { root, file, transport, calls, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('daily POST uses the guarded bridge write and refreshes the actual dashboard cache', async () => {
  const f = fixture();
  try {
    setVaultRoot(f.root);
    const stale = await readCachedVaultState();
    assert.equal(stale.daily?.top3[0].done, false);
    const response = await createDailyPost({ requestBridge: f.transport })(request());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(fs.readFileSync(f.file, 'utf8'), before.replace('1. [ ]', '1. [x]'));
    assert.deepEqual(f.calls, ['/status', '/report?path=' + encodeURIComponent(relative), '/notes/replace']);
    const fresh = await readCachedVaultState();
    assert.notEqual(fresh, stale);
    assert.equal(fresh.daily?.top3[0].done, true);
  } finally { f.cleanup(); }
});

test('an Obsidian edit between daily read and write is preserved and the conflict refreshes cache', async () => {
  const f = fixture();
  try {
    setVaultRoot(f.root);
    await readCachedVaultState();
    const concurrent = before.replace('Write the script', 'My new priority');
    const handler = createDailyPost({ requestBridge: async (route, body) => {
      if (route === '/notes/replace') fs.writeFileSync(f.file, concurrent);
      return f.transport(route, body);
    } });
    const response = await handler(request());
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /newer edits were preserved/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), concurrent);
    assert.equal((await readCachedVaultState()).daily?.top3[0].text, 'My new priority');
    assert.equal(f.calls.filter(route => route === '/notes/replace').length, 1, 'never silently retries a conflicted write');
  } finally { f.cleanup(); }
});

test('a priority renamed before the click is read cannot toggle a different task', async () => {
  const f = fixture();
  try {
    const concurrent = before.replace('Write the script', 'New task');
    fs.writeFileSync(f.file, concurrent);
    const response = await createDailyPost({ requestBridge: f.transport })(request());
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /priority changed/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), concurrent);
    assert.equal(f.calls.includes('/notes/replace'), false);
  } finally { f.cleanup(); }
});

test('daily POST rejects invalid input, stale dates and cross-origin writes before calling the bridge', async () => {
  const handler = createDailyPost({ requestBridge: async () => { throw new Error('Should not call the bridge'); } });
  for (const body of [null, {}, { ...input, index: -1 }, { ...input, done: 'true' }, { ...input, text: '' }]) {
    assert.equal((await handler(request(body))).status, 400);
  }
  assert.equal((await handler(request({ ...input, date: '1999-01-01' }))).status, 409);
  assert.equal((await handler(request(input, 'https://evil.example'))).status, 403);
});

test('daily POST keeps bridge failures actionable instead of relabeling them invalid input', async () => {
  const handler = createDailyPost({ requestBridge: async () => { throw new Error('V2 bridge is offline'); } });
  const response = await handler(request());
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'V2 bridge is offline');
});
