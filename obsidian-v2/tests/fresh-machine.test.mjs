// What a member's fresh computer has that the owner's does not: Windows blocking scripts, a Python
// newer than the voice libraries support, no Python helper for the Terminal plugin, and only one of
// the two coding tools installed.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import {scheduledTaskScript, taskOwner, taskNeedsPolicyRefresh, refreshAutostartPolicy} from '../scripts/aos/autostart.mjs';
import {layout, launchMonitor, refreshLoginItem} from '../scripts/aos/services.mjs';
import {processesInDir, unplacedPythons} from '../scripts/aos/platform.mjs';
import {setAsideUnsupportedVoice, removeSetAsideVoice, VOICE_BUSY, voiceRebuildMarker} from '../scripts/aos/speech.mjs';
import {prepareVoice, setupInFreshProcess, update} from '../scripts/aos/setup.mjs';
import {chooseProvider, applyProviderChoice, cliPresence, readStoredSelection, providerFile} from '../scripts/aos/provider.mjs';
import {prepareTerminalPython, terminalPythonPath, terminalMarker, recordedTerminalPython, TERMINAL_PACKAGES} from '../scripts/aos/terminal-python.mjs';
import {terminalPythonCheck} from '../scripts/aos/doctor.mjs';
import {NativeTerminalManager} from '../runner/native-terminals.mjs';

const scratched = [];
after(() => { for (const dir of scratched) fs.rmSync(dir, {recursive: true, force: true}); });
const scratch = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-fresh-')); scratched.push(dir); return dir; };
const quiet = () => {};

// ---------- 1. Windows start-at-login and the execution policy ----------
const at = layout(path.resolve('/x/aos/obsidian-v2'));
const wrapper = path.join(at.root, 'scripts', 'run-recovery.ps1');
const taskJson = args => JSON.stringify({exists: true, actions: [{execute: 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', arguments: args}]});
const oldArgs = `-NoProfile -NonInteractive -WindowStyle Hidden -File "${wrapper}" -NodeExecutable "C:\\node\\node.exe" -ConfigFile "${at.config}"`;
const newArgs = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${wrapper}" -NodeExecutable "C:\\node\\node.exe" -ConfigFile "${at.config}"`;

test('the login task runs with a per-process execution-policy bypass, and both task shapes stay ours', () => {
  assert.match(scheduledTaskScript({node: 'C:\\node\\node.exe', config: at.config, wrapper, cwd: at.root}), /'-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'/);
  assert.equal(taskOwner(taskJson(oldArgs), at), 'ours');
  assert.equal(taskOwner(taskJson(newArgs), at), 'ours');
  assert.equal(taskNeedsPolicyRefresh(taskJson(oldArgs), at), true);
  assert.equal(taskNeedsPolicyRefresh(taskJson(newArgs), at), false);
  for (const foreign of [newArgs.replace(at.config, 'C:\\other\\service-recovery.json'), `-NoProfile -Command "& '${wrapper}'"`, newArgs.replace('-ExecutionPolicy Bypass ', '-ExecutionPolicy Unrestricted ')]) {
    assert.equal(taskOwner(taskJson(foreign), at), 'other', foreign);
    assert.equal(taskNeedsPolicyRefresh(taskJson(foreign), at), false);
  }
});

test('refreshing the login task re-registers only our own old-shape task, only on Windows, and never kicks or removes', () => {
  const answer = stdout => () => ({status: 0, stdout});
  for (const [stdout, expected] of [[taskJson(oldArgs), 1], [taskJson(newArgs), 0], [taskJson(newArgs.replace(at.config, 'C:\\x.json')), 0], ['{"exists":false}', 0], ['{"error":true}', 0], ['not json', 0]]) {
    const enabled = [];
    assert.equal(refreshAutostartPolicy(at, {platform: 'win32', run: answer(stdout), enable: (...args) => enabled.push(args)}), expected === 1);
    assert.equal(enabled.length, expected, stdout);
  }
  const enabled = [];
  assert.equal(refreshAutostartPolicy(at, {platform: 'win32', run: () => ({status: 1, stdout: ''}), enable: () => enabled.push(1)}), false, 'an unanswered question changes nothing');
  assert.equal(refreshAutostartPolicy(at, {platform: 'darwin', run: () => assert.fail('macOS is never queried'), enable: () => enabled.push(1)}), false);
  assert.equal(enabled.length, 0);
  const said = [];
  refreshLoginItem(at, {log: line => said.push(line), refresh: () => { throw new Error('Windows refused'); }});
  assert.match(said[0], /could not update the Windows login task \(Windows refused\)\. Services still start now/);
});

test('a login item that never brings the monitor up is followed by a direct start; a working one is not', async () => {
  const run = async ({upAfter, owner = 'ours', kicks = true}) => {
    let polls = 0, spawned = 0;
    const result = await launchMonitor(at, {log: quiet, owner, kick: () => kicks, spawnMonitor: () => spawned++, wait: async () => {},
      status: async () => (++polls >= upAfter ? {runtimeDir: at.runtime} : null)}).catch(error => error);
    return {result, spawned, polls};
  };
  const refused = await run({upAfter: 15});
  assert.deepEqual([refused.result.started, refused.spawned], [true, 1], 'kicked task did nothing for 6 s: started directly once');
  const working = await run({upAfter: 3});
  assert.deepEqual([working.result.started, working.spawned], [true, 0]);
  const noItem = await run({upAfter: 2, owner: null});
  assert.deepEqual([noItem.result.started, noItem.spawned], [true, 1]);
  const never = await run({upAfter: 999});
  assert.match(never.result.message, /did not become available/); assert.equal(never.spawned, 1, 'the fallback runs once');
  await assert.rejects(launchMonitor(at, {log: quiet, owner: 'other', kick: () => assert.fail(), spawnMonitor: () => assert.fail()}), /different installation owns/);
});

// ---------- 2. Voice and Python 3.14 ----------
function voiceInstall({version = '3.14.7'} = {}) {
  const root = path.join(scratch(), 'obsidian-v2'), install = layout(root);
  fs.mkdirSync(path.dirname(install.speechPython), {recursive: true}); fs.writeFileSync(install.speechPython, '');
  const run = () => ({status: 0, stdout: `Python ${version}`});
  return {at: install, run};
}
const supported = () => ({command: 'py', prefix: ['-3.12'], version: '3.12.9'});

test('a voice environment made with Python 3.14 is set aside only when it is proven unused', async () => {
  const cases = [
    ['busy monitor or voice port', {busy: async () => true, inUse: () => []}, 'deferred'],
    ['process list unreadable', {busy: async () => false, inUse: () => null}, 'deferred'],
    ['a process still runs from it', {busy: async () => false, inUse: () => [4242]}, 'deferred'],
    ['Windows keeps the folder locked', {busy: async () => false, inUse: () => [], rename: () => { throw new Error('EBUSY'); }}, 'deferred'],
  ];
  for (const [label, options, state] of cases) {
    const {at: install, run} = voiceInstall();
    const result = await setAsideUnsupportedVoice(install, {run, find: supported, log: quiet, ...options});
    assert.equal(result.state, state, label); assert.equal(result.reason, VOICE_BUSY);
    assert.equal(fs.existsSync(install.speechPython), true, `${label}: nothing moved or deleted`);
  }
  const {at: install, run} = voiceInstall();
  const noPython = await setAsideUnsupportedVoice(install, {run, find: ({seen}) => { seen.push('3.14.7'); return null; }, busy: async () => assert.fail('not asked'), inUse: () => assert.fail('not asked'), log: quiet});
  assert.equal(noPython.state, 'no-python'); assert.match(noPython.reason, /Found Python 3\.14\.7/); assert.equal(fs.existsSync(install.speechPython), true);
  const said = [];
  const done = await setAsideUnsupportedVoice(install, {run, find: supported, busy: async () => false, inUse: () => [], log: line => said.push(line)});
  assert.equal(done.state, 'set-aside'); assert.equal(fs.existsSync(install.venv), false);
  assert.equal(fs.existsSync(voiceRebuildMarker(install)), true, 'the rebuild is marked pending before anything moves');
  assert.equal(fs.existsSync(done.aside), true, 'the old environment is kept until its replacement installed');
  assert.match(said[0], /used Python 3\.14\.7; it was set aside and will be rebuilt/);
  const healthy = voiceInstall({version: '3.12.9'});
  assert.equal((await setAsideUnsupportedVoice(healthy.at, {run: healthy.run, find: () => assert.fail(), busy: () => assert.fail(), inUse: () => assert.fail()})).state, 'not-needed');
});

test('a set-aside environment something still runs from is kept for a later setup', () => {
  const {at: install} = voiceInstall();
  const aside = `${install.venv}.old-1`; fs.mkdirSync(aside, {recursive: true});
  removeSetAsideVoice(install, {inUse: () => [7]}); assert.equal(fs.existsSync(aside), true);
  removeSetAsideVoice(install, {inUse: () => null}); assert.equal(fs.existsSync(aside), true, 'unknown counts as in use');
  removeSetAsideVoice(install, {inUse: () => []}); assert.equal(fs.existsSync(aside), false);
});

test('an ordinary update reaches the voice repair: prepareVoice checks before its installed-files shortcut', async () => {
  const {at: install} = voiceInstall();
  const said = [], plan = async () => ({own: true, shared: false, healthy: false, url: 'http://127.0.0.1:3220'});
  const deferred = await prepareVoice(install, {wantVoice: true, log: line => said.push(line), plan, installed: () => true, installVoice: async () => assert.fail('not reinstalled while deferred'),
    setAside: async () => ({state: 'deferred', reason: VOICE_BUSY})});
  assert.equal(deferred, 'deferred'); assert.match(said.at(-1), /needs rebuilding.*node aos\.mjs stop/);
  let installs = 0;
  const removed = [];
  const rebuilt = await prepareVoice(install, {wantVoice: true, log: quiet, plan, installed: () => false, installVoice: async () => { installs++; assert.equal(removed.length, 0, 'not removed before the install'); }, setAside: async () => ({state: 'set-aside'}), removeAside: () => removed.push(1)});
  assert.equal(rebuilt, 'installed'); assert.equal(installs, 1); assert.equal(removed.length, 1);
  await assert.rejects(prepareVoice(install, {wantVoice: true, log: quiet, plan, installed: () => false, installVoice: async () => { throw new Error('pip failed'); }, setAside: async () => ({state: 'set-aside'}), removeAside: () => assert.fail('a failed install keeps the old environment')}), /pip failed/);
  // A rebuild whose packages failed is retried by the next ordinary setup, not taken for installed voice.
  fs.mkdirSync(install.runtime, {recursive: true}); fs.writeFileSync(voiceRebuildMarker(install), '{}');
  await assert.rejects(prepareVoice(install, {wantVoice: true, log: quiet, plan, installed: () => true, installVoice: async () => { throw new Error('still offline'); }, setAside: async () => ({state: 'not-needed'}), removeAside: () => assert.fail()}), /still offline/);
  assert.equal(fs.existsSync(voiceRebuildMarker(install)), true, 'still pending after another failure');
  let retried = 0;
  assert.equal(await prepareVoice(install, {wantVoice: true, log: quiet, plan, installed: () => true, installVoice: async () => { retried++; }, setAside: async () => ({state: 'not-needed'}), removeAside: () => {}}), 'installed');
  assert.equal(retried, 1); assert.equal(fs.existsSync(voiceRebuildMarker(install)), false);
  assert.equal(await prepareVoice(install, {wantVoice: true, log: quiet, plan, installed: () => true, installVoice: async () => assert.fail(), setAside: async () => ({state: 'not-needed'})}), 'present');
  assert.equal(await prepareVoice(install, {wantVoice: true, log: quiet, plan, installed: () => true, installVoice: async () => assert.fail(), setAside: async () => ({state: 'not-needed'})}), 'present', 'healthy environments keep the cheap path');
});

test('a Python that does not show its environment counts as possibly running from the folder', () => {
  const dir = path.resolve('/A/speech-venv');
  const rows = [
    {pid: 1, commandLine: 'python -u runner/speech.py'},
    {pid: 2, commandLine: 'python3.12 speech.py'},
    {pid: 3, commandLine: 'bin/python -u speech.py'},
    {pid: 4, commandLine: 'bin/python -u speech.py'},
    {pid: 5, commandLine: 'bin/python x.py'},
    {pid: 6, commandLine: '/usr/bin/python3 other.py'},
    {pid: 7, commandLine: 'node bridge.mjs'},
    {pid: 8, commandLine: 'pythonista run'},
  ];
  const cwd = {3: dir, 4: path.resolve('/elsewhere'), 5: null};
  assert.deepEqual(unplacedPythons(rows, dir, {cwdOf: pid => cwd[pid]}), [1, 2, 3, 5]);
});

test('the process check matches only programs started from inside the folder', () => {
  const dir = path.resolve('/A/speech-venv');
  const rows = [
    {pid: 1, executable: path.join(dir, 'Scripts', 'python.exe')},
    {pid: 2, commandLine: `${path.resolve('/A/speech-venv-other')}/bin/python`},
    {pid: 3, commandLine: `"${dir}/bin/python" -u speech.py`},
    {pid: 4, commandLine: 'node bridge.mjs'},
    {pid: 5, commandLine: '.runtime/speech-venv/bin/python -u runner/speech.py', executable: ''},
    {pid: 6, commandLine: 'speech-venv/bin/python -u runner/speech.py'},
    {pid: 7, commandLine: '/other/my-speech-venv/bin/python'},
  ];
  assert.deepEqual(processesInDir(rows, dir), [1, 3, 5, 6], 'relative launches count as in use; a different folder name does not');
});

// ---------- 3. The Terminal plugin's Python helper ----------
function terminalInstall() { const root = path.join(scratch(), 'obsidian-v2'), install = layout(root); fs.mkdirSync(install.runtime, {recursive: true}); return install; }
// A fake computer: creating the venv writes its python; the check passes unless told otherwise.
function fakePython(install, platform, {checkOk = true, pipOk = true} = {}) {
  const python = terminalPythonPath(install.runtime, platform), calls = [];
  const run = (command, args) => {
    calls.push([command, ...args].join(' '));
    if (args.includes('venv')) { fs.mkdirSync(path.dirname(python), {recursive: true}); fs.writeFileSync(python, ''); return {status: 0}; }
    if (args[0] === '--version') return {status: 0, stdout: 'Python 3.12.9'};
    if (args.includes('pip')) return {status: pipOk ? 0 : 1, stderr: 'no network'};
    if (args[0] === '-c') return {status: checkOk ? 0 : 1};
    return {status: 1};
  };
  return {python, calls, run};
}

test('setup prepares the Terminal helper Python, installs the Windows modules, and records it only after the check passes', () => {
  for (const platform of ['win32', 'darwin']) {
    const install = terminalInstall(), fake = fakePython(install, platform);
    assert.equal(prepareTerminalPython(install, {inUse: () => [], log: quiet, run: fake.run, platform, find: () => ({command: 'py', prefix: ['-3.12'], version: '3.12.9'})}), 'installed', platform);
    assert.equal(recordedTerminalPython(install.runtime, {platform}), fake.python);
    assert.equal(fake.calls.some(call => call.includes(TERMINAL_PACKAGES.join(' '))), platform === 'win32', 'psutil and pywinctl only on Windows');
    assert.equal(prepareTerminalPython(install, {inUse: () => [], log: quiet, run: fake.run, platform, find: () => assert.fail('a ready helper is not rebuilt')}), 'ready');
  }
});

test('a failed repair removes the record even though the old python file is still there (no stale override)', () => {
  const install = terminalInstall(), platform = 'win32', good = fakePython(install, platform);
  prepareTerminalPython(install, {inUse: () => [], log: quiet, run: good.run, platform, find: () => ({command: 'py', prefix: [], version: '3.12.9'})});
  assert.ok(recordedTerminalPython(install.runtime, {platform}));
  const broken = fakePython(install, platform, {checkOk: false, pipOk: false}), said = [];
  assert.equal(prepareTerminalPython(install, {log: line => said.push(line), run: broken.run, platform, inUse: () => [], find: () => ({command: 'py', prefix: [], version: '3.12.9'})}), 'failed');
  assert.equal(fs.existsSync(good.python), true, 'the interpreter file is still present');
  assert.equal(fs.existsSync(terminalMarker(install.runtime)), false);
  assert.equal(recordedTerminalPython(install.runtime, {platform}), null);
  assert.match(said.at(-1), /could not be prepared.*use the same buttons in Jarvis/);
});

test('the helper environment is never repaired or replaced while a conversation may be using it', () => {
  const install = terminalInstall(), platform = 'win32', good = fakePython(install, platform);
  prepareTerminalPython(install, {log: quiet, run: good.run, platform, find: () => ({command: 'py', prefix: [], version: '3.12.9'}), inUse: () => []});
  for (const inUse of [() => [4242], () => null]) {
    const broken = fakePython(install, platform, {checkOk: false}), said = [];
    const outcome = prepareTerminalPython(install, {log: line => said.push(line), run: broken.run, platform, find: () => assert.fail('no rebuild while in use'), inUse});
    assert.equal(outcome, 'deferred'); assert.match(said[0], /may be using it\. Close those conversations/);
    assert.equal(broken.calls.some(call => call.includes(' -m pip') || call.includes(' -m venv')), false, 'no package changes and no new environment');
    assert.equal(fs.existsSync(good.python), true, 'nothing deleted');
    assert.equal(recordedTerminalPython(install.runtime, {platform}), null, 'the broken helper is no longer advertised');
  }
  const locked = fakePython(install, platform, {checkOk: false});
  const run = (command, args) => args[0] === '--version' ? {status: 0, stdout: 'Python 3.8.0'} : locked.run(command, args);
  assert.equal(prepareTerminalPython(install, {log: quiet, run, platform, find: () => ({command: 'py', prefix: [], version: '3.12.9'}), inUse: () => [], rename: () => { throw new Error('EBUSY'); }}), 'deferred');
  assert.equal(fs.existsSync(good.python), true, 'a locked folder is left whole');
});

test('without any usable Python, setup continues and says what to install', () => {
  const install = terminalInstall(), said = [];
  assert.equal(prepareTerminalPython(install, {inUse: () => [], log: line => said.push(line), run: () => ({status: 1}), platform: 'win32', find: ({seen}) => { seen.push('3.8.10'); return null; }}), 'no-python');
  assert.match(said[0], /no usable Python found \(found 3\.8\.10\).*winget install Python\.Python\.3\.12/);
});

test('the record is only trusted for this installation\'s own interpreter, when it still exists', () => {
  const install = terminalInstall(), platform = process.platform, python = terminalPythonPath(install.runtime, platform);
  const write = value => fs.writeFileSync(terminalMarker(install.runtime), typeof value === 'string' ? value : JSON.stringify(value));
  fs.mkdirSync(path.dirname(python), {recursive: true}); fs.writeFileSync(python, '');
  for (const bad of ['not json', {version: 2, python}, {version: 1, python: 7}, {version: 1, python: path.resolve('/usr/bin/python3')}]) { write(bad); assert.equal(recordedTerminalPython(install.runtime), null, JSON.stringify(bad)); }
  write({version: 1, python}); assert.equal(recordedTerminalPython(install.runtime), python);
  fs.rmSync(python); assert.equal(recordedTerminalPython(install.runtime), null, 'a missing interpreter is not advertised');
});

test('the doctor asks for the helper only once the Terminal plugin is in use', () => {
  assert.equal(terminalPythonCheck('/r', {terminal: {status: 'SKIP'}, recorded: () => assert.fail()}).status, 'SKIP');
  assert.equal(terminalPythonCheck('/r', {terminal: {status: 'PASS'}, recorded: () => '/r/py', works: () => true}).status, 'PASS');
  const broken = terminalPythonCheck('/r', {terminal: {status: 'PASS'}, recorded: () => '/r/py', works: () => false});
  assert.equal(broken.status, 'FAIL'); assert.match(broken.detail, /no longer runs or loads/);
  const missing = terminalPythonCheck('/r', {terminal: {status: 'PASS'}, recorded: () => null});
  assert.equal(missing.status, 'FAIL'); assert.match(missing.fix, /node aos\.mjs setup.*Jarvis at http:\/\/127\.0\.0\.1:3217/);
});

test('the bridge hands the plugin the managed Python only when setup recorded one', t => {
  const root = scratch();
  const launchOf = terminalPython => {
    const manager = new NativeTerminalManager(root, {directory: path.join(root, 'work-' + Math.random()), now: () => 1, stopTree: false, terminalPython,
      resolveNativeCli: provider => ({command: process.execPath, prefix: [`fixture-${provider}.mjs`], source: 'fixture'}),
      schedule: () => ({unref() {}}), cancelSchedule() {}, defer: () => ({unref() {}}), cancelDeferred() {}});
    t.after(() => manager.close());
    const task = manager.start({selection: {provider: 'claude', model: 'opus'}, prompt: 'Hello', execution: 'native'});
    return task.native.actions.find(action => action.type === 'launch').launch;
  };
  assert.equal(launchOf(() => null).pythonExecutable, undefined);
  assert.equal(launchOf(() => 'C:\\aos\\.runtime\\terminal-venv\\Scripts\\python.exe').pythonExecutable, 'C:\\aos\\.runtime\\terminal-venv\\Scripts\\python.exe');
});

test('the plugin uses a valid bridge-supplied Python, refuses an invalid one, and otherwise keeps the old fallback', async () => {
  const built = await build({entryPoints: ['src/lib/direct-terminal-profile.ts'], bundle: true, platform: 'node', format: 'esm', write: false});
  const {directTerminalViewState} = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
  const id = n => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n.repeat(12)}`;
  const action = launch => ({id: id('1'), taskId: id('2'), instance: id('3'), type: 'launch', provider: 'claude', launch: {executable: 'C:\\node\\node.exe', args: ['C:\\aos\\runner\\native-launch.mjs', '--ticket', 'C:\\aos\\t.json'], cwd: 'C:\\vault', environment: [], ...launch}});
  const python = state => state.state['terminal:terminal'].profile.pythonExecutable;
  assert.equal(python(directTerminalViewState(action({pythonExecutable: 'C:\\aos\\.runtime\\terminal-venv\\Scripts\\python.exe'}), {pythonExecutable: 'C:\\user\\python.exe'})), 'C:\\aos\\.runtime\\terminal-venv\\Scripts\\python.exe');
  assert.equal(python(directTerminalViewState(action({}), {pythonExecutable: 'C:\\user\\python.exe'})), 'C:\\user\\python.exe');
  assert.equal(python(directTerminalViewState(action({}))), 'python');
  for (const bad of ['python', 'C:\\evil\\cmd.exe', 7, 'C:\\aos\\python.exe\nx']) assert.throws(() => directTerminalViewState(action({pythonExecutable: bad})), /launch Python is invalid/, String(bad));
});

// ---------- 4. The provider the member installs from ----------
const presence = (claude, codex) => ({claude, codex});

test('a fresh install picks the one coding tool that is installed, or the one running setup', () => {
  const absent = {state: 'absent'};
  const pick = (p, env = {}) => chooseProvider({stored: absent, presence: p, env}).selection;
  assert.deepEqual(pick(presence('installed', 'missing')), {provider: 'claude', model: 'opus'});
  assert.deepEqual(pick(presence('missing', 'installed')), {provider: 'codex', model: 'gpt-6-astra'});
  assert.deepEqual(pick(presence('installed', 'installed'), {CLAUDECODE: '1'}), {provider: 'claude', model: 'opus'});
  assert.deepEqual(pick(presence('installed', 'installed')), {provider: 'codex', model: 'gpt-6-astra'});
  assert.deepEqual(pick(presence('unknown', 'missing')), {provider: 'codex', model: 'gpt-6-astra'}, 'unknown is not installed');
  assert.match(chooseProvider({stored: absent, presence: presence('missing', 'missing')}).note, /Neither Claude Code nor Codex/);
});

test('an existing choice is never changed without --provider, only explained', () => {
  const stored = {state: 'valid', selection: {provider: 'codex', model: 'gpt-6-astra'}};
  const kept = chooseProvider({stored, presence: presence('installed', 'missing')});
  assert.deepEqual([kept.write, kept.selection], [false, stored.selection]);
  assert.match(kept.note, /use Codex, which is not installed here; Claude Code is\. To switch: node aos\.mjs setup --provider claude/);
  assert.equal(chooseProvider({stored, presence: presence('installed', 'unknown')}).note, '', 'an unreadable pin is not "missing"');
  const custom = {state: 'valid', selection: {provider: 'claude', model: 'haiku'}};
  assert.deepEqual(chooseProvider({explicit: 'claude', stored: custom, presence: presence('installed', 'installed')}), {selection: {provider: 'claude', model: 'haiku'}, write: false, note: ''}, 'same provider keeps its model');
  const switched = chooseProvider({explicit: 'claude', stored, presence: presence('installed', 'installed')});
  assert.deepEqual([switched.write, switched.selection], [true, {provider: 'claude', model: 'opus'}]);
  assert.equal(chooseProvider({stored: {state: 'invalid'}, presence: presence('installed', 'installed')}).write, false);
});

test('setup writes the choice before the plugin install and leaves an existing file alone', () => {
  const vault = scratch(), said = [];
  applyProviderChoice(vault, {log: line => said.push(line), env: {}, presence: presence('installed', 'missing')});
  assert.deepEqual(readStoredSelection(vault), {state: 'valid', selection: {provider: 'claude', model: 'opus'}});
  assert.match(said[0], /Buttons and voice use Claude Code \(opus\)/);
  fs.writeFileSync(providerFile(vault), JSON.stringify({provider: 'claude', model: 'sonnet'}));
  applyProviderChoice(vault, {log: quiet, env: {}, presence: presence('missing', 'installed')});
  assert.deepEqual(JSON.parse(fs.readFileSync(providerFile(vault), 'utf8')), {provider: 'claude', model: 'sonnet'}, 'update never rewrites a member\'s choice');
});

test('CLI presence uses this installation\'s pins and treats a broken pin as unknown', () => {
  const runtime = scratch();
  assert.equal(cliPresence('claude', {runtimeDir: runtime, resolve: () => ({command: 'x'})}), 'installed');
  assert.equal(cliPresence('claude', {runtimeDir: runtime, resolve: () => null}), 'missing');
  assert.equal(cliPresence('claude', {runtimeDir: runtime, resolve: () => { throw new Error('pinned path gone'); }}), 'unknown');
  fs.writeFileSync(path.join(runtime, 'providers.json'), '{broken');
  assert.equal(cliPresence('claude', {runtimeDir: runtime, resolve: () => assert.fail()}), 'unknown');
  fs.writeFileSync(path.join(runtime, 'providers.json'), JSON.stringify({claude: {command: '/pinned/claude'}}));
  let seenPins; cliPresence('claude', {runtimeDir: runtime, resolve: (provider, {pins}) => { seenPins = pins; return {}; }});
  assert.deepEqual(seenPins, {claude: {command: '/pinned/claude'}});
});

// ---------- Update runs the freshly pulled setup ----------
test('update runs setup in a fresh process from the updated files and reports its exit status', () => {
  const calls = [];
  const spawnImpl = (command, args, options) => { calls.push({command, args, options}); return {status: calls.length === 1 ? 0 : 3}; };
  assert.deepEqual(setupInFreshProcess({root: '/aos/obsidian-v2', vault: '/v', rebuild: true, log: quiet, spawnImpl}), {ok: true, exitCode: 0});
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [path.join('/aos/obsidian-v2', 'scripts', 'aos.mjs'), 'setup', '--vault', '/v', '--rebuild']);
  assert.equal(calls[0].options.stdio, 'inherit');
  assert.deepEqual(setupInFreshProcess({root: '/r', vault: '/v', log: quiet, spawnImpl}), {ok: false, exitCode: 3});
  assert.throws(() => setupInFreshProcess({root: '/r', vault: '/v', log: quiet, spawnImpl: () => ({error: new Error('ENOENT')})}), /Could not run the updated setup.*ENOENT/);
  assert.match(update.toString(), /install = options => setupInFreshProcess\(options\)/, 'the default install is the fresh process');
});
