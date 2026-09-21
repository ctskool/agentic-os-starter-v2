import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { DEFAULT_COCKPIT_SKILLS } from '../shared/dashboard.mjs';

// Exercise the plugin boundary without opening Obsidian, reading credentials, or
// contacting an installed bridge. The real poll store and defaults stay bundled.
const bundled = await build({
 entryPoints: ['src/lib/dashboard.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
 plugins: [{ name: 'dashboard-plugin-fixtures', setup(builder) {
  const fixtures = {
   'preact/hooks': 'export function useEffect(){}; export function useState(){}',
   './provider': `export async function assertTestVault(){globalThis.dashboardPluginFixture.events.push('vault')}; export async function readSelection(){globalThis.dashboardPluginFixture.selectionReads++;return globalThis.dashboardPluginFixture.selection}`,
   './v2-voice': `export async function assertVoiceVault(){globalThis.dashboardPluginFixture.events.push('bridge-vault')}; export async function v2VoiceTransport(path,options){const f=globalThis.dashboardPluginFixture;f.events.push(path);f.calls.push({path,options});return f.handler(path,options)}`,
   './work': `export const workConversations={async startSession(){globalThis.dashboardPluginFixture.events.push('session')}};export function publishWorkTask(task){globalThis.dashboardPluginFixture.published.push(task)};export function openWork(ids){globalThis.dashboardPluginFixture.opened.push(ids)}`,
   './queue': `export async function writeIntent(app,id,args){globalThis.dashboardPluginFixture.stock.push({app,id,args})}`,
  };
  builder.onResolve({ filter: /^(preact\/hooks|\.\/provider|\.\/v2-voice|\.\/work|\.\/queue)$/ }, args => ({ path: args.path, namespace: 'dashboard-fixture' }));
  builder.onLoad({ filter: /.*/, namespace: 'dashboard-fixture' }, args => ({ loader: 'js', contents: fixtures[args.path] }));
 } }],
});
const dashboard = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const stock = { id: 'plan-today', label: 'Plan Today', kind: 'builtin', description: 'Plan your day.', available: true, providers: ['claude', 'codex'] };
const installed = { id: 'installed:1234567890abcdef12345678', label: 'Proposal', kind: 'installed', description: 'Write a proposal.', available: true, providers: ['codex'] };
const state = (extra = {}) => ({ revision: 'one', configured: false, selected: null, catalog: [stock, installed], ...extra });
const nativeApp = (version = '3.27.1') => ({ vault: { adapter: { getBasePath: () => 'C:\\test-vault' } }, plugins: { plugins: version ? { terminal: { manifest: { version } } } : {} } });
function fixture() {
 const f = { events: [], calls: [], stock: [], published: [], opened: [], selectionReads: 0, selection: { provider: 'codex', model: 'gpt-6-astra' }, response: state() };
 f.handler = () => ({ status: 200, json: f.response });
 globalThis.dashboardPluginFixture = f;
 return f;
}

test('an old bridge keeps stock defaults visible and gives a useful update instruction', async () => {
 const f = fixture(); f.handler = () => ({ status: 404, json: { error: 'Not found' } });
 const value = await dashboard.readDashboard({});
 assert.equal(value.ready, false);
 assert.match(value.error, /node aos\.mjs update/);
 assert.deepEqual(dashboard.dashboardSelection(value), [...DEFAULT_COCKPIT_SKILLS]);
 assert.ok(dashboard.dashboardButtons(value).every(skill => skill.kind === 'builtin'));
});

test('multiple cockpit subscribers share one load and see saves and external changes', async () => {
 const f = fixture(), app = {}, a = [], b = [];
 const stopA = dashboard.subscribeDashboard(app, value => a.push(value));
 const stopB = dashboard.subscribeDashboard(app, value => b.push(value));
 try {
  await dashboard.readDashboard(app);
  assert.equal(f.calls.length, 1);
  f.response = state({ revision: 'two', configured: true, selected: [] });
  await dashboard.saveDashboard(app, 'one', []);
  assert.deepEqual(dashboard.dashboardButtons(a.at(-1)), []);
  assert.equal(a.at(-1), b.at(-1));
  assert.deepEqual(JSON.parse(f.calls.at(-1).options.body), { revision: 'one', selected: [] });
  f.response = state({ revision: 'three', configured: true, selected: [installed.id, stock.id] });
  await dashboard.readDashboard(app);
  assert.deepEqual(dashboard.dashboardButtons(a.at(-1)).map(skill => skill.id), [installed.id, stock.id]);
  assert.equal(a.at(-1), b.at(-1));
  f.response = state({ revision: 'four' });
  await dashboard.saveDashboard(app, 'three', null);
  assert.deepEqual(dashboard.dashboardSelection(a.at(-1)), [...DEFAULT_COCKPIT_SKILLS]);
 } finally { stopA(); stopB(); }
});

test('a stale save fails without replacing the known snapshot or silently resubmitting', async () => {
 const f = fixture(), app = {}, seen = [];
 const stop = dashboard.subscribeDashboard(app, value => seen.push(value));
 try {
  await dashboard.readDashboard(app);
  const known = seen.at(-1);
  f.handler = () => ({ status: 409, json: { error: 'Dashboard changed. Reload and try again.' } });
  await assert.rejects(dashboard.saveDashboard(app, 'one', [installed.id]), /Dashboard changed/);
  assert.equal(seen.at(-1), known);
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
 } finally { stop(); }
});

test('selection validation rejects duplicate or excessive buttons before any write', async () => {
 const f = fixture();
 await assert.rejects(dashboard.saveDashboard({}, 'one', [stock.id, stock.id]), /different skills/);
 await assert.rejects(dashboard.saveDashboard({}, 'one', Array.from({ length: 11 }, (_, i) => String(i))), /up to 10/);
 assert.equal(f.calls.length, 0);
});

test('missing and incompatible installed skills remain visible with specific reasons', () => {
 fixture();
 const value = state({ selected: ['missing', installed.id] });
 const buttons = dashboard.dashboardButtons(value);
 assert.equal(buttons[0].id, 'missing');
 assert.match(dashboard.dashboardSkillReason(buttons[0], 'codex'), /no longer registered/);
 assert.match(dashboard.dashboardSkillReason(installed, 'claude'), /Use codex/);
 assert.equal(dashboard.dashboardSkillReason({ ...installed, available: false, reason: 'SKILL.md changed; register it again.' }, 'codex'), 'SKILL.md changed; register it again.');
 assert.equal(dashboard.dashboardSkillReason(installed, 'codex', null, 'Bridge offline'), 'Bridge offline');
 assert.equal(dashboard.dashboardSkillReason(installed, 'codex', null, '', ['claude']), 'Codex is not installed.');
});

test('stock skills retain the background queue path and preserve argument values', async () => {
 const f = fixture(), app = {};
 await dashboard.launchDashboardSkill(app, { ...stock, id: 'deep-research-chase', arg: 'topic' }, 'research topic');
 assert.deepEqual(f.stock, [{ app, id: 'deep-research-chase', args: { topic: 'research topic' } }]);
 assert.equal(f.calls.length, 0);
 assert.equal(f.opened.length, 0);
});

test('installed skills bind one provider selection, establish the native session and open the returned work task', async () => {
 const f = fixture();
 const task = { id: 'task-id', provider: 'codex', model: 'gpt-6-astra', execution: 'native', state: 'starting', turns: [] };
 f.handler = () => ({ status: 200, json: task });
 await dashboard.launchDashboardSkill(nativeApp(), installed, '  Write an offer for my client  ');
 const call = f.calls[0], payload = JSON.parse(call.options.body);
 assert.equal(call.path, '/dashboard/launch');
 assert.match(payload.id, /^[a-f0-9-]{36}$/);
 assert.deepEqual(payload.selection, f.selection);
 assert.equal(payload.skill, installed.id);
 assert.equal(payload.request, 'Write an offer for my client');
 assert.equal(f.selectionReads, 1);
 assert.ok(f.events.indexOf('session') < f.events.indexOf('/dashboard/launch'));
 assert.deepEqual(f.published, [task]);
 assert.deepEqual(f.opened, [['task-id']]);
 assert.equal(f.stock.length, 0);
});

test('custom launch rejects empty requests and provider mismatches before creating work', async () => {
 const f = fixture();
 await assert.rejects(dashboard.launchDashboardSkill({}, installed, ' '), /Describe what/);
 f.selection = { provider: 'claude', model: 'sonnet' };
 await assert.rejects(dashboard.launchDashboardSkill({}, installed, 'Write a proposal'), /Use codex/);
 assert.equal(f.calls.length, 0);
 assert.equal(f.opened.length, 0);
});

test('missing or unsupported native Terminal prevents session writes and pending custom tasks', async () => {
 const f = fixture();
 for (const app of [nativeApp(null), nativeApp('0.0.0')]) {
  await assert.rejects(dashboard.launchDashboardSkill(app, installed, 'Write a proposal'), /Enable the supported Terminal community plugin.*Jarvis at http:\/\/127\.0\.0\.1:3217/);
 }
 assert.equal(f.events.includes('session'), false);
 assert.equal(f.calls.length, 0);
 assert.equal(f.opened.length, 0);
 assert.equal(f.published.length, 0);
 await dashboard.launchDashboardSkill(nativeApp(null), stock);
 assert.equal(f.stock.length, 1, 'stock workflows do not require Terminal');
});

test('browser personal skills do not require the Obsidian Terminal plugin', async () => {
 const f = fixture();
 const task = { id: 'browser-task', provider: 'codex', model: 'gpt-6-astra', state: 'starting', turns: [] };
 f.handler = () => ({ status: 200, json: task });
 await dashboard.launchDashboardSkill({ vault: { adapter: {} } }, installed, 'Write a proposal');
 assert.equal(f.calls[0].path, '/dashboard/launch');
 assert.deepEqual(f.opened, [['browser-task']]);
});

test('a rejected model launch surfaces the error without publishing or opening phantom work', async () => {
 const f = fixture();
 f.handler = () => ({ status: 400, json: { error: 'Unsupported provider/model pair' } });
 await assert.rejects(dashboard.launchDashboardSkill(nativeApp(), installed, 'Write a proposal'), /Unsupported provider\/model pair/);
 assert.equal(f.calls.length, 1);
 assert.equal(f.published.length, 0);
 assert.equal(f.opened.length, 0);
});

test('registration publishes the new registry entry while keeping the server saved selection', async () => {
 const f = fixture(), app = {}, seen = [];
 const stop = dashboard.subscribeDashboard(app, value => seen.push(value));
 try {
  await dashboard.readDashboard(app);
  f.response = state({ revision: 'two', selected: [], configured: true, registeredId: installed.id });
  const value = await dashboard.registerDashboardSkill(app, 'one', 'C:\\skills\\proposal\\SKILL.md', ['codex'], ' Proposal ');
  assert.equal(value.registeredId, installed.id);
  assert.equal(seen.at(-1), value);
  assert.deepEqual(value.selected, []);
  assert.deepEqual(JSON.parse(f.calls.at(-1).options.body), { revision: 'one', path: 'C:\\skills\\proposal\\SKILL.md', providers: ['codex'], label: 'Proposal' });
 } finally { stop(); }
});
