import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {inspectUpgrade, upgradeCommand} from '../scripts/aos/upgrade.mjs';
import {update} from '../scripts/aos/setup.mjs';

function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-upgrade-story-')));
  t.after(() => fs.promises.rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}));
  return root;
}
function put(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}
function git(root, ...args) {
  const env = {...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1'};
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT']) delete env[name];
  const result = spawnSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-C', root, ...args], {env, encoding: 'utf8', windowsHide: true, timeout: 15000});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function starter(home) {
  const root = path.join(home, 'agentic-os'), vault = path.join(home, 'My working vault');
  put(root, 'aos.mjs', '// fixture launcher\n');
  put(root, 'VERSION.json', {plugin: '0.3.64', hud: '2.0.0-preview.28', bridgeCommit: '0000000', hudCommit: '0000000'});
  put(root, 'obsidian-v2/manifest.json', {id: 'agentic-os-v2', name: 'Agentic OS V2', version: '0.3.64'});
  put(root, 'obsidian-v2/package.json', {name: 'agentic-os-v2'});
  put(root, 'obsidian-v2/scripts/aos.mjs', '// fixture command\n');
  put(root, 'jarvis-v2/package.json', {name: 'jarvis-v2', version: '2.0.0-preview.28'});
  put(root, '.gitignore', 'obsidian-v2/.runtime/\n');
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'fixture baseline');
  git(root, 'remote', 'add', 'origin', 'https://github.com/ctskool/agentic-os-starter-v2.git');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'config', 'branch.main.remote', 'origin'); git(root, 'config', 'branch.main.merge', 'refs/heads/main');
  put(root, 'obsidian-v2/.runtime/aos-setup.json', {vault, voice: true});
  put(vault, '.obsidian/plugins/agentic-os-v2/manifest.json', {id: 'agentic-os-v2', name: 'Agentic OS V2', version: '0.3.64'});
  put(vault, '.obsidian/plugins/agentic-os-v2/terminal-runtime.json', {runtimeDir: path.join(root, 'obsidian-v2', '.runtime')});
  put(vault, 'daily-notes/my-note.md', 'This member wrote this note.\n');
  put(vault, 'system/v2/dashboard.json', {version: 1, selected: ['my-custom-skill']});
  return {root, vault};
}
// Entire disposable fixture, including its Git metadata: no update or index
// refresh may write during the assessment. No real home or vault is used.
function snapshot(root) {
  const result = {};
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[path.relative(root, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  };
  walk(root); return result;
}
const isolated = home => ({home, env: {}, root: path.join(home, 'reference', 'obsidian-v2'), getMonitor: async () => null});

test('an original-starter member can be found by vault name without knowing an OS path', async t => {
  const home = scratch(t), vault = path.join(home, 'Writing vault');
  put(vault, '.obsidian/plugins/chase-command-center/manifest.json', {id: 'chase-command-center', name: 'Chase Command Center', version: '1.0.0'});
  put(vault, 'projects/my-custom-workflow.md', 'Keep this workflow exactly.');
  put(home, 'Library/Application Support/obsidian/obsidian.json', {vaults: {fixture: {path: vault, open: true}}});
  const before = snapshot(home);
  const report = await inspectUpgrade({...isolated(home), platform: 'darwin'});
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].vaultPath, vault);
  assert.equal(report.candidates[0].route, 'review-v1-upgrade');
  assert.equal(report.readOnly, true); assert.equal(report.changesApplied, false);
  assert.deepEqual(snapshot(home), before);
});

test('a stock V2 is assessed without updating files or stopping anything', async t => {
  const home = scratch(t), {root, vault} = starter(home), before = snapshot(home);
  const report = await inspectUpgrade({...isolated(home), install: root});
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].installPath, root);
  assert.equal(report.candidates[0].vaultPath, vault);
  assert.equal(report.candidates[0].route, 'review-stock-update', JSON.stringify(report.candidates[0]));
  assert.match(report.limitation, /not a compatibility test/);
  assert.deepEqual(snapshot(home), before);
});

for (const committed of [false, true]) test(`a ${committed ? 'committed' : 'working-tree'} customization is preserved and blocks direct update before service access`, async t => {
  const home = scratch(t), {root} = starter(home);
  put(root, 'jarvis-v2/my-dashboard.tsx', '// My own dashboard must survive.');
  if (committed) { git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'member customization'); }
  const before = snapshot(home), report = await inspectUpgrade({...isolated(home), install: root});
  assert.equal(report.candidates[0].checkout.updateAllowed, false);
  assert.equal(report.candidates[0].route, 'review-custom-integration');
  let mutations = 0;
  const forbidden = () => { mutations++; throw new Error('must not touch a service or perform an update'); };
  await assert.rejects(update({root: path.join(root, 'obsidian-v2'), get: forbidden, halt: forbidden, pull: forbidden, install: forbidden, log: () => {}}), /upgrade|custom|review/i);
  assert.equal(mutations, 0);
  assert.deepEqual(snapshot(home), before);
});

test('multiple vaults require a member choice and never select one by position', async t => {
  const home = scratch(t), vaults = {};
  for (const name of ['Work', 'Personal']) {
    const vault = path.join(home, name);
    put(vault, '.obsidian/plugins/chase-command-center/manifest.json', {id: 'chase-command-center', version: '1.0.0'});
    vaults[name] = {path: vault};
  }
  put(home, 'Library/Application Support/obsidian/obsidian.json', {vaults});
  const before = snapshot(home), report = await inspectUpgrade({...isolated(home), platform: 'darwin'});
  assert.equal(report.candidates.length, 2); assert.equal(report.selectionRequired, true);
  assert.match(report.nextStep, /ask which system/);
  assert.equal('selected' in report, false); assert.deepEqual(snapshot(home), before);
});

test('no discovery result asks for a recognizable vault rather than installing over something unknown', async t => {
  const home = scratch(t), report = await inspectUpgrade(isolated(home));
  assert.deepEqual(report.candidates, []);
  assert.match(report.nextStep, /Obsidian vault/);
  assert.equal(report.changesApplied, false);
  assert.ok(report.availableFeatures.some(feature => feature.id === 'voice' && feature.dependencies.length));
});

test('an explicitly isolated home cannot fall back to the actual installation or live monitor', async t => {
  const home = scratch(t);
  const report = await inspectUpgrade({home, discover: async options => {
    assert.equal(options.home, home); assert.deepEqual(options.env, {});
    assert.equal(options.root, undefined); assert.equal(options.getMonitor, undefined);
    return {candidates: [], warnings: [], searched: []};
  }});
  assert.equal(report.changesApplied, false);
});

test('a stale vault reference is not recommended for a stock update or recreated', async t => {
  const home = scratch(t), {root, vault} = starter(home);
  const moved = path.join(home, 'Moved working vault');
  fs.renameSync(vault, moved);
  const before = snapshot(home), report = await inspectUpgrade({...isolated(home), install: root});
  assert.equal(report.candidates[0].route, 'review-custom-integration');
  assert.ok(report.candidates[0].warnings.length);
  assert.equal(fs.existsSync(vault), false); assert.deepEqual(snapshot(home), before);
});

test('upgrade help and invalid arguments perform no discovery; there is no automatic apply flag', async () => {
  const discover = () => assert.fail('discovery was invoked'), output = [];
  assert.equal(await upgradeCommand({flags: {help: true}, discover, log: value => output.push(value)}), 0);
  assert.match(output.join('\n'), /does not install/);
  await assert.rejects(upgradeCommand({flags: {apply: true}, discover}), /no apply option/);
  await assert.rejects(upgradeCommand({flags: {install: true}, discover}), /absolute folder path/);
  await assert.rejects(upgradeCommand({flags: {vault: 'relative-folder'}, discover}), /absolute folder path/);
});

test('JSON command output includes a plain feature catalogue and no mutation permission', async t => {
  const home = scratch(t), lines = [];
  assert.equal(await upgradeCommand({...isolated(home), flags: {json: true}, log: value => lines.push(value)}), 0);
  const report = JSON.parse(lines.join('\n'));
  assert.equal(report.readOnly, true); assert.equal(report.changesApplied, false);
  assert.ok(report.availableFeatures.every(feature => feature.description && feature.dependencies.length));
});

test('the actual launcher inspects an explicit throwaway installation without contacting any service', async t => {
  const home = scratch(t), {root} = starter(home);
  const noNetwork = put(home, 'no-network.mjs', "import http from 'node:http'; import https from 'node:https'; const refuse=()=>{console.error('A service was contacted during explicit discovery');process.exit(73)}; http.get=refuse; http.request=refuse; https.get=refuse; https.request=refuse; globalThis.fetch=refuse;");
  const before = snapshot(home);
  const launcher = fileURLToPath(new URL('../scripts/aos.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(noNetwork).href, launcher, 'upgrade', '--install', root, '--json'], {encoding: 'utf8', timeout: 20000, windowsHide: true});
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].route, 'review-stock-update');
  assert.equal(report.changesApplied, false);
  assert.deepEqual(snapshot(home), before);
});
