import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {startSupervisor, supervisorConfig} from '../runner/service-supervisor.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description, timeout = 5000) {
  const end = Date.now() + timeout;
  do { if (await predicate()) return; await delay(15); } while (Date.now() < end);
  assert.fail(`Timed out: ${description}`);
}
async function listen(server, port = 0) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server.address().port;
}
async function close(server) {
  if (!server.listening) return;
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
}
async function freePort() {
  const server = http.createServer();
  const port = await listen(server); await close(server); return port;
}
async function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-service-recovery-'));
  const port = await freePort(), lockPort = await freePort();
  const script = path.join(dir, 'server.mjs');
  fs.writeFileSync(script, `
    import fs from 'node:fs'; import http from 'node:http';
    const [port,dir,mode] = process.argv.slice(2);
    fs.appendFileSync(dir+'/starts', process.pid+'\\n');
    if(mode==='crash') process.exit(0);
    const server=http.createServer((req,res)=>{res.writeHead(503);res.end('fixture');});
    server.listen(Number(port),'127.0.0.1');
    setInterval(()=>{
      if(fs.existsSync(dir+'/stop'))process.exit(0);
      if(fs.existsSync(dir+'/unlisten')&&server.listening)server.close();
    },10);
    setTimeout(()=>process.exit(9),10000);
  `);
  const config = {runtimeDir:path.join(dir, 'runtime'), lockPort, intervalMs:20, probeTimeoutMs:40,
    failureThreshold:3, backoffBaseMs:50, backoffMaxMs:200, restartLimit:3, restartWindowMs:5000, stableMs:200,
    services:[{id:'bridge', port, command:process.execPath, args:[script, String(port), dir, overrides.mode || 'normal', 'SECRET_PROMPT'],
      cwd:dir, env:{SECRET_AUTH_TOKEN:'SECRET_TOKEN'}}], ...overrides};
  const supervisors = [], servers = [];
  const count = () => fs.existsSync(path.join(dir,'starts')) ? fs.readFileSync(path.join(dir,'starts'),'utf8').trim().split('\n').length : 0;
  t.after(async () => {
    for (const supervisor of supervisors) await supervisor.stop();
    fs.writeFileSync(path.join(dir,'stop'), 'stop');
    for (const server of servers) await close(server);
    await delay(100);
    // All fixture children have a bounded lifetime; no production process is touched.
    fs.rmSync(dir, {recursive:true, force:true});
  });
  return {dir, config, count, servers,
    async start(options) { const supervisor = await startSupervisor(config, options); supervisors.push(supervisor); return supervisor; },
    async foreign() { const server = http.createServer((req,res) => {res.writeHead(503);res.end('not Agentic OS');});
      await listen(server, port); servers.push(server); return server; }};
}

test('accepts an existing listener including HTTP 503 without starting any duplicate', async t => {
  const f = await fixture(t); await f.foreign();
  const supervisor = await f.start();
  await delay(150);
  assert.equal(supervisor.snapshot().services[0].phase, 'online');
  assert.equal(supervisor.snapshot().services[0].pid, null);
  assert.equal(f.count(), 0);
});

test('adopted service recovers only after multiple failures and never replays a task', async t => {
  const f = await fixture(t, {intervalMs:60}); const server = await f.foreign();
  const supervisor = await f.start(); await close(server);
  await delay(70); assert.equal(f.count(), 0);
  await until(() => supervisor.snapshot().services[0].phase === 'online' && f.count() === 1, 'replacement listener');
  await delay(100); assert.equal(f.count(), 1);
  const log = fs.readFileSync(path.join(f.config.runtimeDir,'service-supervisor.jsonl'), 'utf8');
  assert.doesNotMatch(log, /SECRET_PROMPT|SECRET_TOKEN|terminal|task/);
});

test('live managed child with no listener is never replaced or killed', async t => {
  const f = await fixture(t); const supervisor = await f.start();
  await until(() => supervisor.snapshot().services[0].phase === 'online', 'first listener');
  const pid = supervisor.snapshot().services[0].pid;
  fs.writeFileSync(path.join(f.dir,'unlisten'), 'close listener');
  await until(() => supervisor.snapshot().services[0].phase === 'waiting_for_listener', 'unlistened child');
  await delay(200);
  assert.equal(f.count(), 1); assert.equal(supervisor.snapshot().services[0].pid, pid);
  assert.doesNotThrow(() => process.kill(pid, 0));
});

test('unexpected clean exit restarts with backoff and exhausts a persistent crash budget', async t => {
  const f = await fixture(t, {mode:'crash', stableMs:1000}); const supervisor = await f.start();
  await until(() => supervisor.snapshot().services[0].phase === 'blocked', 'crash-loop circuit breaker');
  assert.equal(f.count(), 3); assert.equal(supervisor.snapshot().services[0].lastExitCode, 0);
  const events = fs.readFileSync(path.join(f.config.runtimeDir,'service-supervisor.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const starts = events.filter(e => e.event === 'start').map(e => Date.parse(e.at));
  assert.ok(starts[1] - starts[0] >= 50); assert.ok(starts[2] - starts[1] >= 100);
  await supervisor.stop();
  const resumed = await f.start(); await delay(120);
  assert.equal(resumed.snapshot().services[0].blocked, true); assert.equal(f.count(), 3);
  await f.foreign();
  await until(() => resumed.snapshot().services[0].blocked === false, 'manually restored service clears budget');
  assert.equal(resumed.snapshot().services[0].attempts, 0);
});

test('intentional pause marker stops recovery without killing an online child', async t => {
  const f = await fixture(t); const supervisor = await f.start();
  await until(() => supervisor.snapshot().services[0].phase === 'online', 'managed listener');
  const pid = supervisor.snapshot().services[0].pid;
  fs.writeFileSync(path.join(f.config.runtimeDir,'services-paused.json'), '{}');
  assert.equal((await supervisor.closed).reason, 'pause_marker');
  assert.doesNotThrow(() => process.kill(pid, 0));
  fs.writeFileSync(path.join(f.dir,'stop'), 'stop'); await delay(120);
  assert.equal(f.count(), 1);
  const paused = await f.start(); assert.equal((await paused.closed).reason, 'pause_marker');
  assert.equal(f.count(), 1);
});

test('manual supervisor stop persists pause and leaves services untouched', async t => {
  const f = await fixture(t); await f.foreign(); const supervisor = await f.start();
  await supervisor.stop({pause:true, reason:'manual'});
  assert.ok(fs.existsSync(path.join(f.config.runtimeDir,'services-paused.json')));
  assert.equal((await fetch(`http://127.0.0.1:${f.config.services[0].port}`)).status, 503);
});

test('second supervisor cannot write, probe or spawn before acquiring exclusive lock', async t => {
  const f = await fixture(t); await f.foreign(); await f.start();
  const otherRuntime = path.join(f.dir, 'must-not-exist');
  await assert.rejects(startSupervisor({...f.config, runtimeDir:otherRuntime}), {code:'EADDRINUSE'});
  assert.equal(fs.existsSync(otherRuntime), false); assert.equal(f.count(), 0);
});

test('status is local read-only and excludes command, prompts and authentication', async t => {
  const f = await fixture(t); await f.foreign(); await f.start();
  const url = `http://127.0.0.1:${f.config.lockPort}/status`;
  const response = await fetch(url); const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(body).runtimeDir, f.config.runtimeDir);
  assert.doesNotMatch(body, /SECRET_PROMPT|SECRET_TOKEN|command|args|env/);
  assert.equal((await fetch(url, {method:'POST'})).status, 405);
  assert.equal((await fetch(url, {headers:{Origin:'https://evil.example'}})).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    http.get(url, {headers:{Host:'evil.example'}}, response => {response.resume(); resolve(response.statusCode);}).on('error', reject);
  });
  assert.equal(hostileHostStatus, 403);
});

test('a failing optional web server does not interrupt an adopted bridge', async t => {
  const bridge = await fixture(t), web = await fixture(t, {mode:'crash'});
  await bridge.foreign();
  bridge.config.services.push({...web.config.services[0], id:'jarvis'});
  const supervisor = await bridge.start();
  await until(() => supervisor.snapshot().services[1].phase === 'blocked', 'optional web crash budget');
  assert.equal(supervisor.snapshot().services[0].phase, 'online');
  assert.equal(bridge.count(), 0); assert.equal(web.count(), 3);
});

test('explicit budget reset is applied only by the lock owner', async t => {
  const f = await fixture(t); await f.foreign();
  fs.mkdirSync(f.config.runtimeDir); fs.writeFileSync(path.join(f.config.runtimeDir,'service-recovery-state.json'), JSON.stringify({version:1,services:{bridge:{starts:[Date.now()],nextStartAt:Date.now()+10000,blocked:true}}}));
  const supervisor = await f.start({resetRecovery:true});
  assert.equal(supervisor.snapshot().services[0].blocked, false);
  assert.equal(supervisor.snapshot().services[0].attempts, 0);
});

test('missing executable respects crash budget and records only a bounded error code', async t => {
  const f = await fixture(t);
  f.config.services[0].command = path.join(f.dir, 'missing-executable.exe');
  const supervisor = await f.start();
  await until(() => supervisor.snapshot().services[0].phase === 'blocked', 'spawn-error crash budget');
  assert.equal(supervisor.snapshot().services[0].lastSpawnErrorCode, 'ENOENT');
  assert.equal(supervisor.snapshot().services[0].attempts, 3);
  const log = fs.readFileSync(path.join(f.config.runtimeDir,'service-supervisor.jsonl'), 'utf8');
  assert.match(log, /ENOENT/); assert.doesNotMatch(log, /missing-executable|SECRET/);
});

test('invalid config cannot start a service', () => {
  assert.throws(() => supervisorConfig({runtimeDir:'relative', services:[]}));
  assert.throws(() => supervisorConfig({runtimeDir:os.tmpdir(), lockPort:0, services:[]}));
});
