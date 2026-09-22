import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {discoverInstallations} from '../scripts/aos/upgrade-discovery.mjs';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-discovery-')));
  t.after(() => fs.promises.rm(base, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}));
  const home = path.join(base, 'home'); fs.mkdirSync(home);
  const json = (file, data) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, JSON.stringify(data)); return file; };
  const folder = name => { const value = path.join(base, name); fs.mkdirSync(value, {recursive: true}); return value; };
  const install = (at, vaultPath, {starter = true, installed = true} = {}) => {
    const bridge = starter ? path.join(at, 'obsidian-v2') : at;
    json(path.join(bridge, 'manifest.json'), {id: 'agentic-os-v2', name: 'UNTRUSTED_LABEL_CANARY'});
    if (starter) fs.writeFileSync(path.join(at, 'aos.mjs'), 'SOURCE_CONTENT_CANARY');
    if (installed && vaultPath) json(path.join(bridge, '.runtime', 'aos-setup.json'), {vault: vaultPath, ignoredSecret: 'SECRET_CANARY'});
    return {installPath: at, bridge, runtime: path.join(bridge, '.runtime')};
  };
  const vault = (at, {kind = 'v2', runtime} = {}) => {
    const id = kind === 'v1' ? 'chase-command-center' : 'agentic-os-v2';
    json(path.join(at, '.obsidian', 'plugins', id, 'manifest.json'), {id, name: 'UNTRUSTED_LABEL_CANARY'});
    if (runtime) json(path.join(at, '.obsidian', 'plugins', id, 'terminal-runtime.json'), {version: 1, vault: at, runtimeDir: runtime, ignoredSecret: 'SECRET_CANARY'});
    return at;
  };
  const registry = (platform, paths) => {
    const config = platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, 'AppData', 'Roaming');
    json(path.join(config, 'obsidian', 'obsidian.json'), {vaults: Object.fromEntries(paths.map((p, index) => [index, {path: p}]))});
    return config;
  };
  const discover = options => discoverInstallations({home, env: {}, ...options});
  return {base, home, json, folder, install, vault, registry, discover};
}

test('Windows registry discovers a custom vault and follows its V2 runtime to the starter root', async t => {
  const f = fixture(t), vault = f.folder('custom-vault'), at = f.install(f.folder('custom-install'), null, {installed: false});
  f.vault(vault, {runtime: at.runtime}); const appdata = f.registry('win32', [vault]);
  const result = await f.discover({platform: 'win32', env: {APPDATA: appdata}});
  assert.equal(result.candidates.length, 1);
  assert.deepEqual([result.candidates[0].installPath, result.candidates[0].vaultPath, result.candidates[0].kind], [at.installPath, vault, 'starter-v2']);
  assert.ok(result.candidates[0].evidence.includes('V2 terminal runtime reference'));
  assert.doesNotMatch(JSON.stringify(result), /CANARY/);
});

test('Mac registry finds a first-starter vault without assuming it is V2', async t => {
  const f = fixture(t), vault = f.vault(f.folder('first-vault'), {kind: 'v1'}); f.registry('darwin', [vault]);
  const result = await f.discover({platform: 'darwin'});
  assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].kind, 'v1');
  assert.equal(result.candidates[0].vaultPath, vault); assert.equal(result.candidates[0].installPath, undefined);
});

test('a conventional installed starter and its saved vault are deduplicated against registry and monitor', async t => {
  const f = fixture(t), vault = f.vault(f.folder('vault'));
  const at = f.install(path.join(f.home, 'agentic-os'), vault); f.vault(vault, {runtime: at.runtime}); f.registry('darwin', [vault, vault]);
  let calls = 0;
  const result = await f.discover({platform: 'darwin', root: at.bridge, getMonitor: async (url, options) => { calls++; assert.equal(url, 'http://127.0.0.1:3221/status'); assert.equal(options.timeoutMs, 1200); return {kind: 'agentic-os-service-supervisor', runtimeDir: at.runtime, token: 'SECRET_CANARY'}; }});
  assert.equal(calls, 1); assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].kind, 'starter-v2');
  assert.equal(result.candidates[0].vaultPath, vault); assert.doesNotMatch(JSON.stringify(result), /CANARY/);
});

test('an uninstalled reference clone is searched but never offered as an installed system', async t => {
  const f = fixture(t), at = f.install(path.join(f.home, 'agentic-os'), null, {installed: false});
  const result = await f.discover({root: at.bridge});
  assert.deepEqual(result.candidates, []); assert.ok(result.searched.includes(at.bridge));
  const explicit = await f.discover({install: at.installPath});
  assert.equal(explicit.candidates.length, 1); assert.equal(explicit.candidates[0].kind, 'unknown');
  assert.match(explicit.candidates[0].warnings.join(' '), /reference checkout/);
});

test('multiple existing systems stay separate instead of being automatically selected', async t => {
  const f = fixture(t), firstVault = f.vault(f.folder('first-vault')), secondVault = f.vault(f.folder('second-vault'));
  const first = f.install(f.folder('first-install'), firstVault), second = f.install(f.folder('second-install'), secondVault, {starter: false});
  f.vault(firstVault, {runtime: first.runtime}); f.vault(secondVault, {runtime: second.runtime}); f.registry('darwin', [firstVault, secondVault]);
  const result = await f.discover({platform: 'darwin'});
  assert.equal(result.candidates.length, 2); assert.deepEqual(new Set(result.candidates.map(item => item.kind)), new Set(['starter-v2', 'v2']));
  assert.match(result.warnings.join(' '), /Multiple/);
});

test('explicit installation selection reads only that installation and its linked vault', async t => {
  const f = fixture(t), selectedVault = f.vault(f.folder('selected-vault')), otherVault = f.vault(f.folder('other-vault'));
  const selected = f.install(f.folder('selected-install'), selectedVault), other = f.install(path.join(f.home, 'agentic-os'), otherVault);
  f.registry('darwin', [otherVault]);
  const result = await f.discover({platform: 'darwin', install: selected.installPath, root: other.bridge, getMonitor: () => assert.fail('monitor called for explicit selection')});
  assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].vaultPath, selectedVault);
  assert.ok(!result.searched.some(item => item.includes('obsidian.json') || item.includes(otherVault) || item.includes(other.installPath)));
});

test('explicit vault selection follows only its owner and preserves missing-owner evidence', async t => {
  const f = fixture(t), vault = f.folder('selected-vault'), at = f.install(f.folder('selected-install'), null, {starter: false, installed: false});
  f.vault(vault, {runtime: at.runtime});
  const result = await f.discover({vault}); assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].installPath, at.installPath);
  f.json(path.join(vault, '.obsidian', 'plugins', 'agentic-os-v2', 'terminal-runtime.json'), {runtimeDir: path.join(f.base, 'gone', '.runtime')});
  const missing = await f.discover({vault}); assert.equal(missing.candidates[0].kind, 'v2'); assert.equal(missing.candidates[0].installPath, undefined);
  assert.match(missing.warnings.join(' '), /Installation folder was skipped: missing/);
});

test('explicit unknown or missing folders remain available for a manual assessment', async t => {
  const f = fixture(t), install = f.folder('unrecognized');
  const existing = await f.discover({install}); assert.equal(existing.candidates[0].kind, 'unknown');
  const missing = await f.discover({vault: path.join(f.base, 'missing')}); assert.equal(missing.candidates[0].kind, 'unknown');
  assert.match(missing.candidates[0].warnings.join(' '), /not found/);
});

test('metadata reads are whitelisted and contain no source, notes, credential or environment reads', async t => {
  const f = fixture(t), vault = f.vault(f.folder('vault')), at = f.install(f.folder('install'), vault);
  for (const name of ['jev.json', 'bridge-auth.json', 'providers.json', '.credentials.json', '.env']) f.json(path.join(at.bridge, '.runtime', name), {canary: 'SECRET_CANARY'});
  f.json(path.join(vault, 'private-note.json'), {canary: 'NOTE_CANARY'});
  const original = fs.openSync, opened = [];
  t.mock.method(fs, 'openSync', (file, ...args) => { opened.push(String(file)); assert.match(String(file), /(?:manifest|aos-setup|terminal-runtime|obsidian)\.json$/); return original(file, ...args); });
  const result = await f.discover({install: at.installPath});
  assert.ok(opened.length > 0); assert.doesNotMatch(opened.join('\n'), /jev\.json|bridge-auth|providers|credentials|\.env|private-note|aos\.mjs/);
  assert.doesNotMatch(JSON.stringify(result), /CANARY/);
});

test('linked folders and hard-linked metadata are rejected without following their contents', async t => {
  const f = fixture(t), vault = f.vault(f.folder('vault')), real = f.install(f.folder('real'), vault), linked = path.join(f.base, 'linked');
  fs.symlinkSync(real.installPath, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const symlink = await f.discover({install: linked}); assert.equal(symlink.candidates.length, 0); assert.match(symlink.warnings.join(' '), /linked path/);
  const record = path.join(real.bridge, '.runtime', 'aos-setup.json'); fs.linkSync(record, path.join(f.base, 'record-copy.json'));
  const hardlink = await f.discover({install: real.installPath}); assert.equal(hardlink.candidates[0].kind, 'unknown'); assert.match(hardlink.warnings.join(' '), /unlinked file/);
});

test('traversal, remote paths and malformed runtime owners never extend discovery', async t => {
  const f = fixture(t), vault = f.vault(f.folder('vault'));
  const invalid = await f.discover({install: f.base + path.sep + '..' + path.sep + 'escape', vault: '\\\\server\\share'});
  assert.deepEqual(invalid.candidates, []); assert.deepEqual(invalid.searched, []);
  f.json(path.join(vault, '.obsidian', 'plugins', 'agentic-os-v2', 'terminal-runtime.json'), {runtimeDir: path.join(f.base, 'private-note.json'), vault});
  const result = await f.discover({vault}); assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].installPath, undefined);
  assert.match(result.warnings.join(' '), /no valid runtime/);
});

test('malformed, oversized and wrong-shaped metadata yield sanitized warnings', async t => {
  const f = fixture(t), at = f.install(f.folder('install'), null, {installed: false});
  const record = path.join(at.bridge, '.runtime', 'aos-setup.json'); fs.mkdirSync(path.dirname(record));
  for (const content of ['{"SECRET_CANARY":', JSON.stringify({vault: 'SECRET_CANARY'.repeat(8000)}), '[]', '{"vault":42}']) {
    fs.writeFileSync(record, content);
    const result = await f.discover({install: at.installPath});
    assert.equal(result.candidates[0].kind, 'unknown'); assert.ok(result.warnings.length > 0); assert.doesNotMatch(JSON.stringify(result), /SECRET_CANARY/);
  }
});

test('a mismatching terminal vault reference is ignored', async t => {
  const f = fixture(t), vault = f.vault(f.folder('vault')), other = f.folder('other'), at = f.install(f.folder('install'), null, {installed: false});
  f.json(path.join(vault, '.obsidian', 'plugins', 'agentic-os-v2', 'terminal-runtime.json'), {runtimeDir: at.runtime, vault: other});
  const result = await f.discover({vault}); assert.equal(result.candidates[0].installPath, undefined); assert.match(result.warnings.join(' '), /different vault/);
});

test('registry work is bounded and an explicit home never inherits the actual machine APPDATA', async t => {
  const f = fixture(t), config = path.join(f.home, 'AppData', 'Roaming', 'obsidian', 'obsidian.json');
  f.json(config, {vaults: Object.fromEntries(Array.from({length: 80}, (_, index) => [index, {path: path.join(f.base, 'vault-' + index)}]))});
  const result = await discoverInstallations({home: f.home, platform: 'win32'});
  assert.ok(result.searched.includes(config)); assert.ok(result.searched.every(item => item.startsWith(f.base)));
  assert.match(result.warnings.join(' '), /limit reached/); assert.ok(result.searched.length < 100);
});

test('monitor errors and unrecognized metadata are sanitized and nonfatal', async t => {
  const f = fixture(t);
  const failed = await f.discover({getMonitor: async () => { throw Error('SECRET_CANARY'); }});
  assert.match(failed.warnings.join(' '), /monitor was unavailable/); assert.doesNotMatch(JSON.stringify(failed), /CANARY/);
  const unknown = await f.discover({getMonitor: async () => ({kind: 'something-else', runtimeDir: 'SECRET_CANARY'})});
  assert.deepEqual(unknown.candidates, []); assert.match(unknown.warnings.join(' '), /recognizable/);
});

test('metadata references to multiple vaults preserve ambiguity', async t => {
  const f = fixture(t), first = f.vault(f.folder('first')), second = f.vault(f.folder('second'));
  const at = f.install(f.folder('install'), first); f.vault(second, {runtime: at.runtime});
  const result = await f.discover({vault: second});
  assert.equal(result.candidates.length, 2); assert.deepEqual(new Set(result.candidates.map(item => item.vaultPath)), new Set([first, second]));
  assert.ok(result.candidates.every(item => item.warnings.some(message => /more than one vault/.test(message))));
});

test('linked runtime and saved vault references are rejected even when their owner folder is ordinary', async t => {
  const f = fixture(t), vault = f.vault(f.folder('vault')), at = f.install(f.folder('install'), null, {installed: false}), target = f.folder('target');
  fs.symlinkSync(target, at.runtime, process.platform === 'win32' ? 'junction' : 'dir');
  f.vault(vault, {runtime: at.runtime});
  const runtime = await f.discover({vault}); assert.equal(runtime.candidates[0].installPath, undefined); assert.match(runtime.warnings.join(' '), /linked path/);
  const linkedVault = path.join(f.base, 'linked-vault'); fs.symlinkSync(vault, linkedVault, process.platform === 'win32' ? 'junction' : 'dir');
  const second = f.install(f.folder('second'), linkedVault);
  const saved = await f.discover({install: second.installPath}); assert.equal(saved.candidates[0].kind, 'unknown'); assert.equal(saved.candidates[0].vaultPath, undefined);
  assert.match(saved.warnings.join(' '), /linked path/);
});

test('an unresponsive injected monitor cannot hold discovery indefinitely', async t => {
  const f = fixture(t), started = performance.now();
  const result = await f.discover({getMonitor: () => new Promise(() => {})});
  assert.match(result.warnings.join(' '), /monitor was unavailable/);
  assert.ok(performance.now() - started < 5000); assert.deepEqual(result.candidates, []);
});

test('a stale or unrecognized saved vault blocks an automatic stock-update recommendation', async t => {
  const f = fixture(t), missing = path.join(f.base, 'deleted-vault'), at = f.install(f.folder('install'), missing);
  const deleted = await f.discover({install: at.installPath});
  assert.equal(deleted.candidates[0].kind, 'starter-v2'); assert.equal(deleted.candidates[0].vaultPath, missing);
  assert.match(deleted.candidates[0].warnings.join(' '), /no longer exists/); assert.equal(fs.existsSync(missing), false);
  fs.mkdirSync(missing);
  const unrecognized = await f.discover({install: at.installPath});
  assert.match(unrecognized.candidates[0].warnings.join(' '), /no matching Agentic OS plugin manifest/);
});

test('conflicting explicit and saved vaults remain separate and warn on the installation candidate', async t => {
  const f = fixture(t), saved = f.vault(f.folder('saved')), selected = f.vault(f.folder('selected')), at = f.install(f.folder('install'), saved);
  const result = await f.discover({install: at.installPath, vault: selected});
  assert.equal(result.candidates.length, 2);
  const installed = result.candidates.find(item => item.installPath);
  assert.equal(installed.vaultPath, saved); assert.match(installed.warnings.join(' '), /explicit vault differs/);
});

test('an installed runtime reference without a matching source manifest remains unknown', async t => {
  const f = fixture(t), vault = f.vault(f.folder('vault')), install = f.folder('install');
  f.vault(vault, {runtime: path.join(install, '.runtime')});
  const result = await f.discover({vault});
  assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].kind, 'unknown');
  assert.match(result.candidates[0].warnings.join(' '), /recognized source manifest/);
});
