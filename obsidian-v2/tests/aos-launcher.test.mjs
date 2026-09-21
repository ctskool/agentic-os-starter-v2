import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseLsofPids, parsePsLine, parseWindowsProcess, commandIncludes, samePath, which, listener, openUrl} from '../scripts/aos/platform.mjs';
import {layout, desiredServices, mergePrior, ownedBy, stop, PORTS} from '../scripts/aos/services.mjs';
import {launchAgentPlist, scheduledTaskScript, autostartOwner, taskOwner, AGENT_LABEL, TASK_NAME} from '../scripts/aos/autostart.mjs';
import {preflight} from '../scripts/aos/setup.mjs';
import {scaffoldVault, pluginEnabled} from '../scripts/aos/vault.mjs';
import {saveJevKey, hasJevKey, collectJevKey, JEV_DEFAULTS} from '../scripts/aos/jev-key.mjs';
import {parsePythonVersion, pythonSupported, findPython} from '../scripts/aos/speech.mjs';
import {parseArgs} from '../scripts/aos.mjs';
import {supervisorConfig} from '../runner/service-supervisor.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aos-test-'));
const FAKE_KEY = 'sk-or-' + 'test0000'.repeat(4);

test('process listings from both operating systems are parsed, and junk is refused', () => {
  assert.deepEqual(parseLsofPids('812\n812\n  977 \nCOMMAND\n'), [812, 977]);
  assert.deepEqual(parsePsLine('Mon Sep  1 09:05:02 2026 /opt/homebrew/bin/node /Users/a/aos/obsidian-v2/runner/bridge.mjs\n'),
    {startedAt: 'Mon Sep 1 09:05:02 2026', commandLine: '/opt/homebrew/bin/node /Users/a/aos/obsidian-v2/runner/bridge.mjs', name: 'node'});
  assert.equal(parsePsLine('garbage'), null);
  assert.deepEqual(parseWindowsProcess('\uFEFF{"pid":42,"name":"node.exe","commandLine":"\\"C:\\\\n\\\\node.exe\\" C:\\\\x\\\\bridge.mjs","startedAt":"2026-09-21T18:33:46Z"}'),
    {pid: 42, name: 'node.exe', commandLine: '"C:\\n\\node.exe" C:\\x\\bridge.mjs', startedAt: '2026-09-21T18:33:46Z'});
  assert.equal(parseWindowsProcess('{"pid":"42"}'), null);
  assert.equal(parseWindowsProcess(''), null);
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

test('ownership needs the interpreter AND this checkout\'s script path, in either slash style', () => {
  const script = path.resolve('/x/aos/obsidian-v2/runner/bridge.mjs');
  assert.equal(ownedBy({name: 'node', commandLine: `/usr/bin/node ${script}`}, script), true);
  assert.equal(ownedBy({name: 'node.exe', commandLine: `"C:/node.exe" "${script.replace(/\\/g, '/')}"`}, script), true);
  assert.equal(ownedBy({name: 'node', commandLine: '/usr/bin/node /other/checkout/runner/bridge.mjs'}, script), false);
  assert.equal(ownedBy({name: 'python3', commandLine: `python3 ${script}`}, script), false);
  assert.equal(ownedBy({name: 'node', commandLine: `node /tmp/other.js --watch ${script}`}, script), false, 'our script as somebody else\'s argument is not our process');
  assert.equal(ownedBy({name: 'node', commandLine: `/usr/bin/node ${script}.bak`}, script), false);
  assert.equal(ownedBy({name: 'node', commandLine: `"/Applications/My Tools/node" "${script}"`}, script), true, 'an interpreter path with spaces');
  const speech = path.resolve('/x/aos/obsidian-v2/runner/speech.py'), python = {interpreter: /(^|\/)python[\d.]*(\.exe)?$/i, flags: ['-u'], after: /^"?\s+--assets\s/};
  assert.equal(ownedBy({commandLine: `/x/aos/obsidian-v2/.runtime/speech-venv/bin/python -u ${speech} --assets /x/assets`}, speech, python), true);
  assert.equal(ownedBy({commandLine: `/usr/bin/python3 -u ${speech}`}, speech, python), false, 'the expected arguments must follow');
  assert.equal(ownedBy({commandLine: `/usr/bin/node -u ${speech} --assets /x`}, speech, python), false);
  assert.equal(ownedBy({ambiguous: true}, script), false);
  assert.equal(ownedBy(null, script), false);
  assert.equal(commandIncludes('anything', ''), false);
  assert.equal(samePath('/a/b/../c', '/a/c'), true);
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
  const merged = mergePrior(desiredServices(at, {node}), {runtimeDir: at.runtime, services: [...base, {id: 'other', port: 1}]}, at.runtime);
  assert.deepEqual(merged.map(service => service.id), ['bridge', 'jarvis', 'speech']);
  assert.throws(() => mergePrior([], {runtimeDir: path.resolve('/elsewhere/.runtime'), services: []}, at.runtime), /another installation/);
});

function stopFixture({state, work, web, shutdown = {ok: true, data: {ok: true}}, listeners}) {
  const root = scratch(), at = layout(root);
  fs.mkdirSync(at.runtime, {recursive: true});
  fs.writeFileSync(at.vaultFile, JSON.stringify({vault: path.join(root, 'vault')}));
  fs.writeFileSync(at.auth, JSON.stringify({token: 'a'.repeat(64)}));
  const killed = [], posted = [];
  const owned = script => ({pid: 100 + killed.length, name: process.platform === 'win32' ? 'node.exe' : 'node', commandLine: `node ${script}${script.endsWith('next') ? ' start --hostname 127.0.0.1 --port 3217' : ''}`, startedAt: 'T1'});
  const table = listeners(at, owned);
  return {at, killed, posted, run: () => stop({root, log: () => {}, find: port => table[port] || null, inspect: pid => Object.values(table).find(item => item?.pid === pid) || null,
    kill: pid => killed.push(pid), get: async url => url.endsWith('/state') && !url.includes('/api/') ? state?.(at) : url.endsWith('/work') ? work : web?.(at),
    post: async (url, options) => { posted.push([url, options.headers['X-V2-Token']]); return shutdown; }})};
}
const ours = at => ({vault: path.join(at.root, 'vault')});

test('stop fails closed: nothing is stopped unless the bridge, the vault, the tasks and every process check out', async () => {
  const healthy = (at, owned) => ({[PORTS.bridge]: {...owned(at.bridge), pid: 1}, [PORTS.jarvis]: {...owned(at.next), pid: 2}});
  const cases = [
    [{state: () => null, work: {tasks: []}, listeners: healthy}, /Bridge is unavailable/],
    [{state: () => ({vault: '/someone/else'}), work: {tasks: []}, listeners: healthy}, /another vault/],
    [{state: ours, work: {tasks: [{state: 'ready', pid: null}]}, listeners: healthy}, /Stop active tasks/],
    [{state: ours, work: {tasks: [{state: 'stopped', pid: 77}]}, listeners: healthy}, /Stop active tasks/],
    [{state: ours, work: null, listeners: healthy}, /Stop active tasks/],
    [{state: ours, work: {tasks: []}, web: ours, listeners: (at, owned) => ({...healthy(at, owned), [PORTS.bridge]: {pid: 1, name: 'node', commandLine: 'node /another/checkout/runner/bridge.mjs', startedAt: 'T1'}})}, /Unexpected process on 3219/],
    [{state: ours, work: {tasks: []}, web: ours, listeners: (at, owned) => ({...healthy(at, owned), [PORTS.jarvis]: {ambiguous: true}})}, /Unexpected process on 3217/],
    [{state: ours, work: {tasks: []}, web: () => ({vault_root: '/someone/else'}), listeners: healthy}, /Jarvis belongs to another vault/],
  ];
  for (const [options, message] of cases) {
    const fixture = stopFixture(options);
    await assert.rejects(fixture.run(), message);
    assert.deepEqual(fixture.killed, []); assert.deepEqual(fixture.posted, []);
  }
  const refused = stopFixture({state: ours, work: {tasks: []}, web: at => ({vault_root: path.join(at.root, 'vault')}), shutdown: {ok: false, data: {error: 'Stop active terminal tasks and voice requests first.'}}, listeners: healthy});
  await assert.rejects(refused.run(), /Stop active terminal tasks/);
  assert.deepEqual(refused.killed, [], 'a bridge that refuses to shut down leaves the HUD running');
});

test('stop shuts the bridge down through its own endpoint, stops only verified processes, and leaves borrowed speech alone', async () => {
  const fixture = stopFixture({state: ours, work: {tasks: [{state: 'stopped', pid: null}]}, web: at => ({vault_root: path.join(at.root, 'vault')}),
    listeners: (at, owned) => ({[PORTS.bridge]: {...owned(at.bridge), pid: 1}, [PORTS.jarvis]: {...owned(at.next), pid: 2},
      [PORTS.speech]: {pid: 3, name: 'python.exe', commandLine: 'python -u C:/another/install/runner/speech.py', startedAt: 'T1'}})});
  const result = await fixture.run();
  assert.deepEqual(result.stopped, ['bridge', 'jarvis']);
  assert.deepEqual(fixture.killed, [2], 'the bridge exits by itself; speech from another installation is not ours to stop');
  assert.deepEqual(fixture.posted, [['http://127.0.0.1:3219/shutdown', 'a'.repeat(64)]]);
  const recycled = stopFixture({state: ours, work: {tasks: []}, web: at => ({vault_root: path.join(at.root, 'vault')}),
    listeners: (at, owned) => ({[PORTS.bridge]: {...owned(at.bridge), pid: 1}, [PORTS.jarvis]: {...owned(at.next), pid: 2}})});
  let calls = 0;
  const original = recycled.run;
  void original;
  const at = recycled.at;
  await stop({root: at.root, log: () => {}, find: port => port === PORTS.jarvis ? {pid: 2, name: 'node', commandLine: `node ${at.next} start --hostname 127.0.0.1 --port 3217`, startedAt: 'T1'} : port === PORTS.bridge ? {pid: 1, name: 'node', commandLine: `node ${at.bridge}`, startedAt: 'T1'} : null,
    inspect: () => { calls++; return {pid: 2, name: 'node', commandLine: 'something else now', startedAt: 'T2'}; }, kill: pid => recycled.killed.push(pid),
    get: async url => url.includes('/api/state') ? {vault_root: path.join(at.root, 'vault')} : url.endsWith('/work') ? {tasks: []} : {vault: path.join(at.root, 'vault')}, post: async () => ({ok: true, data: {}})});
  assert.equal(calls, 1); assert.deepEqual(recycled.killed, [], 'a process id that now belongs to a different process is left alone');
});

test('login items carry the captured PATH, survive odd characters, and another checkout\'s item is never claimed', () => {
  const plist = launchAgentPlist({node: '/opt/homebrew/bin/node', supervisor: '/Users/a&b/aos/runner/service-supervisor.mjs', config: '/Users/a&b/aos/.runtime/service-recovery.json', cwd: '/Users/a&b/aos', pathEnv: '/opt/homebrew/bin:/usr/bin', log: '/tmp/x.log'});
  assert.match(plist, new RegExp(`<string>${AGENT_LABEL}</string>`));
  assert.match(plist, /<string>\/Users\/a&amp;b\/aos\/runner\/service-supervisor\.mjs<\/string>\n\s*<string>--config<\/string>/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/); assert.match(plist, /<key>AbandonProcessGroup<\/key><true\/>/);
  assert.match(plist, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
  const script = scheduledTaskScript({node: "C:\\n\\node.exe", config: "C:\\Users\\O'Neil\\aos\\.runtime\\service-recovery.json", wrapper: 'C:\\aos\\scripts\\run-recovery.ps1', cwd: 'C:\\aos'});
  assert.match(script, /O''Neil/); assert.ok(script.includes(`-TaskName '${TASK_NAME}'`)); assert.match(script, /-WindowStyle Hidden -File/);
  const at = layout(path.resolve('/x/aos/obsidian-v2'));
  const wrapper = path.join(at.root, 'scripts', 'run-recovery.ps1'), ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const task = actions => JSON.stringify({exists: true, actions});
  assert.equal(taskOwner('', wrapper), null);
  assert.equal(taskOwner(task([{execute: ps, arguments: `-File "${wrapper}" -NodeExecutable x`}]), wrapper), 'ours');
  assert.equal(taskOwner(task([{execute: ps, arguments: '-File "D:\\\\other\\\\run-recovery.ps1"'}]), wrapper), 'other');
  assert.equal(taskOwner(task([{execute: 'C:\\\\tools\\\\backup.exe', arguments: ''}]), wrapper), 'other', 'a same-named task with no arguments is somebody else\'s, not absent');
  assert.equal(taskOwner(task([]), wrapper), 'other');
  assert.equal(taskOwner(task([{execute: 'C:\\\\x\\\\evil.exe', arguments: `"${wrapper}"`}]), wrapper), 'other', 'our wrapper as an argument of another program');
  assert.equal(taskOwner(task([{execute: ps, arguments: `-File "${wrapper}"`}, {execute: ps, arguments: 'extra'}]), wrapper), 'other');
  assert.equal(taskOwner('not json', wrapper), 'other');
  assert.equal(autostartOwner(at, {platform: 'win32', run: () => ({status: 1, stdout: ''})}), 'other', 'an unanswerable question is not a yes');
  const agent = (file, loaded) => ({platform: 'darwin', home: '/Users/a', exists: () => file !== null, read: () => file, run: () => loaded === null ? {status: 113, stdout: ''} : {status: 0, stdout: loaded}});
  assert.equal(autostartOwner(at, agent(null, null)), null);
  assert.equal(autostartOwner(at, agent(`<string>${at.supervisor}</string>`, null)), 'ours');
  assert.equal(autostartOwner(at, agent('<string>/other/runner/service-supervisor.mjs</string>', null)), 'other');
  assert.equal(autostartOwner(at, agent(null, 'arguments = {/opt/node /other/checkout/runner/service-supervisor.mjs}')), 'other', 'a loaded job whose file is gone still belongs to someone');
  assert.equal(autostartOwner(at, agent(`<string>${at.supervisor}</string>`, 'arguments = {/opt/node /other/checkout/runner/service-supervisor.mjs}')), 'other', 'our file on disk does not make a foreign loaded job ours');
  assert.equal(autostartOwner(at, agent(null, `arguments = {/opt/node ${at.supervisor}}`)), 'ours');
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
  const found = findPython({env: {PATH: '/bin'}, platform: 'darwin', run: command => command.endsWith('python3') ? {status: 0, stdout: 'Python 3.11.9'} : {status: 9009, stdout: ''}});
  assert.equal(found, null, 'nothing on this PATH exists on disk');
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

test('a HUD that renamed its own process (macOS, Linux) is proven by the monitor\'s pid or by its working directory, never by its title alone', async () => {
  const {parseLsofCwd, processCwd} = await import('../scripts/aos/platform.mjs');
  assert.equal(parseLsofCwd('p501\nfcwd\nn/Users/a/aos/jarvis-v2\n'), '/Users/a/aos/jarvis-v2');
  assert.equal(parseLsofCwd('p501\n'), null);
  assert.equal(processCwd(501, {platform: 'win32'}), null);
  assert.equal(processCwd(501, {platform: 'darwin', run: () => ({status: 0, stdout: 'p501\nfcwd\nn/x/jarvis-v2\n'})}), '/x/jarvis-v2');
  const root = scratch(), at = layout(root), vault = path.join(root, 'vault');
  fs.mkdirSync(at.runtime, {recursive: true});
  fs.writeFileSync(at.vaultFile, JSON.stringify({vault})); fs.writeFileSync(at.auth, JSON.stringify({token: 'b'.repeat(64)}));
  const renamed = {pid: 2, name: 'next-server', commandLine: 'next-server (v15.3.2)', startedAt: 'T1'};
  const bridge = {pid: 1, name: 'node', commandLine: `node ${at.bridge}`, startedAt: 'T1'};
  const attempt = async ({cwd, monitor}) => {
    const killed = [];
    const run = stop({root, log: () => {}, find: port => port === PORTS.jarvis ? renamed : port === PORTS.bridge ? bridge : null, inspect: () => renamed, cwdOf: () => cwd, kill: pid => killed.push(pid),
      get: async url => url.endsWith(':3221/status') ? monitor : url.includes('/api/state') ? {vault_root: vault} : url.endsWith('/work') ? {tasks: []} : {vault}, post: async () => ({ok: true, data: {}})});
    return {run, killed};
  };
  const elsewhere = await attempt({cwd: '/another/checkout/jarvis-v2', monitor: null});
  await assert.rejects(elsewhere.run, /Unexpected process on 3217/); assert.deepEqual(elsewhere.killed, []);
  const foreignMonitor = await attempt({cwd: null, monitor: {kind: 'agentic-os-service-supervisor', runtimeDir: path.resolve('/another/.runtime'), services: [{id: 'jarvis', pid: 2}]}});
  await assert.rejects(foreignMonitor.run, /Unexpected process on 3217/);
  const byCwd = await attempt({cwd: at.jarvis, monitor: null});
  await byCwd.run; assert.deepEqual(byCwd.killed, [2]);
  const byMonitor = await attempt({cwd: null, monitor: {kind: 'agentic-os-service-supervisor', runtimeDir: at.runtime, services: [{id: 'jarvis', pid: 2}]}});
  await byMonitor.run; assert.deepEqual(byMonitor.killed, [2]);
});

test('setup changes nothing when another installation owns the ports or the vault', async () => {
  const root = scratch(), at = layout(root), vault = path.join(scratch(), 'vault');
  const ourMonitor = {kind: 'agentic-os-service-supervisor', runtimeDir: at.runtime};
  await assert.rejects(preflight(at, vault, {get: async () => ({kind: 'agentic-os-service-supervisor', runtimeDir: path.resolve('/elsewhere/.runtime')}), find: () => null}), /Another installation .* port 3221.*Nothing was changed/);
  await assert.rejects(preflight(at, vault, {get: async () => ({hello: 'world'}), find: () => null}), /port 3221/);
  await assert.rejects(preflight(at, vault, {get: async () => null, find: port => port === PORTS.supervisor ? {pid: 9} : null}), /Another program is using port 3221/);
  await assert.rejects(preflight(at, vault, {get: async () => null, find: port => port === PORTS.bridge ? {pid: 9, commandLine: 'node /another/runner/bridge.mjs'} : null}), /port 3219/);
  await assert.doesNotReject(preflight(at, vault, {get: async () => null, find: () => null}));
  await assert.doesNotReject(preflight(at, vault, {get: async () => ourMonitor, find: port => port === PORTS.jarvis ? {pid: 2, commandLine: 'next-server (v15.3.2)'} : null}));
  const marker = path.join(vault, '.obsidian', 'plugins', 'agentic-os-v2');
  fs.mkdirSync(marker, {recursive: true});
  fs.writeFileSync(path.join(marker, 'terminal-runtime.json'), JSON.stringify({runtimeDir: path.resolve('/first/install/obsidian-v2/.runtime')}));
  await assert.rejects(preflight(at, vault, {get: async () => null, find: () => null}), /already connected to another installation .*--adopt/);
  await assert.doesNotReject(preflight(at, vault, {adopt: true, get: async () => null, find: () => null}));
  fs.writeFileSync(path.join(marker, 'terminal-runtime.json'), JSON.stringify({runtimeDir: at.runtime}));
  await assert.doesNotReject(preflight(at, vault, {get: async () => null, find: () => null}));
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
