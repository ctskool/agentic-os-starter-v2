// The doctor against stand-in services that live on a thread of their own, so a test can freeze
// the doctor the way a real run is frozen and the services carry on, as real ones do.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {doctor, voiceProblem, terminalPluginCheck} from '../scripts/aos/doctor.mjs';
import {fetchJson, request, run} from '../scripts/aos/platform.mjs';
import {speechPlan, layout, PORTS} from '../scripts/aos/services.mjs';
import {prepareVoice, watchedServices, update} from '../scripts/aos/setup.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-doctor-test-'));
const workers = [];
after(async () => { await Promise.all(workers.map(worker => worker.terminate())); fs.rmSync(scratch, {recursive: true, force: true}); });

const VOICE = ['Voice service healthy', 'Text to speech', 'Speech to text hears it back'];
const HOTKEY = 'Global voice shortcut';
const TERMINAL = 'Terminal plugin (conversations inside Obsidian)';
const freeze = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Unless a test says otherwise: one coding CLI is installed and answers its sign-in check.
function fakeServices(state = {}) {
  const worker = new Worker(new URL('./fixtures/aos-fake-services.mjs', import.meta.url), {workerData: {providers: {claude: {installed: true, version: '1.0', command: process.execPath}}, ...state}});
  workers.push(worker);
  const next = () => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  return next().then(started => ({...started,
    set: async values => { const done = next(); worker.postMessage({set: values}); await done; },
    seen: async () => { const report = next(); worker.postMessage({report: true}); return (await report).seen; }}));
}

// An installation folder with a vault that Obsidian has opened; voice: true | false; installed = own voice files on disk.
function installation({voice = true, installed = false, opened = true} = {}) {
  const root = path.join(fs.mkdtempSync(path.join(scratch, 'install-')), 'obsidian-v2'), vault = path.join(path.dirname(root), 'vault'), at = layout(root);
  for (const dir of [at.runtime, path.join(vault, 'system', 'schemas'), path.join(vault, '.obsidian', 'plugins', 'agentic-os-v2')]) fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(at.runtime, 'aos-setup.json'), JSON.stringify({voice}));
  fs.writeFileSync(at.vaultFile, JSON.stringify({vault}));
  fs.writeFileSync(path.join(vault, 'system', 'schemas', 'daily-note.md'), '# schema');
  for (const name of ['main.js', 'manifest.json', 'styles.css']) fs.writeFileSync(path.join(vault, '.obsidian', 'plugins', 'agentic-os-v2', name), '');
  fs.writeFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), '["agentic-os-v2"]');
  if (opened) fs.writeFileSync(path.join(vault, '.obsidian', 'workspace.json'), '{}');
  if (installed) {
    fs.mkdirSync(path.dirname(at.speechPython), {recursive: true}); fs.writeFileSync(at.speechPython, '');
    fs.mkdirSync(at.speechAssets, {recursive: true}); for (const name of ['kokoro-v1.0.onnx', 'voices-v1.0.bin']) fs.writeFileSync(path.join(at.speechAssets, name), '');
  }
  return {root, vault, at};
}

// The doctor's clock only moves when it pauses, so its waiting costs the tests no real time.
async function examine(services, install, {pause, ...options} = {}) {
  const lines = []; let clock = 0;
  const result = await doctor({root: install.root, ports: services.ports, log: line => lines.push(line), now: () => clock, pause: async ms => { clock += ms; await pause?.(ms); },
    voiceWaitMs: 6000, runCommand: async () => ({status: 0, stdout: 'OK'}), ...options});
  const line = name => result.results.find(item => item.name === name);
  return {...result, lines, text: lines.join('\n'), line};
}

test('a doctor that was frozen by its sign-in checks still reaches the bridge (the swap-test failure)', async () => {
  // Real runs: claude and codex take about 13 s to answer, the bridge closes an idle kept-alive
  // connection after 5 s, and the doctor cannot see that while it is frozen. Its next request used to
  // go out on the dead connection: ECONNRESET, reported as "voice installed but not answering".
  const services = await fakeServices({speech: 'shared', keepAliveMs: 150, providers: {claude: {installed: true, version: '1.0', command: process.execPath}}});
  const found = await examine(services, installation(), {runCommand: async () => { freeze(2500); return {status: 0, stdout: 'OK'}; }});
  assert.equal(found.line('claude signed in').status, 'PASS');
  for (const name of VOICE) assert.equal(found.line(name).status, 'PASS', `${name}: ${found.text}`);
  assert.equal(found.ok, true, found.text);
  // The property behind it, independent of timing luck: every request arrived on a connection of its
  // own. A pooled client shows fewer connections than requests here, or loses a request to a dead one.
  const seen = await services.seen();
  assert.ok(seen.bridge.length >= 2 && seen.monitor.length >= 2, JSON.stringify(seen));
  assert.equal(seen.connections.bridge, seen.bridge.length, 'one connection per request to the bridge');
  assert.equal(seen.connections.monitor, seen.monitor.length, 'one connection per request to the monitor');
});

test('a borrowed speech service reads as PASS, says it is shared, and the speak-to-listen round trip really runs against it', async () => {
  const services = await fakeServices({speech: 'shared'});
  const found = await examine(services, installation({installed: false}));
  assert.equal(found.line(VOICE[0]).status, 'PASS');
  assert.match(found.line(VOICE[0]).detail, new RegExp(`shared service at ${services.sharedUrl}, run by another program`));
  assert.match(found.line(VOICE[1]).detail, /KB of audio/);
  assert.match(found.line(VOICE[2]).detail, /Voice check/);
  assert.deepEqual((await services.seen()).speech.filter(call => !call.endsWith('/health')), ['GET /speak', 'POST /stt'], 'both calls reached the shared service itself');
  assert.equal(found.failed, 0, found.text);
});

test('this installation\'s own speech service reads as PASS and says it is its own', async () => {
  const services = await fakeServices({speech: 'own'});
  const found = await examine(services, installation({installed: true}));
  assert.match(found.line(VOICE[0]).detail, new RegExp(`this installation's own service on ${services.ports.speech}`));
  for (const name of VOICE) assert.equal(found.line(name).status, 'PASS');
});

test('Mac and Windows shortcut registration uses fresh voice health, without claiming microphone verification', async () => {
  for (const platform of ['darwin', 'win32']) {
    const services = await fakeServices({speech: 'own', hotkey: {enabled: true, combo: 'ctrl+alt+j', ok: false, error: 'Earlier conflict'}});
    const found = await examine(services, installation({installed: true}), {platform,
      runCommand: async () => {
        await services.set({hotkey: {enabled: true, combo: 'ctrl+alt+k', ok: true, error: null}});
        return {status: 0, stdout: 'OK'};
      }});
    assert.equal(found.line(HOTKEY).status, 'PASS', found.text);
    assert.match(found.line(HOTKEY).detail, /ctrl\+alt\+k registered/);
    assert.match(found.line(HOTKEY).detail, /microphone capture and use from another app still need a hands-on test/);
    assert.equal(found.failed, 0, found.text);
  }
});

test('shortcut registration failure is an optional failure while speech still gets its round trip', async () => {
  for (const platform of ['darwin', 'win32']) {
    const services = await fakeServices({speech: 'own'});
    const found = await examine(services, installation({installed: true}), {platform,
      runCommand: async () => {
        await services.set({hotkey: {enabled: true, combo: 'ctrl+alt+j', ok: false, error: 'Already owned by another app'}});
        return {status: 0, stdout: 'OK'};
      }});
    assert.equal(found.line(HOTKEY).status, 'FAIL'); assert.equal(found.line(HOTKEY).optional, true);
    assert.match(found.line(HOTKEY).detail, /Already owned by another app/);
    assert.match(found.text, /choose another VOICE_HOTKEY combination/);
    for (const name of VOICE) assert.equal(found.line(name).status, 'PASS');
    assert.equal(found.failed, 1); assert.equal(found.coreFailed, 0); assert.equal(found.ok, false);
    assert.match(found.lines.at(-1), /1 optional part\(s\) need attention: Global voice shortcut/);
    assert.doesNotMatch(found.lines.at(-1), /All checks passed/);
  }
});

// These are the speech runtime's real failure messages. The doctor must diagnose
// each without assuming that every failed registration means another app owns J.
async function shortcutFailure(error, {capture, platform = 'darwin', services, install} = {}) {
  services ||= await fakeServices({speech: 'own'});
  install ||= installation({installed: true});
  await services.set({hotkey: {enabled: true, combo: 'ctrl+alt+j', ok: false, error}, capture});
  const found = await examine(services, install, {platform});
  assert.equal(found.line(HOTKEY).status, 'FAIL', found.text);
  assert.equal(found.line(HOTKEY).optional, true);
  assert.equal(found.failed, 1); assert.equal(found.coreFailed, 0);
  for (const name of VOICE) assert.equal(found.line(name).status, 'PASS', found.text);
  const advice = found.lines.find(line => line.startsWith(`FAIL ${HOTKEY}`)).split('\n     fix: ')[1];
  return {...found, advice};
}

test('shortcut advice repairs missing microphone support instead of changing keys', async () => {
  for (const [error, capture] of [
    ['Microphone dependency unavailable: ModuleNotFoundError', undefined],
    [null, {available: false, error: null}],
    ['Mac hotkey helper stopped; restart voice to register it again.', {available: false, error: 'Microphone dependency unavailable: OSError'}],
  ]) {
    const found = await shortcutFailure(error, {capture});
    assert.match(found.advice, /setup --voice yes/);
    assert.match(found.advice, /microphone support/i);
    assert.doesNotMatch(found.advice, /another app|choose another|VOICE_HOTKEY/i);
    if (capture?.error) assert.equal(found.line(HOTKEY).detail, capture.error);
  }
});

test('shortcut advice checks microphone input and permission for capture failures', async () => {
  for (const platform of ['darwin', 'win32']) {
    const found = await shortcutFailure('Capture failed: PortAudioError', {platform, capture: {available: true, error: 'Capture failed: PortAudioError'}});
    assert.match(found.advice, /microphone input/i);
    assert.match(found.advice, /microphone permission/i);
    assert.match(found.advice, /speech process/i);
    assert.doesNotMatch(found.advice, /another app|choose another|setup --voice yes/i);
  }
});

test('shortcut advice identifies helper failures and stops repeating restart advice', async () => {
  const services = await fakeServices({speech: 'own'}), install = installation({installed: true});
  for (const error of [
    'Mac hotkey registration timed out; use the microphone button.',
    'Hotkey registration timed out.',
    'Mac hotkey helper exited during registration.',
    'Mac hotkey helper stopped; restart voice to register it again.',
    'Mac hotkey helper sent an invalid response.',
    'Mac hotkey helper sent an unexpected response.',
    'Mac hotkey event loop failed (macOS error -9870).',
  ]) {
    const found = await shortcutFailure(error, {services, install});
    assert.match(found.advice, /shortcut (helper|listener)/i);
    assert.match(found.advice, /node aos\.mjs stop.*node aos\.mjs start/);
    assert.doesNotMatch(found.advice, /another app|choose another|VOICE_HOTKEY/i);
    const repeated = await shortcutFailure(error, {services, install});
    assert.match(repeated.advice, /service-supervisor\.jsonl/);
    assert.match(repeated.advice, /coding agent/);
    assert.doesNotMatch(repeated.advice, /run `node aos\.mjs (stop|start)`/i);
  }
});

test('shortcut advice reserves key-conflict remedies for known conflicts', async () => {
  for (const [platform, error] of [
    ['darwin', 'Mac hotkey unavailable (macOS error -9878); another app may own it.'],
    ['win32', 'Hotkey unavailable (Windows error 1409); another app may own it.'],
  ]) {
    const found = await shortcutFailure(error, {platform});
    assert.match(found.advice, /choose another VOICE_HOTKEY combination/);
    assert.match(found.advice, /speech service.*launch configuration/);
    assert.match(found.advice, /does not save.*login/i);
  }
});

test('shortcut advice fixes invalid configuration where the speech service is launched', async () => {
  for (const error of [
    'Use modifiers plus one letter or digit, such as ctrl+alt+j.',
    'A hotkey needs a letter or digit.',
    'Mac hotkeys require Control or Command (win), plus a letter or digit.',
    'Mac hotkeys support ANSI physical letter and digit keys.',
  ]) {
    const found = await shortcutFailure(error);
    assert.match(found.advice, /invalid.*VOICE_HOTKEY/i);
    assert.match(found.advice, /launch configuration/);
    assert.match(found.advice, /ctrl\+alt\+j/);
    assert.match(found.advice, /does not save.*login/i);
    assert.doesNotMatch(found.advice, /another app|key conflict/i);
  }
});

test('shortcut advice admits unknown registration failures instead of inventing a conflict', async () => {
  for (const error of [null, 'Unrecognized registration problem',
    'Hotkey unavailable (Windows error 5); another app may own it.',
    'Mac hotkey unavailable (macOS error -50); another app may own it.']) {
    const found = await shortcutFailure(error);
    assert.match(found.advice, /cause.*not identified/i);
    assert.match(found.advice, /service-supervisor\.jsonl/);
    assert.match(found.advice, /coding agent/);
    assert.doesNotMatch(found.advice, /another app|choose another|VOICE_HOTKEY/i);
  }
});

test('shared, disabled, unsupported and CI shortcuts explain why registration is skipped', async () => {
  for (const [state, options, reason] of [
    [{speech: 'shared'}, {platform: 'darwin'}, /managed by another program/],
    [{speech: 'own', hotkey: {enabled: false, ok: false}}, {platform: 'darwin'}, /disabled/],
    [{speech: 'own', hotkey: {enabled: true, ok: false, error: 'Unsupported'}}, {platform: 'linux'}, /supported on Mac and Windows/],
    [{speech: 'own', hotkey: {enabled: true, ok: false, error: 'No desktop'}}, {platform: 'darwin', ci: true}, /not checked with --ci/],
  ]) {
    const found = await examine(await fakeServices(state), installation({installed: true}), options);
    assert.equal(found.line(HOTKEY).status, 'SKIP', found.text); assert.match(found.line(HOTKEY).detail, reason);
    assert.equal(found.failed, 0, found.text);
  }
});

test('an older or incomplete own speech health response waits instead of claiming shortcut success', async () => {
  for (const hotkey of [null, {}, {enabled: true}, {enabled: true, ok: 'true'}]) {
    const found = await examine(await fakeServices({speech: 'own', hotkey}), installation({installed: true}), {platform: 'darwin'});
    assert.equal(found.line(HOTKEY).status, 'WAIT', found.text);
    assert.match(found.line(HOTKEY).detail, /does not report shortcut registration/);
    for (const name of VOICE) assert.equal(found.line(name).status, 'PASS');
    assert.match(found.lines.at(-1), /Waiting on the step\(s\) marked WAIT/);
  }
});

test('a dead speech service is a FAIL that names the real reason, and the two checks behind it are printed as SKIP', async () => {
  const shared = await fakeServices({speech: 'shared', healthy: false});
  const lost = await examine(shared, installation());
  assert.equal(lost.line(VOICE[0]).status, 'FAIL');
  assert.match(lost.line(VOICE[0]).detail, /shared speech service at http:\/\/127\.0\.0\.1:\d+ stopped answering/);
  assert.match(lost.text, /start that program again.*node aos\.mjs setup --voice yes/s);
  for (const name of VOICE.slice(1)) { assert.equal(lost.line(name).status, 'SKIP'); assert.match(lost.line(name).detail, /not run: "Voice service healthy" did not pass/); }
  assert.equal(lost.line(HOTKEY).status, 'SKIP'); assert.match(lost.line(HOTKEY).detail, /"Voice service healthy" did not pass/);
  assert.equal(lost.coreFailed, 0); assert.equal(lost.ok, false);
  assert.match(lost.lines.at(-1), /core system is installed and working\. 1 optional part\(s\) need attention: Voice service healthy/);

  const crashed = await fakeServices({speech: 'own', healthy: false, speechPhase: 'blocked'});
  const broken = await examine(crashed, installation({installed: true}));
  assert.match(broken.line(VOICE[0]).detail, /keeps crashing/);
  assert.match(broken.text, /--reset-recovery/);
  assert.doesNotMatch(broken.text, /waiting up to/, 'a crashed service is not waited for');

  const unmonitored = await fakeServices({speech: 'none', monitorRunsSpeech: false});
  const idle = await examine(unmonitored, installation({installed: true}));
  assert.match(idle.line(VOICE[0]).detail, /the recovery monitor is not running it/);
});

test('voice that was asked for but is not installed says so; declined voice and its shortcut are skipped', async () => {
  const services = await fakeServices({speech: 'none'});
  const missing = await examine(services, installation({installed: false}));
  assert.equal(missing.line(VOICE[0]).status, 'FAIL'); assert.equal(missing.line(VOICE[0]).detail, 'not installed');
  assert.match(missing.text, /fix: Run `node aos\.mjs setup --voice yes`\./);
  for (const name of VOICE.slice(1)) assert.equal(missing.line(name).status, 'SKIP');
  const declined = await examine(services, installation({voice: false}));
  assert.equal(declined.line('Voice').status, 'SKIP'); assert.equal(declined.failed, 0, declined.text);
  assert.equal(declined.line(HOTKEY).status, 'SKIP'); assert.match(declined.line(HOTKEY).detail, /voice was not enabled/);
});

test('the doctor waits for a voice that is still loading instead of telling the person to run it again', async () => {
  const services = await fakeServices({speech: 'own', healthy: false, speechPhase: 'starting'});
  let pauses = 0;
  const found = await examine(services, installation({installed: true}), {pause: async () => { if (++pauses === 2) await services.set({healthy: true, speechPhase: 'online'}); }});
  assert.match(found.text, /voice is still loading its models; waiting up to 6 seconds/);
  assert.equal(pauses, 2, 'it stopped waiting as soon as the service answered');
  for (const name of VOICE) assert.equal(found.line(name).status, 'PASS');

  // The monitor is asked again AFTER the sign-in checks: a voice that started failing meanwhile is
  // waited for, and one the monitor gives up on during the wait is not waited for any longer.
  const late = await fakeServices({speech: 'own', healthy: true, speechPhase: 'online'});
  let paused = 0;
  const restarted = await examine(late, installation({installed: true}), {runCommand: async () => { await late.set({healthy: false, speechPhase: 'starting'}); return {status: 0, stdout: 'OK'}; },
    pause: async () => { if (++paused === 1) await late.set({speechPhase: 'blocked'}); }});
  assert.match(restarted.text, /waiting up to 6 seconds/, 'decided on what the monitor says now, not before the sign-in checks');
  assert.equal(paused, 1, 'the wait ended when the monitor gave up');
  assert.match(restarted.line(VOICE[0]).detail, /keeps crashing/);

  // The limit is on the clock: a bridge that answers slowly cannot stretch 6 seconds into minutes.
  const slow = await fakeServices({speech: 'own', healthy: false, speechPhase: 'starting'});
  let rounds = 0;
  const bounded = await examine(slow, installation({installed: true}), {pause: async () => { rounds++; }});
  assert.equal(rounds, 2); assert.match(bounded.line(VOICE[0]).detail, /still not up after waiting 6 seconds/);
});

test('the same failure twice in a row stops saying "try again"; a pass in between starts over', async () => {
  const services = await fakeServices({speech: 'own', healthy: false, speechPhase: 'starting'}), install = installation({installed: true});
  const first = await examine(services, install);
  assert.match(first.line(VOICE[0]).detail, /still not up after waiting 6 seconds/);
  assert.match(first.text, /run `node aos\.mjs doctor` once more/);
  assert.doesNotMatch(first.text, /same failure as the last run/);
  const second = await examine(services, install);
  assert.match(second.text, /same failure as the last run \(2 in a row\), so running the doctor again will not change it/);
  assert.match(second.text, /not going to come up by waiting\. Repair the voice files/);
  assert.doesNotMatch(second.text, /once more/, 'the advice that loops is gone');
  // The monitor's momentary phase differs between runs; the failure is still recognised as the same one.
  await services.set({speechPhase: 'backoff'});
  assert.match((await examine(services, install)).text, /3 in a row/);
  await services.set({healthy: true, speechPhase: 'online'});
  assert.equal((await examine(services, install)).failed, 0);
  await services.set({healthy: false, speechPhase: 'starting'});
  assert.doesNotMatch((await examine(services, install)).text, /same failure as the last run/, 'a pass in between resets the count');
});

test('no check disappears: a step that fails or throws leaves a SKIP for every line behind it', async () => {
  const mute = await fakeServices({speech: 'shared', canSpeak: false});
  const silent = await examine(mute, installation());
  assert.equal(silent.line(VOICE[1]).status, 'FAIL'); assert.match(silent.line(VOICE[1]).detail, /status 500/);
  assert.equal(silent.line(VOICE[2]).status, 'SKIP'); assert.match(silent.line(VOICE[2]).detail, /"Text to speech" did not pass/);

  const deaf = await fakeServices({speech: 'shared', hears: 'thank you for watching'});
  assert.equal((await examine(deaf, installation())).line(VOICE[2]).status, 'FAIL');

  // A thrown error (the sign-in program cannot even be started) is a FAIL on the line it interrupted.
  const services = await fakeServices({speech: 'shared', providers: {claude: {installed: true, version: '1', command: process.execPath}, codex: {installed: true, version: '2', command: process.execPath}}});
  const thrown = await examine(services, installation(), {runCommand: async (command, args) => { if (args[0] === 'exec') throw new Error('spawn EPERM'); return {status: 0, stdout: 'OK'}; }});
  assert.equal(thrown.line('codex signed in').status, 'FAIL'); assert.match(thrown.line('codex signed in').detail, /spawn EPERM/);
  assert.equal(thrown.coreFailed, 0, 'one signed-in provider is enough');

  const nobody = await examine(services, installation(), {runCommand: async () => ({status: 1, stdout: ''})});
  assert.equal(nobody.line('A provider that is signed in').status, 'FAIL'); assert.ok(nobody.coreFailed >= 1);
  assert.match(nobody.lines.at(-1), /including core parts \(A provider that is signed in\)/);
});

test('every run prints every line, even with the bridge down or no vault configured', async () => {
  const services = await fakeServices({bridgeOnline: false});
  const install = installation(); fs.rmSync(install.at.vaultFile);
  const found = await examine(services, install, {full: true});
  const expected = ['Node.js 22 or newer', 'Vault configured', 'Vault has the daily-note schema', 'Obsidian plugin files installed', 'Plugin switched on in Obsidian',
    TERMINAL, 'Python helper for conversations inside Obsidian', 'Recovery monitor running', `Bridge answering on ${services.ports.bridge}`, `Jarvis HUD answering on ${services.ports.jarvis}`, 'claude CLI', 'codex CLI', VOICE[0], HOTKEY, ...VOICE.slice(1), 'Jev fast voice routing', 'A real workflow end to end'];
  assert.deepEqual(found.results.map(item => item.name), expected);
  for (const name of ['Vault has the daily-note schema', 'claude CLI', ...VOICE, HOTKEY, 'A real workflow end to end']) { assert.equal(found.line(name).status, 'SKIP', name); assert.match(found.line(name).detail, /not (run|checked)/); }
  assert.equal(found.line(TERMINAL).status, 'SKIP'); assert.match(found.line(TERMINAL).detail, /no vault configured/);
  const usual = await examine(await fakeServices({speech: 'shared'}), installation());
  assert.match(usual.line('A real workflow end to end').detail, /doctor --full/);
  const ci = await examine(await fakeServices({speech: 'shared', providers: {claude: {installed: true, version: '1', command: 'x'}}}), installation(), {ci: true, full: true});
  assert.equal(ci.line('claude signed in').status, 'SKIP'); assert.equal(ci.line('A real workflow end to end').status, 'SKIP'); assert.equal(ci.failed, 0, ci.text);
});

test('the Terminal plugin line reports every state from the vault files and never throws', () => {
  const vault = installation().vault, folder = path.join(vault, '.obsidian', 'plugins', 'terminal'), enabledFile = path.join(vault, '.obsidian', 'community-plugins.json');
  const set = ({manifest, enabled = '["agentic-os-v2","terminal"]'}) => {
    fs.rmSync(folder, {recursive: true, force: true});
    if (manifest !== undefined) { fs.mkdirSync(folder, {recursive: true}); fs.writeFileSync(path.join(folder, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest)); }
    if (enabled === null) fs.rmSync(enabledFile, {force: true}); else fs.writeFileSync(enabledFile, enabled);
    return terminalPluginCheck(vault);
  };
  const cases = [
    [{}, 'SKIP', /not installed \(optional: .*Jarvis/],
    [{manifest: {id: 'terminal', version: '3.27.2'}}, 'PASS', /^3\.27\.2$/],
    [{manifest: {id: 'terminal', version: '3.27.1'}}, 'PASS', /^3\.27\.1$/],
    [{manifest: {id: 'terminal', version: '3.28.0'}}, 'PASS', /3\.28\.0, newer than the tested 3\.27\.1 and 3\.27\.2; it should work/],
    [{manifest: {id: 'terminal', version: '3.27.2'}, enabled: '["agentic-os-v2"]'}, 'SKIP', /switched off/],
    [{manifest: {id: 'terminal', version: '3.27.2'}, enabled: null}, 'SKIP', /switched off/],
    [{manifest: {id: 'terminal', version: '4.0.0'}}, 'FAIL', /version 4\.0\.0/],
    [{manifest: {id: 'terminal', version: '3.26.0'}}, 'FAIL', /version 3\.26\.0/],
    [{manifest: {id: 'terminal'}}, 'FAIL', /no version/],
    [{manifest: '{not json'}, 'FAIL', /could not be read/],
    [{manifest: {id: 'someone-else', version: '1.0.0'}}, 'SKIP', /different plugin/],
    [{manifest: {id: 'terminal', version: '3.27.2'}, enabled: '{not json'}, 'SKIP', /could not read the enabled-plugins list/],
  ];
  for (const [state, status, detail] of cases) { const check = set(state); assert.equal(check.status, status, JSON.stringify(state)); assert.match(check.detail, detail, JSON.stringify(state)); if (status === 'FAIL') assert.match(check.fix, /Jarvis at http:\/\/127\.0\.0\.1:3217/); }
  assert.match(set({manifest: {id: 'terminal', version: '3.26.0'}}).fix, /too old/);
  assert.equal(terminalPluginCheck(path.join(vault, 'missing')).status, 'SKIP');
  assert.equal(terminalPluginCheck(undefined).status, 'SKIP');
});

test('a Terminal problem is an optional line and never adds a core failure', async () => {
  const services = await fakeServices({speech: 'shared'});
  const baseline = await examine(services, installation());
  const install = installation(), folder = path.join(install.vault, '.obsidian', 'plugins', 'terminal');
  fs.mkdirSync(folder, {recursive: true}); fs.writeFileSync(path.join(folder, 'manifest.json'), '{not json');
  fs.writeFileSync(path.join(install.vault, '.obsidian', 'community-plugins.json'), '["agentic-os-v2","terminal"]');
  const damaged = await examine(services, install);
  assert.equal(damaged.line(TERMINAL).status, 'FAIL'); assert.equal(damaged.line(TERMINAL).optional, true);
  assert.equal(damaged.coreFailed, baseline.coreFailed);
  const noVault = installation(); fs.rmSync(noVault.at.vaultFile);
  const without = await examine(services, noVault);
  assert.equal(without.line('Vault configured').status, 'FAIL', 'the missing vault stays the core failure it was');
  assert.equal(without.line(TERMINAL).status, 'SKIP'); assert.equal(without.results.filter(item => item.name === TERMINAL && item.status === 'FAIL').length, 0);
});

test('the plugin line is only PASS once Obsidian has opened the vault or the cockpit is connected', async () => {
  const services = await fakeServices({speech: 'shared'});
  const fresh = await examine(services, installation({opened: false}), {phase: 'install'});
  assert.equal(fresh.line('Plugin switched on in Obsidian').status, 'WAIT');
  assert.match(fresh.line('Plugin switched on in Obsidian').detail, /Obsidian has not opened it yet/);
  assert.match(fresh.lines.at(-1), /Waiting on the step\(s\) marked WAIT/);
  assert.equal((await examine(services, installation({opened: false}))).line('Plugin switched on in Obsidian').status, 'FAIL', 'after the install phase it is a FAIL with the clicks to make');
  assert.equal((await examine(services, installation({opened: true}), {phase: 'install'})).line('Plugin switched on in Obsidian').status, 'PASS');
  const connected = await fakeServices({speech: 'shared', surfaces: [{kind: 'native'}]});
  assert.match((await examine(connected, installation({opened: false}))).line('Plugin switched on in Obsidian').detail, /connected right now/);
});

test('why the voice line failed is decided from the bridge, the monitor and the disk', () => {
  const ask = values => voiceProblem({probe: {status: 200, data: {ok: false}, error: ''}, speechUrl: 'http://127.0.0.1:3220', own: true, installed: true, phase: 'online', ...values});
  assert.match(voiceProblem({probe: {status: 0, data: null, error: 'ECONNRESET'}, speechUrl: 'x', own: true, installed: true, phase: 'online'}).detail, /the bridge did not answer the voice check \(ECONNRESET\)/);
  assert.match(voiceProblem({probe: {status: 503, data: null, error: ''}, speechUrl: 'x', own: true}).detail, /HTTP 503/);
  assert.match(ask({own: false, speechUrl: 'http://127.0.0.1:3108'}).detail, /shared speech service at http:\/\/127\.0\.0\.1:3108/);
  assert.equal(ask({installed: false}).detail, 'not installed');
  assert.match(ask({phase: ''}).detail, /monitor is not running it/);
  assert.match(ask({phase: 'blocked'}).detail, /keeps crashing/);
  assert.match(ask({phase: 'backoff', waitedSeconds: 90}).detail, /still not up after waiting 90 seconds/);
  assert.match(ask({}).detail, /running but reports that it is not ready/);
  for (const phase of ['', 'blocked', 'backoff', 'online']) assert.doesNotMatch(JSON.stringify(ask({phase}).fix.repeated || ''), /doctor` (again|once more)/);
});

test('setup and start decide about voice the same way: a healthy shared service means nothing is downloaded or waited for', async () => {
  const at = layout(path.join(scratch, 'plan', 'obsidian-v2'));
  const healthyOn = port => async url => url === `http://127.0.0.1:${port}/health` ? {ok: true, stt: {ok: true}} : null;
  assert.deepEqual(await speechPlan(at, {get: healthyOn(3108), env: {}, installed: () => true}), {url: 'http://127.0.0.1:3108', own: false, shared: true, healthy: true});
  assert.deepEqual(await speechPlan(at, {get: healthyOn(PORTS.speech), env: {}, installed: () => true}), {url: `http://127.0.0.1:${PORTS.speech}`, own: true, shared: false, healthy: true});
  assert.deepEqual(await speechPlan(at, {get: async () => null, env: {}, installed: () => true}), {url: `http://127.0.0.1:${PORTS.speech}`, own: true, shared: false, healthy: false});
  assert.deepEqual(await speechPlan(at, {get: async () => null, env: {}, installed: () => false}), {url: null, own: false, shared: false, healthy: false});
  assert.deepEqual(await speechPlan(at, {get: async () => ({ok: true, stt: {ok: false}}), env: {}, installed: () => false}), {url: null, own: false, shared: false, healthy: false}, 'a service that cannot listen is not borrowed');
  // An address from the environment is honoured as before (the bridge does the same), but whether it answers is known.
  const configured = {AOS_V2_SPEECH_URL: 'http://127.0.0.1:3108'};
  assert.deepEqual(await speechPlan(at, {get: healthyOn(3108), env: configured, installed: () => true}), {url: 'http://127.0.0.1:3108', own: false, shared: true, healthy: true});
  assert.deepEqual(await speechPlan(at, {get: async () => null, env: configured, installed: () => true}), {url: 'http://127.0.0.1:3108', own: false, shared: true, healthy: false});

  const said = [], downloads = [];
  const prepare = (values, plan) => prepareVoice(at, {wantVoice: true, log: line => said.push(line), plan: async () => plan, installVoice: async () => downloads.push('voice'), installed: () => false, ...values});
  assert.equal(await prepare({}, {url: 'http://127.0.0.1:3108', own: false, shared: true, healthy: true}), 'shared');
  assert.deepEqual(downloads, [], 'nothing is downloaded while another program\'s service is shared');
  assert.match(said.join('\n'), /already running on this computer \(http:\/\/127\.0\.0\.1:3108\) and will be shared.*nothing to download.*`node aos\.mjs stop`, then `node aos\.mjs setup --voice yes`/s);
  assert.equal(await prepare({}, {url: null, own: false, shared: false, healthy: false}), 'installed'); assert.deepEqual(downloads, ['voice']);
  assert.match(said.at(-1), /about 1\.3 GB/);
  // A stale AOS_V2_SPEECH_URL names a service that is not there: that must not cost the member their voice.
  assert.equal(await prepare({}, {url: 'http://127.0.0.1:3108', own: false, shared: true, healthy: false}), 'installed'); assert.deepEqual(downloads, ['voice', 'voice']);
  assert.match(said.join('\n'), /AOS_V2_SPEECH_URL setting points at http:\/\/127\.0\.0\.1:3108, which is not answering.*remove the setting/);
  // The same warning when the voice files are already there: repairing them cannot cure a dead address.
  said.length = 0;
  assert.equal(await prepare({installed: () => true, explicit: true}, {url: 'http://127.0.0.1:3108', own: false, shared: true, healthy: false}), 'repaired'); downloads.pop();
  assert.match(said.join('\n'), /AOS_V2_SPEECH_URL setting points at/);
  said.length = 0;
  assert.equal(await prepare({installed: () => true}, {url: 'http://127.0.0.1:3108', own: false, shared: true, healthy: false}), 'present');
  assert.match(said.join('\n'), /AOS_V2_SPEECH_URL setting points at/);
  // Installed already: left alone on an ordinary run, checked and repaired when --voice yes was typed.
  assert.equal(await prepare({installed: () => true}, {url: null, own: true, shared: false, healthy: false}), 'present'); assert.equal(downloads.length, 2);
  assert.equal(await prepare({installed: () => true, explicit: true}, {}), 'repaired'); assert.equal(downloads.length, 3);
  assert.match(said.at(-1), /already installed; checking the files/);
  assert.equal(await prepare({wantVoice: false, explicit: true}, {}), 'off'); assert.equal(downloads.length, 3);

  // An update installs with the SAVED voice choice; it never claims the person typed --voice yes,
  // which would re-run the voice installer (network, minutes) on every update.
  const updating = installation({installed: true}), calls = [];
  fs.writeFileSync(path.join(updating.at.runtime, 'aos-setup.json'), JSON.stringify({vault: updating.vault, voice: true}));
  await update({root: updating.root, log: () => {}, check: () => ({updateAllowed: true}), get: async () => null, pull: () => calls.push('pull'), install: async options => { calls.push(options); return {ok: true}; }});
  assert.equal(calls[0], 'pull'); assert.equal('voice' in calls[1], false); assert.equal(calls[1].rebuild, true); assert.equal(calls[1].vault, updating.vault);

  assert.deepEqual(watchedServices({services: [{id: 'bridge'}, {id: 'jarvis'}]}), ['bridge', 'jarvis'], 'a borrowed voice is not waited for');
  assert.deepEqual(watchedServices({services: [{id: 'bridge'}, {id: 'jarvis'}, {id: 'speech'}, {id: 'preview'}]}), ['bridge', 'jarvis', 'speech']);
  assert.deepEqual(watchedServices(null), ['bridge', 'jarvis']);
});

test('local requests: one connection each, local addresses only, binary both ways, a real timeout; a program is run without freezing this one', async () => {
  const services = await fakeServices({speech: 'shared', keepAliveMs: 150});
  const local = port => `http://127.0.0.1:${port}`;
  // The doctor's order: monitor, bridge, HUD; then frozen; then the bridge again.
  for (const port of [services.ports.supervisor, services.ports.bridge, services.ports.jarvis]) assert.equal((await fetchJson(`${local(port)}/services`)).status, 200);
  freeze(2500);
  assert.equal((await fetchJson(`${local(services.ports.bridge)}/voice/health`)).data.ok, true);

  const spoken = await request(`${services.sharedUrl}/speak?text=hello`);
  assert.equal(spoken.body.subarray(0, 4).toString(), 'RIFF'); assert.ok(spoken.body.length > 5000);
  assert.equal(JSON.parse((await request(`${services.sharedUrl}/stt`, {method: 'POST', body: spoken.body})).body).text, 'Voice check, one two three.');
  await assert.rejects(request('http://example.com/'), /Only local services/);
  await assert.rejects(request('https://127.0.0.1:1/'), /Only local services/);
  await services.set({bridgeOnline: false});
  await assert.rejects(fetchJson(`${local(services.ports.bridge)}/services`), error => ['ECONNRESET', 'EPIPE'].includes(error.code) || /hang up/.test(error.message));

  let ticks = 0; const timer = setInterval(() => ticks++, 20);
  const result = await run(process.execPath, ['-e', 'process.stdin.on("data", d => process.stdout.write("got:" + d)); setTimeout(() => {}, 400)'], {input: 'hello'});
  clearInterval(timer);
  assert.equal(result.status, 0); assert.equal(result.stdout, 'got:hello'); assert.ok(ticks >= 5, `timers kept running while the program ran (${ticks})`);
  const slow = await run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {timeoutMs: 300});
  assert.equal(slow.timedOut, true); assert.notEqual(slow.status, 0);
  // A program that ignores the polite stop, while its child keeps the output pipe open: still answered, within the grace period.
  const began = Date.now();
  const stubborn = await run(process.execPath, ['-e', `process.on('SIGTERM', () => {}); require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], {stdio: 'inherit'}); setTimeout(() => {}, 8000)`], {timeoutMs: 300, graceMs: 400});
  assert.equal(stubborn.timedOut, true); assert.ok(Date.now() - began < 4000, `answered in ${Date.now() - began} ms`);
  assert.ok((await run(path.join(scratch, 'no-such-program'), [])).error, 'a program that cannot be started is reported, not thrown');
});
