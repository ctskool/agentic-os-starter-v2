import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {assessCheckout, prepareStockUpdate} from '../scripts/aos/upgrade-checkout.mjs';
import {update} from '../scripts/aos/setup.mjs';

const official = 'https://github.com/ctskool/agentic-os-starter-v2.git';
const tempRoot = fs.realpathSync(os.tmpdir());
const gitNull = process.platform === 'win32' ? 'NUL' : os.devNull;
const env = {...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))), GIT_CONFIG_GLOBAL: gitNull, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0'};
function scratch(t) {
  const folder = fs.mkdtempSync(path.join(tempRoot, 'aos-upgrade-checkout-'));
  t.after(() => {
    assert.equal(path.dirname(folder), tempRoot);
    assert.ok(path.basename(folder).startsWith('aos-upgrade-checkout-'));
    fs.rmSync(folder, {recursive: true, force: true});
  });
  return folder;
}
function git(root, args, input) {
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.hooksPath=' + gitNull, '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-c', 'user.name=Upgrade Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    {cwd: root, env, input, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024});
  assert.equal(result.status, 0, 'Synthetic Git fixture operation should succeed');
  return result.stdout.trim();
}
function fixture(t) {
  const root = scratch(t);
  for (const directory of ['obsidian-v2', 'jarvis-v2']) fs.mkdirSync(path.join(root, directory));
  fs.writeFileSync(path.join(root, 'aos.mjs'), '// synthetic launcher\n');
  fs.writeFileSync(path.join(root, 'VERSION.json'), JSON.stringify({plugin: '0.1.0', hud: '0.1.0', bridgeCommit: 'abc1234', hudCommit: 'def5678'}));
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.runtime/\n.next/\n');
  fs.writeFileSync(path.join(root, 'obsidian-v2', 'example.txt'), 'one\n');
  fs.writeFileSync(path.join(root, 'jarvis-v2', 'example.txt'), 'hud\n');
  git(root, ['init', '--initial-branch=main']);
  git(root, ['add', '--', '.']); git(root, ['commit', '-m', 'Synthetic starter']);
  git(root, ['remote', 'add', 'origin', official]);
  const head = git(root, ['rev-parse', 'HEAD']);
  git(root, ['update-ref', 'refs/remotes/origin/main', head]);
  git(root, ['branch', '--set-upstream-to=origin/main', 'main']);
  return {root, head, child: path.join(root, 'obsidian-v2')};
}
const blocked = result => { assert.equal(result.updateAllowed, false); assert.notEqual(result.kind, 'stock-starter'); assert.ok(result.issues.length); };

test('clean official main tracking origin/main is eligible from the repository root or bridge child', t => {
  const {root, child, head} = fixture(t);
  const value = assessCheckout(root);
  assert.equal(value.kind, 'stock-starter'); assert.equal(value.updateAllowed, true);
  assert.equal(value.repositoryPath, root); assert.equal(value.head, head); assert.equal(value.branch, 'main');
  assert.deepEqual(value.issues, []); assert.deepEqual(value.changes, []);
  assert.deepEqual(assessCheckout(child), value);
  for (const origin of [official.slice(0, -4), ['git', 'github.com:ctskool/agentic-os-starter-v2.git'].join('@')]) {
    git(root, ['remote', 'set-url', 'origin', origin]); assert.equal(assessCheckout(root).updateAllowed, true);
  }
});

test('clean behind is allowed against the saved remote ref without fetching; ahead or divergent commits are refused', t => {
  const {root, head} = fixture(t);
  fs.writeFileSync(path.join(root, 'release.txt'), 'new release\n'); git(root, ['add', '--', 'release.txt']); git(root, ['commit', '-m', 'Next synthetic release']);
  const later = git(root, ['rev-parse', 'HEAD']);
  blocked(assessCheckout(root)); assert.match(assessCheckout(root).issues.join(' '), /Local commits/);
  git(root, ['update-ref', 'refs/remotes/origin/main', later]); git(root, ['reset', '--hard', head]);
  assert.equal(assessCheckout(root).updateAllowed, true);
  fs.writeFileSync(path.join(root, 'custom.txt'), 'member customization\n'); git(root, ['add', '--', 'custom.txt']); git(root, ['commit', '-m', 'Member customization']);
  blocked(assessCheckout(root)); assert.equal(assessCheckout(root).kind, 'customized');
});

test('modified, staged and untracked member files block updates; ordinary ignored runtime and dependencies do not', t => {
  const {root} = fixture(t);
  fs.mkdirSync(path.join(root, 'obsidian-v2', '.runtime')); fs.writeFileSync(path.join(root, 'obsidian-v2', '.runtime', 'fixture.txt'), 'local runtime\n');
  fs.mkdirSync(path.join(root, 'node_modules')); fs.writeFileSync(path.join(root, 'node_modules', 'fixture.txt'), 'local dependency\n');
  assert.equal(assessCheckout(root).updateAllowed, true);
  fs.writeFileSync(path.join(root, 'obsidian-v2', 'example.txt'), 'two\n'); fs.writeFileSync(path.join(root, 'member-notes.md'), 'member notes\n');
  const value = assessCheckout(root); blocked(value); assert.equal(value.kind, 'customized');
  assert.deepEqual(value.changes, ['member-notes.md', 'obsidian-v2/example.txt']);
  git(root, ['add', '--', 'member-notes.md']); blocked(assessCheckout(root));
});

test('forks, missing upstream, non-main branches and detached checkouts fail closed without leaking origin values', t => {
  const {root} = fixture(t);
  git(root, ['remote', 'set-url', 'origin', 'https://fixture-private-value@example.invalid/member/fork.git']);
  const fork = assessCheckout(root); blocked(fork); assert.equal(fork.kind, 'customized');
  assert.doesNotMatch(JSON.stringify(fork), /fixture-private-value|example\.invalid/);
  git(root, ['remote', 'set-url', 'origin', official]); git(root, ['branch', '--unset-upstream']);
  blocked(assessCheckout(root)); assert.match(assessCheckout(root).issues.join(' '), /tracking/);
  git(root, ['branch', '--set-upstream-to=origin/main', 'main']); git(root, ['checkout', '-b', 'member-custom']);
  blocked(assessCheckout(root)); assert.equal(assessCheckout(root).branch, 'member-custom');
  git(root, ['checkout', '--detach', 'HEAD']); blocked(assessCheckout(root)); assert.match(assessCheckout(root).issues.join(' '), /detached/);
});

test('missing Git, truncated output, malformed status and wrong Git roots never qualify', t => {
  const {root} = fixture(t);
  for (const fake of [() => ({status: null, error: new Error('private implementation error')}), () => ({status: 0, stdout: 'ignored', error: {code: 'ENOBUFS'}})]) {
    const value = assessCheckout(root, {run: fake}); blocked(value); assert.doesNotMatch(JSON.stringify(value), /private implementation error|ENOBUFS/);
  }
  const malformed = assessCheckout(root, {run: (command, args, options) => args.includes('status') ? {status: 0, stdout: 'invalid'} : spawnSync(command, args, options)});
  blocked(malformed);
  const wrongRoot = assessCheckout(root, {run: (command, args, options) => args.includes('--show-toplevel') ? {status: 0, stdout: path.dirname(root) + '\n'} : spawnSync(command, args, options)});
  blocked(wrongRoot); assert.match(wrongRoot.issues.join(' '), /root does not match/);
});

test('assessment Git commands are bounded and read-only, do not inherit redirect settings, and disable external monitors', t => {
  const {root} = fixture(t), calls = [];
  const value = assessCheckout(root, {run: (command, args, options) => {calls.push({command, args, options}); return spawnSync(command, args, options);}});
  assert.equal(value.updateAllowed, true);
  for (const {command, args, options} of calls) {
    assert.ok(path.isAbsolute(command)); assert.equal(fs.realpathSync.native(command), command); assert.ok(!command.startsWith(root + path.sep));
    assert.ok(args.includes('--no-optional-locks')); assert.ok(args.includes('core.fsmonitor=false')); assert.ok(args.includes('core.hooksPath=' + gitNull));
    assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 2 * 1024 * 1024); assert.equal(options.env.GIT_CONFIG_GLOBAL, gitNull); assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(options.env.GIT_DIR, undefined); assert.equal(options.env.GIT_WORK_TREE, undefined);
    assert.equal(options.env.GIT_NO_LAZY_FETCH, '1');
    assert.ok(!args.some(value => ['fetch', 'pull', 'checkout', 'reset', 'add', 'commit', 'update-index'].includes(value)));
  }
});

test('checkout-owned Git shadows, relative PATH entries and aliases back into the checkout are never executed', t => {
  const {root} = fixture(t), aliases = scratch(t), linked = path.join(aliases, 'checkout-alias');
  fs.appendFileSync(path.join(root, '.gitignore'), 'git\ngit.exe\ngit.com\n'); git(root, ['add', '--', '.gitignore']); git(root, ['commit', '-m', 'Synthetic shadow test']); git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  for (const name of ['git', 'git.exe', 'git.com']) fs.writeFileSync(path.join(root, name), 'This checkout-owned file must never execute.\n');
  fs.symlinkSync(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const sourceEnv = {...Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'PATH')), PATH: [root, '.', 'relative-bin', linked, process.env.PATH || process.env.Path].join(path.delimiter)};
  const calls = [];
  const value = assessCheckout(root, {env: sourceEnv, run: (command, args, options) => {calls.push({command, options}); return spawnSync(command, args, options);}});
  assert.equal(value.updateAllowed, true);
  for (const {command, options} of calls) {
    assert.ok(path.isAbsolute(command)); assert.ok(!command.startsWith(root + path.sep));
    assert.ok(!options.env.PATH.split(path.delimiter).some(directory => [root, linked, '.', 'relative-bin'].includes(directory)));
  }
  let ran = false;
  blocked(assessCheckout(root, {env: {...sourceEnv, PATH: [root, '.', linked].join(path.delimiter)}, run: () => {ran = true; throw new Error('no trusted executable');}}));
  assert.equal(ran, false);
});

test('partial and promisor clones are rejected before object inspection with lazy fetching disabled', t => {
  for (const [key, value] of [['extensions.partialClone', 'origin'], ['remote.origin.promisor', 'true'], ['remote.origin.partialCloneFilter', 'blob:none']]) {
    const {root} = fixture(t); git(root, ['config', key, value]);
    const calls = [];
    const assessment = assessCheckout(root, {run: (command, args, options) => {calls.push(args); assert.equal(options.env.GIT_NO_LAZY_FETCH, '1'); return spawnSync(command, args, options);}});
    blocked(assessment); assert.match(assessment.issues.join(' '), /partial\/promisor/);
    assert.ok(!calls.some(args => args.includes('--verify') || args.includes('rev-list') || args.includes('status') || args.includes('fetch')));
  }
});

test('configured clean filters are refused before status can execute member code', t => {
  const {root} = fixture(t), sentinel = path.join(root, 'must-not-exist.txt');
  fs.writeFileSync(path.join(root, '.gitattributes'), 'obsidian-v2/example.txt filter=member\n'); git(root, ['add', '--', '.gitattributes']); git(root, ['commit', '-m', 'Synthetic attributes']);
  git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(root, ['config', 'filter.member.clean', 'node -e "require(\'fs\').writeFileSync(\'must-not-exist.txt\',\'executed\')"']);
  fs.writeFileSync(path.join(root, 'obsidian-v2', 'example.txt'), 'two\n');
  let ranStatus = false;
  const value = assessCheckout(root, {run: (command, args, options) => {if (args.includes('status')) ranStatus = true; return spawnSync(command, args, options);}});
  blocked(value); assert.match(value.issues.join(' '), /filters/); assert.equal(ranStatus, false); assert.equal(fs.existsSync(sentinel), false);
});

test('include redirects, local excludes, hidden tracked changes and protected tracked names are refused before status', t => {
  const {root} = fixture(t);
  fs.appendFileSync(path.join(root, '.git', 'config'), '\n[include]\n\tpath = nonexistent-private-file\n');
  let ran = false; blocked(assessCheckout(root, {run: () => {ran = true; throw new Error('must not run');}})); assert.equal(ran, false);
  // Remove only the synthetic include from this fixture's local config.
  const configFile = path.join(root, '.git', 'config'); fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8').replace(/\n\[include\][\s\S]*$/, ''));
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\nmember-secret-note.md\n'); blocked(assessCheckout(root));
  fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), '# no local excludes\n');
  git(root, ['update-index', '--assume-unchanged', 'obsidian-v2/example.txt']); blocked(assessCheckout(root));
  git(root, ['update-index', '--no-assume-unchanged', 'obsidian-v2/example.txt']);
  const blob = git(root, ['hash-object', '-w', '--stdin'], 'synthetic protected-file index entry; no file is opened\n');
  git(root, ['update-index', '--add', '--cacheinfo', '100644,' + blob + ',providers.json']);
  let ranStatus = false;
  const value = assessCheckout(root, {run: (command, args, options) => {if (args.includes('status')) ranStatus = true; return spawnSync(command, args, options);}});
  blocked(value); assert.match(value.issues.join(' '), /Protected configuration/); assert.equal(ranStatus, false); assert.deepEqual(value.changes, []);
});

test('linked installation paths are refused without starting Git', t => {
  const {root} = fixture(t), sibling = scratch(t), linked = path.join(sibling, 'linked');
  fs.symlinkSync(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
  let ran = false; const value = assessCheckout(linked, {run: () => {ran = true; throw new Error('must not run');}});
  blocked(value); assert.equal(ran, false);
});

test('hardlinked metadata is refused before reads and tracked env entries are refused before status', t => {
  for (const relative of ['VERSION.json', '.git/config', '.git/HEAD', '.git/index']) {
    const {root} = fixture(t), file = path.join(root, relative);
    fs.linkSync(file, path.join(root, 'metadata-link'));
    let ran = false; blocked(assessCheckout(root, {run: () => {ran = true; throw new Error('must not run');}})); assert.equal(ran, false);
  }
  for (const relative of ['.env', 'obsidian-v2/.env.local', 'obsidian-v2/.runtime/saved.json', 'credentials/member.json']) {
    const {root} = fixture(t), blob = git(root, ['hash-object', '-w', '--stdin'], 'synthetic protected index entry\n');
    git(root, ['update-index', '--add', '--cacheinfo', '100644,' + blob + ',' + relative]);
    let ranStatus = false;
    const value = assessCheckout(root, {run: (command, args, options) => {if (args.includes('status')) ranStatus = true; return spawnSync(command, args, options);}});
    blocked(value); assert.match(value.issues.join(' '), /Protected configuration/); assert.equal(ranStatus, false);
  }
});

test('control characters and protected untracked names never enter reported change paths', t => {
  const {root} = fixture(t);
  const value = assessCheckout(root, {run: (command, args, options) => args.includes('status')
    ? {status: 0, stdout: '?? member\nforged-message.md\0?? providers.json\0?? visible.md\0'} : spawnSync(command, args, options)});
  blocked(value); assert.deepEqual(value.changes, ['visible.md']); assert.doesNotMatch(JSON.stringify(value), /forged-message|providers\.json/);
});

test('update refuses unknown or customized checkouts before service checks, stop, pause, pull or install', async t => {
  const root = scratch(t), calls = [];
  const options = {root, log: () => {}, get: async () => {calls.push('get'); return {};}, halt: async () => calls.push('halt'), pull: () => calls.push('pull'), install: async () => {calls.push('install'); return {ok: true};}};
  for (const assessment of [{kind: 'customized', updateAllowed: false}, {kind: 'unknown'}, undefined]) {
    await assert.rejects(update({...options, check: () => {calls.push('check'); return assessment;}}), /Nothing was stopped or changed.*node aos\.mjs upgrade/);
  }
  assert.deepEqual(calls, ['check', 'check', 'check']); assert.equal(fs.existsSync(path.join(root, '.runtime')), false);
  calls.length = 0; await assert.rejects(update(options), /node aos\.mjs upgrade/); assert.deepEqual(calls, []);
});

test('an explicit successful assessment precedes service shutdown and the existing stock update flow', async t => {
  const {root, child} = fixture(t), calls = [];
  fs.mkdirSync(path.join(child, '.runtime')); fs.writeFileSync(path.join(child, '.runtime', 'aos-setup.json'), JSON.stringify({vault: path.join(root, 'example-vault'), voice: true}));
  const result = await update({root: child, log: () => {}, check: target => {calls.push('check'); assert.equal(target, child); return assessCheckout(target);}, get: async () => {calls.push('get'); return {};}, halt: async () => calls.push('halt'), pull: () => calls.push('pull'), install: async options => {calls.push('install'); assert.equal(options.rebuild, true); assert.equal('voice' in options, false); return {ok: true};}});
  assert.equal(result.ok, true); assert.deepEqual(calls, ['check', 'get', 'halt', 'pull', 'install']);
});

test('the default update pull reuses its assessment executable and sanitized context without contacting the network in this fixture', async t => {
  const {root, child} = fixture(t), calls = [], reads = [];
  fs.mkdirSync(path.join(child, '.runtime')); fs.writeFileSync(path.join(child, '.runtime', 'aos-setup.json'), JSON.stringify({vault: path.join(root, 'example-vault')}));
  const hostileEnv = {...env, GIT_DIR: path.join(root, 'wrong-git'), GIT_WORK_TREE: path.join(root, 'wrong-tree'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'must-not-run', GIT_EXEC_PATH: root, GIT_SSH_COMMAND: 'must-not-run'};
  let assessment;
  await update({root: child, log: () => {}, check: target => {
    assessment = assessCheckout(target, {env: hostileEnv, run: (command, args, options) => {reads.push({command, args, options}); return spawnSync(command, args, options);}});
    assert.equal(assessment.updateAllowed, true); calls.push('check'); return assessment;
  }, get: async () => {calls.push('get'); return {};}, halt: async () => calls.push('halt'), pullRun: (command, args, options) => {
    calls.push('pull'); assert.equal(command, reads[0].command); assert.deepEqual(options.env, reads[0].options.env); assert.equal(options.cwd, root);
    assert.equal(options.env.GIT_DIR, undefined); assert.equal(options.env.GIT_WORK_TREE, undefined); assert.equal(options.env.GIT_EXEC_PATH, undefined); assert.equal(options.env.GIT_CONFIG_COUNT, undefined); assert.equal(options.env.GIT_SSH_COMMAND, undefined);
    assert.equal(options.env.GIT_CONFIG_GLOBAL, gitNull); assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(options.env.GIT_NO_LAZY_FETCH, '1');
    for (const expected of ['core.fsmonitor=false', 'core.hooksPath=' + gitNull, 'credential.helper=', 'protocol.allow=never', 'protocol.https.allow=always', 'pull', '--ff-only', '--no-rebase', '--no-autostash', '--no-recurse-submodules', official, 'refs/heads/main:refs/remotes/origin/main']) assert.ok(args.includes(expected), expected);
    assert.equal(options.timeout, 300000); assert.equal(options.maxBuffer, 2 * 1024 * 1024); return {status: 0, stdout: '', stderr: ''};
  }, install: async () => {calls.push('install'); return {ok: true};}});
  assert.deepEqual(calls, ['check', 'get', 'halt', 'pull', 'install']);
  assert.doesNotMatch(JSON.stringify(assessment), /GIT_CONFIG|executable|must-not-run/);
  assert.throws(() => prepareStockUpdate({...assessment}), /fresh trusted checkout assessment/);
  let serviceRead = false;
  await assert.rejects(update({root: child, check: () => ({updateAllowed: true}), get: async () => {serviceRead = true; return {};}}), /fresh trusted checkout assessment/);
  assert.equal(serviceRead, false);
});

test('failed sanitized pull does not print Git output or private implementation errors', t => {
  const {root} = fixture(t), assessment = assessCheckout(root), log = [];
  const pull = prepareStockUpdate(assessment, {log: line => log.push(line), run: () => ({status: 1, stderr: 'private-output-marker'})});
  assert.throws(pull, error => /Services remain stopped/.test(error.message) && !error.message.includes('private-output-marker'));
  assert.doesNotMatch(log.join('\n'), /private-output-marker/);
});
