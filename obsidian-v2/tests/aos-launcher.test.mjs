import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseLsofPids, parsePsLine, parseWindowsProcess, samePath, which, listener, openUrl} from '../scripts/aos/platform.mjs';
import {layout, desiredServices, mergePrior, bridgeIsOurs, hudIsOurs, speechIsOurs, loginItemBlocks, stop, PORTS} from '../scripts/aos/services.mjs';
import {launchAgentPlist, scheduledTaskScript, autostartOwner, taskOwner, plistArguments, launchctlArguments, AGENT_LABEL, TASK_NAME} from '../scripts/aos/autostart.mjs';
import {preflight} from '../scripts/aos/setup.mjs';
import {scaffoldVault, pluginEnabled} from '../scripts/aos/vault.mjs';
import {saveJevKey, hasJevKey, collectJevKey, JEV_DEFAULTS} from '../scripts/aos/jev-key.mjs';
import {parsePythonVersion, pythonSupported, findPython} from '../scripts/aos/speech.mjs';
import {parseArgs} from '../scripts/aos.mjs';
import {supervisorConfig} from '../runner/service-supervisor.mjs';

// Every scratch folder is removed when the file's tests finish.
const scratched = [];
after(() => { for (const dir of scratched) fs.rmSync(dir, {recursive: true, force: true}); });
const scratch = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-test-')); scratched.push(dir); return dir; };
const FAKE_KEY = 'sk-or-' + 'test0000'.repeat(4);
const TOKEN = 'a'.repeat(64);
const BOM = String.fromCharCode(0xFEFF);

test('process listings from both operating systems are parsed, and junk is refused', () => {
  assert.deepEqual(parseLsofPids('812\n812\n  977 \nCOMMAND\n'), [812, 977]);
  assert.deepEqual(parsePsLine('Mon Sep  1 09:05:02 2026 /opt/homebrew/bin/node /Users/a/aos/obsidian-v2/runner/bridge.mjs\n'),
    {startedAt: 'Mon Sep 1 09:05:02 2026', commandLine: '/opt/homebrew/bin/node /Users/a/aos/obsidian-v2/runner/bridge.mjs', name: 'node'});
  assert.equal(parsePsLine('garbage'), null);
  assert.deepEqual(parseWindowsProcess(BOM + '{"pid":42,"name":"node.exe","commandLine":"node x","startedAt":"2026-09-21T18:33:46Z"}'),
    {pid: 42, name: 'node.exe', commandLine: 'node x', startedAt: '2026-09-21T18:33:46Z'});
  assert.equal(parseWindowsProcess('{"pid":"42"}'), null);
  assert.equal(parseWindowsProcess(''), null);
  assert.equal(samePath('/a/b/../c', '/a/c'), true); assert.equal(samePath('', ''), false); assert.equal(samePath(null, '/a'), false);
});

test('a listener is identified per platform, and two listeners on one port are never resolved by position', () => {
  const calls = [];
  const mac = (command, args) => { calls.push([command, ...args]); return command === 'lsof' ? {status: 0, stdout: '501\n'} : {status: 0, stdout: 'Mon Sep 21 13:35:02 2026 next-server (v15.3.2)\n'}; };
  assert.deepEqual(listener(3217, {run: mac, platform: 'darwin'}), {pid: 501, startedAt: 'Mon Sep 21 13:35:02 2026', commandLine: 'next-server (v15.3.2)', name: 'next-server'});
  assert.deepEqual(calls[0], ['lsof', '-nP', '-iTCP@127.0.0.1:3217', '-sTCP:LISTEN', '-t']);
  assert.deepEqual(listener(3217, {run: () => ({status: 0, stdout: '501\n502\n'}), platform: 'linux'}), {ambiguous: true});
  assert.equal(listener(3217, {run: () => ({status: 1, stdout: ''}), platform: 'darwin'}), null);
  assert.deepEqual(listener(3219, {run: () => ({status: 0, stdout: '{"ambiguous":true}'}), platform: 'win32'}), {ambiguous: true});
  assert.throws(() => listener(0), /Invalid port/);
});

function installation() {
  const root = scratch(), at = layout(root);
  fs.mkdirSync(at.runtime, {recursive: true}); fs.mkdirSync(at.jarvis, {recursive: true}); fs.mkdirSync(path.dirname(at.speechScript), {recursive: true});
  fs.writeFileSync(at.speechScript, ''); fs.writeFileSync(at.auth, JSON.stringify({token: TOKEN}));
  fs.writeFileSync(at.vaultFile, JSON.stringify({vault: path.join(root, 'vault')}));
  return at;
}
// A bridge that behaves like ours: 401 without the right token, anything else with it.
const bridgeLike = accepted => async (url, options) => {
  if (url.endsWith('/shutdown')) return {ok: true, status: 200, data: {ok: true}};
  const supplied = options.headers['X-V2-Token'];
  return supplied === accepted ? {ok: false, status: 400, data: {error: 'Task not found'}} : {ok: false, status: 401, data: {error: 'Bridge authentication required'}};
};

test('a service proves itself over its own port: the token for the bridge, a self-reported process id that must match the listener for the rest', async () => {
  const at = installation();
  assert.equal(await bridgeIsOurs(at, {post: bridgeLike(TOKEN)}), true);
  assert.equal(await bridgeIsOurs(at, {post: bridgeLike('b'.repeat(64))}), false, 'another installation\'s bridge refuses our token');
  assert.equal(await bridgeIsOurs(at, {post: async () => ({ok: false, status: 404, data: null})}), false, 'a server that does not ask for a token is not a bridge');
  assert.equal(await bridgeIsOurs(at, {post: async () => ({ok: true, status: 200, data: {}})}), false);
  assert.equal(await bridgeIsOurs(at, {post: async () => { throw new Error('offline'); }}), false);
  const bare = installation(); fs.writeFileSync(bare.auth, '{}');
  assert.equal(await bridgeIsOurs(bare, {post: bridgeLike(undefined)}), false, 'no token on disk, no proof');

  const listening = pid => () => ({pid, name: 'whatever', commandLine: 'anything at all', startedAt: 'T1'});
  const hud = service => async () => service;
  assert.deepEqual(await hudIsOurs(at, {find: listening(7), get: hud({kind: 'jarvis-v2', pid: 7, root: at.jarvis})}), listening(7)());
  assert.equal(await hudIsOurs(at, {find: listening(7), get: hud({kind: 'jarvis-v2', pid: 8, root: at.jarvis})}), null, 'it may only vouch for the process that is listening');
  assert.equal(await hudIsOurs(at, {find: listening(7), get: hud({kind: 'jarvis-v2', pid: 7, root: path.resolve('/another/checkout/jarvis-v2')})}), null);
  assert.equal(await hudIsOurs(at, {find: listening(7), get: hud({kind: 'something-else', pid: 7, root: at.jarvis})}), null);
  assert.equal(await hudIsOurs(at, {find: listening(7), get: hud(null)}), null, 'a server that says nothing about itself is not ours');
  assert.equal(await hudIsOurs(at, {find: () => ({ambiguous: true}), get: hud({kind: 'jarvis-v2', pid: 7, root: at.jarvis})}), null);
  assert.equal(await hudIsOurs(at, {find: () => null, get: hud({kind: 'jarvis-v2', pid: 7, root: at.jarvis})}), null);

  const health = service => async () => ({ok: true, service});
  assert.deepEqual(await speechIsOurs(at, {find: listening(9), get: health({kind: 'aos-v2-speech', pid: 9, script: at.speechScript})}), listening(9)());
  assert.equal(await speechIsOurs(at, {find: listening(9), get: health({kind: 'aos-v2-speech', pid: 9, script: path.resolve('/another/runner/speech.py')})}), null);
  assert.equal(await speechIsOurs(at, {find: listening(9), get: health(undefined)}), null, 'an older or foreign speech service is borrowed, never stopped');
});

test('the service list matches the PowerShell launcher, is accepted by the monitor, and keeps earlier optional services', () => {
  const at = layout(path.resolve('/x/aos/obsidian-v2'));
  const node = path.resolve('/usr/bin/node');
  const base = desiredServices(at, {node, vault: '/v', speechUrl: 'http://127.0.0.1:3220', jarvisBuilt: true, ownSpeech: true});
  assert.deepEqual(base.map(service => [service.id, service.port]), [['bridge', 3219], ['jarvis', 3217], ['speech', 3220]]);
  assert.deepEqual(base[0].env, {AOS_V2_SPEECH_URL: 'http://127.0.0.1:3220', AOS_V2_VAULT: '/v'});
  assert.deepEqual(base[1].args.slice(1), ['start', '--hostname', '127.0.0.1', '--port', '3217']);
  assert.equal(base[1].env, undefined, 'Jarvis learns the vault from the bridge, exactly as today');
  assert.deepEqual(base[2].args, ['-u', at.speechScript, '--assets', at.speechAssets]);
  assert.doesNotThrow(() => supervisorConfig({runtimeDir: at.runtime, lockPort: PORTS.supervisor, services: base}));
  assert.deepEqual(desiredServices(at, {node}).map(service => service.id), ['bridge']);
  const merged = mergePrior(desiredServices(at, {node}), {runtimeDir: at.runtime, services: [...base, {id: 'other', port: 1}, {id: 'preview', port: 3218}]}, at.runtime);
  assert.deepEqual(merged.map(service => service.id), ['bridge', 'jarvis', 'speech'], 'the development preview is not something this launcher starts, even from an older configuration');
  assert.throws(() => mergePrior([], {runtimeDir: path.resolve('/elsewhere/.runtime'), services: []}, at.runtime), /another installation/);
});

function stopWith(at, {state = {vault: path.join(at.root, 'vault')}, work = {tasks: []}, hudService = {kind: 'jarvis-v2', pid: 2, root: at.jarvis}, hudVault = path.join(at.root, 'vault'),
  speechService, listeners = {[PORTS.jarvis]: 2}, post = bridgeLike(TOKEN), inspect} = {}) {
  const killed = [], posted = [];
  const info = pid => ({pid, name: 'x', commandLine: 'x', startedAt: 'T1'});
  const run = stop({root: at.root, log: () => {}, kill: pid => killed.push(pid), find: port => listeners[port] === 'ambiguous' ? {ambiguous: true} : listeners[port] ? info(listeners[port]) : null,
    inspect: inspect || (pid => info(pid)),
    get: async url => url.endsWith(':3219/state') ? state : url.endsWith('/work') ? work : url.endsWith('/api/service') ? hudService : url.endsWith('/api/state') ? {vault_root: hudVault} : url.endsWith(':3220/health') ? {ok: true, service: speechService} : null,
    post: async (url, options) => { if (url.endsWith('/shutdown')) posted.push(options.headers['X-V2-Token']); return post(url, options); }});
  return {run, killed, posted};
}

test('stop fails closed: nothing is stopped unless the bridge, the vault, the tasks and every process check out', async () => {
  const cases = [
    [() => ({state: null}), /Bridge is unavailable/],
    [() => ({state: {vault: '/someone/else'}}), /another vault/],
    [() => ({post: bridgeLike('c'.repeat(64))}), /does not accept this installation's token/],
    [() => ({work: {tasks: [{state: 'ready', pid: null}]}}), /Stop active tasks/],
    [() => ({work: {tasks: [{state: 'stopped', pid: 77}]}}), /Stop active tasks/],
    [() => ({work: null}), /Stop active tasks/],
    [() => ({hudService: null}), /Unexpected process on 3217/],
    [at => ({hudService: {kind: 'jarvis-v2', pid: 99, root: at.jarvis}}), /Unexpected process on 3217/],
    [() => ({listeners: {[PORTS.jarvis]: 'ambiguous'}}), /Unexpected process on 3217/],
    [() => ({hudVault: '/someone/else'}), /Jarvis belongs to another vault/],
  ];
  for (const [options, message] of cases) {
    const at = installation(), attempt = stopWith(at, options(at));
    await assert.rejects(attempt.run, message);
    assert.deepEqual(attempt.killed, []); assert.deepEqual(attempt.posted, [], 'the bridge was not asked to shut down');
  }
  const at = installation();
  const refused = stopWith(at, {post: async (url, options) => url.endsWith('/shutdown') ? {ok: false, status: 409, data: {error: 'Stop active terminal tasks and voice requests first.'}} : bridgeLike(TOKEN)(url, options)});
  await assert.rejects(refused.run, /Stop active terminal tasks/);
  assert.deepEqual(refused.killed, [], 'a bridge that refuses to shut down leaves the HUD running');
});

test('stop shuts the bridge down through its own endpoint, stops only proven processes, and leaves borrowed speech alone', async () => {
  const at = installation();
  const borrowed = stopWith(at, {listeners: {[PORTS.jarvis]: 2, [PORTS.speech]: 3}, speechService: {kind: 'aos-v2-speech', pid: 3, script: path.resolve('/another/install/runner/speech.py')}});
  assert.deepEqual((await borrowed.run).stopped, ['bridge', 'jarvis']);
  assert.deepEqual(borrowed.killed, [2]); assert.deepEqual(borrowed.posted, [TOKEN]);
  const own = stopWith(at, {listeners: {[PORTS.jarvis]: 2, [PORTS.speech]: 3}, speechService: {kind: 'aos-v2-speech', pid: 3, script: at.speechScript}});
  assert.deepEqual((await own.run).stopped, ['bridge', 'jarvis', 'speech']); assert.deepEqual(own.killed, [2, 3]);
  const noHud = stopWith(at, {listeners: {}});
  assert.deepEqual((await noHud.run).stopped, ['bridge']); assert.deepEqual(noHud.killed, []);
  const recycled = stopWith(at, {inspect: pid => ({pid, name: 'x', commandLine: 'x', startedAt: 'T2'})});
  await recycled.run; assert.deepEqual(recycled.killed, [], 'a process id that now belongs to a different process is left alone');
});

test('setup changes nothing when another installation owns the ports or the vault', async () => {
  const at = installation(), vault = path.join(scratch(), 'vault');
  const nothing = {get: async () => null, find: () => null};
  await assert.rejects(preflight(at, vault, {get: async () => ({kind: 'agentic-os-service-supervisor', runtimeDir: path.resolve('/elsewhere/.runtime')}), find: () => null}), /Another installation .* port 3221.*Nothing was changed/);
  await assert.rejects(preflight(at, vault, {get: async () => ({hello: 'world'}), find: () => null}), /port 3221/);
  await assert.rejects(preflight(at, vault, {get: async () => null, find: port => port === PORTS.supervisor ? {pid: 9} : null}), /Another program is using port 3221/);
  const ourMonitor = {kind: 'agentic-os-service-supervisor', runtimeDir: at.runtime};
  const withMonitor = extra => async url => url.endsWith(':3221/status') ? ourMonitor : extra?.(url) ?? null;
  await assert.rejects(preflight(at, vault, {get: withMonitor(), find: port => port === PORTS.bridge ? {pid: 9} : null, post: bridgeLike('d'.repeat(64))}), /using port 3219/, 'our monitor running excuses nobody');
  await assert.rejects(preflight(at, vault, {get: withMonitor(), find: port => port === PORTS.jarvis ? {pid: 9} : null, post: bridgeLike(TOKEN)}), /using port 3217/);
  await assert.doesNotReject(preflight(at, vault, {get: withMonitor(url => url.endsWith('/api/service') ? {kind: 'jarvis-v2', pid: 9, root: at.jarvis} : null), find: port => [PORTS.bridge, PORTS.jarvis].includes(port) ? {pid: 9} : null, post: bridgeLike(TOKEN)}));
  await assert.doesNotReject(preflight(at, vault, nothing));
  const marker = path.join(vault, '.obsidian', 'plugins', 'agentic-os-v2');
  fs.mkdirSync(marker, {recursive: true});
  fs.writeFileSync(path.join(marker, 'terminal-runtime.json'), JSON.stringify({runtimeDir: path.resolve('/first/install/obsidian-v2/.runtime')}));
  await assert.rejects(preflight(at, vault, nothing), /already connected to another installation .*--adopt/);
  await assert.doesNotReject(preflight(at, vault, {...nothing, adopt: true}));
  fs.writeFileSync(path.join(marker, 'terminal-runtime.json'), JSON.stringify({runtimeDir: at.runtime}));
  await assert.doesNotReject(preflight(at, vault, nothing));
});

test('a login item is ours only when it parses to exactly what this launcher registers', () => {
  const plist = launchAgentPlist({node: '/opt/homebrew/bin/node', supervisor: '/Users/a&b/aos/runner/service-supervisor.mjs', config: '/Users/a&b/aos/.runtime/service-recovery.json', cwd: '/Users/a&b/aos', pathEnv: '/opt/homebrew/bin:/usr/bin', log: '/tmp/x.log'});
  assert.match(plist, new RegExp(`<string>${AGENT_LABEL}</string>`));
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/); assert.match(plist, /<key>AbandonProcessGroup<\/key><true\/>/);
  assert.match(plist, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
  assert.deepEqual(plistArguments(plist), ['/opt/homebrew/bin/node', '/Users/a&b/aos/runner/service-supervisor.mjs', '--config', '/Users/a&b/aos/.runtime/service-recovery.json'], 'what we write is what we read back');
  assert.equal(plistArguments('<plist/>'), null);
  assert.deepEqual(launchctlArguments('gui/501/x = {\n\tstate = running\n\targuments = {\n\t\t/opt/node\n\t\t/x/runner/service-supervisor.mjs\n\t\t--config\n\t\t/x/.runtime/service-recovery.json\n\t}\n\tenvironment = {\n\t\tPATH => /usr/bin\n\t}\n}\n'),
    ['/opt/node', '/x/runner/service-supervisor.mjs', '--config', '/x/.runtime/service-recovery.json']);
  assert.equal(launchctlArguments('state = running'), null);

  const at = layout(path.resolve('/x/aos/obsidian-v2'));
  const wrapper = path.join(at.root, 'scripts', 'run-recovery.ps1'), ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const registered = (file = wrapper, config = at.config) => `-NoProfile -NonInteractive -WindowStyle Hidden -File "${file}" -NodeExecutable "C:\\n\\node.exe" -ConfigFile "${config}"`;
  const script = scheduledTaskScript({node: 'C:\\n\\node.exe', config: "C:\\Users\\O'Neil\\aos\\.runtime\\service-recovery.json", wrapper, cwd: at.root});
  assert.match(script, /O''Neil/); assert.ok(script.includes(`-TaskName '${TASK_NAME}'`));
  const task = actions => JSON.stringify({exists: true, actions});
  assert.equal(taskOwner('{"exists":false}', at), null);
  assert.equal(taskOwner(task([{execute: ps, arguments: registered()}]), at), 'ours');
  assert.equal(taskOwner(task([{execute: ps, arguments: registered('D:\\other\\scripts\\run-recovery.ps1')}]), at), 'other');
  assert.equal(taskOwner(task([{execute: ps, arguments: registered(wrapper, 'D:\\other\\.runtime\\service-recovery.json')}]), at), 'other');
  assert.equal(taskOwner(task([{execute: ps, arguments: `-File other.ps1 "${wrapper}"`}]), at), 'other', 'our wrapper as an argument of another script');
  assert.equal(taskOwner(task([{execute: ps, arguments: registered() + ' ; evil'}]), at), 'other');
  assert.equal(taskOwner(task([{execute: 'C:\\tools\\backup.exe', arguments: ''}]), at), 'other', 'a same-named task with no arguments is somebody else\'s, not absent');
  assert.equal(taskOwner(task([{execute: 'C:\\x\\evil.exe', arguments: registered()}]), at), 'other');
  assert.equal(taskOwner(task([]), at), 'other');
  assert.equal(taskOwner(task([{execute: ps, arguments: registered()}, {execute: ps, arguments: 'extra'}]), at), 'other');
  for (const unanswered of ['', 'not json', '{"error":true}', '{"exists":false,"error":true}', '{}']) assert.equal(taskOwner(unanswered, at), 'other', `silence or an error is never "absent": ${unanswered}`);
  assert.equal(autostartOwner(at, {platform: 'win32', run: () => ({status: 1, stdout: '{"exists":false}'})}), 'other');
  assert.equal(autostartOwner(at, {platform: 'win32', run: () => ({status: 0, stdout: '{"exists":false}'})}), null);

  const file = list => `<key>ProgramArguments</key><array>${list.map(item => `<string>${item}</string>`).join('')}</array>`;
  const job = list => `x = {\n\targuments = {\n${list.map(item => '\t\t' + item).join('\n')}\n\t}\n\tenvironment = {\n\t\tNOTE => ${at.supervisor}\n\t}\n}`;
  const mine = ['/opt/homebrew/bin/node', at.supervisor, '--config', at.config], theirs = ['/opt/homebrew/bin/node', '/other/runner/service-supervisor.mjs', '--config', '/other/.runtime/service-recovery.json'];
  const missing = {status: 113, stdout: '', stderr: 'Could not find service "x" in domain for user gui: 501'};
  const agent = (onDisk, loaded) => ({platform: 'darwin', home: '/Users/a', exists: () => onDisk !== null, read: () => onDisk, run: () => loaded === null ? missing : typeof loaded === 'object' ? loaded : {status: 0, stdout: loaded}});
  assert.equal(autostartOwner(at, agent(null, null)), null);
  assert.equal(autostartOwner(at, agent(file(mine), null)), 'ours');
  assert.equal(autostartOwner(at, agent(file(theirs), null)), 'other');
  assert.equal(autostartOwner(at, agent(null, job(theirs))), 'other', 'a loaded job whose file is gone still belongs to someone; our path in its environment proves nothing');
  assert.equal(autostartOwner(at, agent(file(mine), job(theirs))), 'other', 'our file on disk does not make a foreign loaded job ours');
  assert.equal(autostartOwner(at, agent(file(mine), 'state = running')), 'other', 'a loaded job that cannot be read is not ours');
  assert.equal(autostartOwner(at, agent(null, job(mine))), 'ours');
  assert.equal(autostartOwner(at, agent(file(['/opt/node', '/x/other.js', at.supervisor, at.config]), null)), 'other');
  assert.equal(autostartOwner(at, agent(null, job(['/bin/echo', at.supervisor, '--config', at.config]))), 'other', 'our paths after some other program are not our monitor');
  assert.equal(autostartOwner(at, agent(file(['node', at.supervisor, '--config', at.config]), null)), 'other', 'a relative program is not what this launcher registers');
  for (const unanswered of [{status: 1, stdout: '', stderr: 'Operation not permitted'}, {status: null, stdout: '', error: new Error('ETIMEDOUT')}, {status: 113, stdout: '', stderr: ''}])
    assert.equal(autostartOwner(at, agent(file(mine), unanswered)), 'other', 'a question launchd did not answer is never "nothing is loaded"');
});

test('another installation\'s login item blocks a start unless a side-by-side trial was asked for explicitly', () => {
  assert.equal(loginItemBlocks('other', {}), true);
  assert.equal(loginItemBlocks('other', {AOS_V2_TRIAL_BESIDE_OTHER_INSTALL: 'yes'}), true, 'only the exact value counts');
  assert.equal(loginItemBlocks('other', {AOS_V2_TRIAL_BESIDE_OTHER_INSTALL: '1'}), false);
  assert.equal(loginItemBlocks('ours', {}), false); assert.equal(loginItemBlocks(null, {}), false);
});

test('a vault is completed without overwriting a note, and only a brand-new vault gets Obsidian settings', () => {
  const template = path.resolve('vault-template');
  const fresh = path.join(scratch(), 'vault');
  const first = scaffoldVault(template, fresh);
  assert.equal(first.newVault, true); assert.ok(first.created > 10);
  assert.ok(fs.existsSync(path.join(fresh, 'system/schemas/daily-note.md'))); assert.ok(fs.existsSync(path.join(fresh, 'system/v2')));
  assert.equal(pluginEnabled(fresh), true); assert.equal(fs.existsSync(path.join(fresh, '.obsidian-new-vault')), false);
  assert.equal(fs.readdirSync(path.join(fresh, 'daily-notes')).length, 0, 'placeholder files are not copied into a vault');
  fs.writeFileSync(path.join(fresh, 'CLAUDE.md'), 'mine');
  const again = scaffoldVault(template, fresh);
  assert.equal(again.created, 0); assert.equal(fs.readFileSync(path.join(fresh, 'CLAUDE.md'), 'utf8'), 'mine');
  const existing = path.join(scratch(), 'vault');
  fs.mkdirSync(path.join(existing, '.obsidian'), {recursive: true});
  fs.writeFileSync(path.join(existing, '.obsidian', 'app.json'), '{}');
  assert.equal(scaffoldVault(template, existing).newVault, false);
  assert.deepEqual(fs.readdirSync(path.join(existing, '.obsidian')), ['app.json'], 'an existing vault\'s settings folder is never written');
  assert.throws(() => scaffoldVault(template, path.join(template, 'inside')), /outside this installation/);
  assert.throws(() => scaffoldVault(template, 'relative/vault'), /absolute/);
});

test('a linked folder or note inside the vault is never written through', {skip: process.platform === 'win32' && 'creating links needs elevation on Windows'}, () => {
  const template = path.resolve('vault-template'), vault = path.join(scratch(), 'vault'), outside = scratch();
  fs.mkdirSync(vault, {recursive: true});
  fs.symlinkSync(outside, path.join(vault, 'inbox'), 'dir');
  fs.writeFileSync(path.join(outside, 'mine.md'), 'mine');
  fs.symlinkSync(path.join(outside, 'mine.md'), path.join(vault, 'CLAUDE.md'));
  scaffoldVault(template, vault);
  assert.deepEqual(fs.readdirSync(outside), ['mine.md'], 'nothing was created through the linked folder');
  assert.equal(fs.readFileSync(path.join(outside, 'mine.md'), 'utf8'), 'mine');
  assert.ok(fs.existsSync(path.join(vault, 'system/schemas/daily-note.md')));
});

test('the key page saves a well-formed key with the live settings, keeps tuned settings, and never echoes the key', async () => {
  const dir = scratch();
  assert.equal(saveJevKey(dir, 'not-a-key'), false); assert.equal(hasJevKey(dir), false);
  fs.writeFileSync(path.join(dir, 'jev.json'), JSON.stringify({theta: 0.95, key: 'sk-or-old0000000000'}));
  let address, html = '';
  const pending = collectJevKey({runtimeDir: dir, timeoutMs: 20000, open: () => {}, announce: url => { address = url; }});
  while (!address) await new Promise(resolve => setTimeout(resolve, 20));
  const origin = new URL(address).origin, form = key => ({method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: origin}, body: new URLSearchParams({key}).toString()});
  assert.equal((await fetch(`${origin}/wrong-token`)).status, 404);
  assert.equal((await fetch(address, {...form(FAKE_KEY), headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://127.0.0.1:3217'}})).status, 403, 'another local page cannot post a key');
  assert.equal((await fetch(address, {...form(FAKE_KEY), headers: {'Content-Type': 'application/x-www-form-urlencoded'}})).status, 403, 'a post without an Origin is refused');
  const bad = await fetch(address, form('hello')); assert.equal(bad.status, 400); html += await bad.text();
  const page = await fetch(address); assert.equal(page.headers.get('cache-control'), 'no-store'); html += await page.text();
  const good = await fetch(address, form(FAKE_KEY)); assert.equal(good.status, 200); html += await good.text();
  assert.deepEqual(await pending, {saved: true});
  assert.equal(html.includes(FAKE_KEY), false); assert.equal(html.includes('hello'), false);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'jev.json'), 'utf8'));
  assert.deepEqual(saved, {...JEV_DEFAULTS, theta: 0.95, key: FAKE_KEY});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'voice-strict.json'), 'utf8')), {open: 'on', ui: 'on'});
  assert.equal(hasJevKey(dir), true);
  await assert.rejects(fetch(address), 'the page is gone once the key is saved');
  assert.deepEqual(await collectJevKey({runtimeDir: scratch(), timeoutMs: 50, open: () => {}}), {saved: false, reason: 'timeout'});
});

test('the saved settings are exactly what the voice router reads as "fast path on"', async () => {
  const {readJevConfig} = await import('../runner/jev.mjs');
  const dir = scratch(); saveJevKey(dir, FAKE_KEY);
  const config = readJevConfig({env: {}, file: path.join(dir, 'jev.json')});
  assert.deepEqual(config, {key: FAKE_KEY, mode: {codex: 'fastpath', claude: 'fastpath'}, theta: 0.9, deadlineMs: 1500, tier2kind: true, rulebook: 'v2', openVeto: false});
});

test('python discovery skips a stub that answers nothing and refuses versions that are too old', () => {
  assert.deepEqual(parsePythonVersion('Python 3.12.4'), {major: 3, minor: 12, text: '3.12.4'});
  assert.equal(pythonSupported(parsePythonVersion('Python 3.9.6')), false); assert.equal(pythonSupported(parsePythonVersion('Python 2.7.18')), false);
  assert.equal(findPython({env: {PATH: '/nowhere'}, platform: 'darwin', run: () => ({status: 0, stdout: 'Python 3.11.9'})}), null, 'nothing on this PATH exists on disk');
  assert.equal(which('python3', {env: {PATH: '/a:/b'}, exists: file => file === '/b/python3', platform: 'darwin'}), '/b/python3');
  assert.equal(which('npm', {env: {PATH: 'C:\\one;C:\\n'}, exists: file => file === 'C:\\n\\npm.cmd', platform: 'win32'}), 'C:\\n\\npm.cmd');
});

test('command-line parsing and the local-page guard', () => {
  assert.deepEqual(parseArgs(['setup', '--vault', 'C:/My Vault', '--voice', 'no', '--rebuild']), {command: 'setup', flags: {vault: 'C:/My Vault', voice: 'no', rebuild: true}, words: []});
  assert.deepEqual(parseArgs(['autostart', 'on']), {command: 'autostart', flags: {}, words: ['on']});
  assert.deepEqual(parseArgs([]), {command: 'help', flags: {}, words: []});
  assert.throws(() => openUrl('https://example.com/x', {run: () => ({status: 0})}), /Only local pages/);
  assert.equal(openUrl('http://127.0.0.1:5123/token', {run: (command, args) => ({status: command === 'open' && args[0].endsWith('/token') ? 0 : 1}), platform: 'darwin'}), true);
});
