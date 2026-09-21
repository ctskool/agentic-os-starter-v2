import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizedBridgeFetch, createBrowserBridgeAuth } from '../../obsidian-v2/shared/bridge-auth';
import { browserVoiceTransport } from '../../obsidian-v2/shared/voice-session';

test('browser write auth refreshes once on pre-dispatch 401 and retains request body and headers', async () => {
  const original = globalThis.fetch, calls: RequestInit[] = [], refreshes: boolean[] = [];
  globalThis.fetch = async (_url, options) => { calls.push(options!); return calls.length === 1 ? Response.json({ error: 'authentication required' }, { status: 401 }) : Response.json({ ok: true }); };
  try {
    const response = await authorizedBridgeFetch('http://127.0.0.1:3219/work/start', { method: 'POST', body: '{"id":"one"}', headers: { 'Content-Type': 'application/json', 'X-V2-Request': 'same-request' } }, async refresh => { refreshes.push(!!refresh); return refresh ? 'new' : 'old'; });
    assert.equal(response.status, 200);
    assert.deepEqual(refreshes, [false, true]);
    assert.equal(new Headers(calls[0].headers).get('X-V2-Token'), 'old');
    assert.equal(new Headers(calls[1].headers).get('X-V2-Token'), 'new');
    assert.equal(new Headers(calls[1].headers).get('X-V2-Request'), 'same-request');
    assert.equal(calls[1].body, calls[0].body);
  } finally { globalThis.fetch = original; }
});

test('browser auth never replays an executed failure and leaves read/audio/SSE paths unchanged', async () => {
  const original = globalThis.fetch;
  let calls = 0, authorized = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ error: 'work failed' }, { status: 500 }); };
  try {
    const authorize = async () => { authorized++; return 'token'; };
    assert.equal((await authorizedBridgeFetch('/work/start', { method: 'POST' }, authorize)).status, 500);
    assert.equal(calls, 1);
    assert.equal(authorized, 1);
    await authorizedBridgeFetch('/voice/speak?text=test', {}, authorize);
    assert.equal(authorized, 1);
    calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({}, { status: 401 }); };
    assert.equal((await authorizedBridgeFetch('/work/start', { method: 'POST' }, authorize)).status, 401);
    assert.equal(calls, 2, 'only one credential retry');
  } finally { globalThis.fetch = original; }
});

test('concurrent browser writes share credential loading and cancellation cannot dispatch after bootstrap', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ token: 'a'.repeat(64) }); };
  try {
    const authorize = createBrowserBridgeAuth('/api/bridge-auth');
    assert.deepEqual(await Promise.all([authorize(), authorize(), authorize()]), Array(3).fill('a'.repeat(64)));
    assert.equal(calls, 1);
    await authorize(); assert.equal(calls, 1);
    await authorize(true); assert.equal(calls, 2);
    const controller = new AbortController();
    await assert.rejects(authorizedBridgeFetch('/voice/text', { method: 'POST', signal: controller.signal }, async () => { controller.abort(); return 'token'; }), /aborted/);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('browser voice recording and fallback audio use the authorized transport', async () => {
  const original = globalThis.fetch;
  const calls: { url: string; options: RequestInit }[] = [];
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), options: options! }); return new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/wav' } }); };
  try {
    const transport = browserVoiceTransport('http://127.0.0.1:3219', async () => 'voice-token');
    const result = await transport('/voice/speak', { method: 'POST', headers: { 'X-V2-Request': 'one' }, body: '{"text":"hello"}' });
    assert.equal(result.status, 200);
    assert.deepEqual(new Uint8Array(result.audio!), new Uint8Array([1, 2]));
    assert.equal(new Headers(calls[0].options.headers).get('X-V2-Token'), 'voice-token');
    assert.equal(new Headers(calls[0].options.headers).get('X-V2-Request'), 'one');
  } finally { globalThis.fetch = original; }
});
