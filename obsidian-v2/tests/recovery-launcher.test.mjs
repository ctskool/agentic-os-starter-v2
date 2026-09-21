import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const windows = process.platform === 'win32';
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, timeout = 15000) {
  const end = Date.now() + timeout;
  do { const result = await check(); if (result) return result; await delay(40); } while (Date.now() < end);
  assert.fail(`Timed out: ${description}`);
}
async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function readStatus(port) {
  try { const result = await fetch(`http://127.0.0.1:${port}/status`, {signal:AbortSignal.timeout(400)}); return result.ok ? await result.json() : null; }
  catch { return null; }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function fixture(t, supervisorSource) {
  // Spaces exercise both Start-Process arguments, without using production paths or ports.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos recovery launcher '));
  const runtime = path.join(dir, 'runtime');
  fs.mkdirSync(path.join(dir, 'scripts')); fs.mkdirSync(path.join(dir, 'runner')); fs.mkdirSync(runtime);
  fs.copyFileSync(path.join(repo, 'scripts', 'run-recovery.ps1'), path.join(dir, 'scripts', 'run-recovery.ps1'));
  if (supervisorSource) fs.writeFileSync(path.join(dir, 'runner', 'service-supervisor.mjs'), supervisorSource);
  else fs.copyFileSync(path.join(repo, 'runner', 'service-supervisor.mjs'), path.join(dir, 'runner', 'service-supervisor.mjs'));
  const processes = new Set();
  t.after(async () => {
    fs.writeFileSync(path.join(runtime, 'services-paused.json'), '{}');
    fs.writeFileSync(path.join(dir, 'stop-child'), 'stop');
    await delay(200);
    for (const pid of processes) if (alive(pid)) { try { process.kill(pid); } catch {} }
    await delay(200);
    const resolved = path.resolve(dir), relative = path.relative(path.resolve(os.tmpdir()), resolved);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.ok(path.basename(resolved).startsWith('aos recovery launcher '));
    fs.rmSync(resolved, {recursive:true, force:true, maxRetries:10, retryDelay:50});
  });
  function launch(config, options = {}) {
    const file = path.join(runtime, 'config file.json'); fs.writeFileSync(file, JSON.stringify(config));
    const processHandle = spawn(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File',
      path.join(dir, 'scripts', 'run-recovery.ps1'), '-NodeExecutable', process.execPath, '-ConfigFile', file,
      ...Object.entries(options).flatMap(([key, value]) => [`-${key}`, String(value)])],
    {cwd:dir, windowsHide:true, stdio:['ignore', 'pipe', 'pipe']});
    processes.add(processHandle.pid);
    let output = '', result = null;
    processHandle.stdout.on('data', chunk => {output += chunk.toString();});
    processHandle.stderr.on('data', chunk => {output += chunk.toString();});
    processHandle.on('error', error => {result = {error};});
    processHandle.on('close', (code, signal) => {result = {code, signal};});
    return {result:() => result, output:() => output};
  }
  return {dir, runtime, processes, launch};
}

test('Windows recovery scripts parse with the installed scheduled-task PowerShell', {skip:!windows}, () => {
  assert.ok(fs.existsSync(powershell), 'Stable Windows PowerShell task executable exists');
  const script = `$ErrorActionPreference='Stop'; $files=@('start-recovery.ps1','run-recovery.ps1','start-v2.ps1','start-terminal-test.ps1','services.ps1'); foreach($file in $files){$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $env:AOS_TEST_RECOVERY_SCRIPTS $file),[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){throw ($errors|Out-String)}};Write-Output 'parsed'`;
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env:{...process.env, AOS_TEST_RECOVERY_SCRIPTS:path.join(repo, 'scripts')}, windowsHide:true, encoding:'utf8', timeout:15000});
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /parsed/);
});

test('Windows wrapper exits successfully on pause while its detached service stays alive', {skip:!windows, timeout:25000}, async t => {
  const f = fixture(t), port = await freePort();
  let lockPort; do {lockPort = await freePort();} while (lockPort === port);
  const serviceFile = path.join(f.dir, 'fake child.mjs');
  fs.writeFileSync(serviceFile, `import fs from 'node:fs';import http from 'node:http';
    const [port,dir]=process.argv.slice(2);fs.writeFileSync(dir+'/child.pid',String(process.pid));
    http.createServer((req,res)=>res.end('fixture')).listen(Number(port),'127.0.0.1');
    setInterval(()=>{if(fs.existsSync(dir+'/stop-child'))process.exit(0)},25);
    setTimeout(()=>process.exit(9),30000);`);
  const wrapper = f.launch({runtimeDir:f.runtime, lockPort, intervalMs:40, failureThreshold:1, probeTimeoutMs:100,
    services:[{id:'fixture', port, command:process.execPath, args:[serviceFile, String(port), f.dir], cwd:f.dir}]});
  const status = await until(async () => {
    const current = await readStatus(lockPort);
    if (current?.pid) f.processes.add(current.pid);
    if (current?.services[0]?.pid) f.processes.add(current.services[0].pid);
    return current?.services[0]?.phase === 'online' && current.services[0].pid ? current : null;
  }, 'isolated supervisor and managed child');
  const childPid = status.services[0].pid;
  assert.equal(wrapper.result(), null, wrapper.output());
  fs.writeFileSync(path.join(f.runtime, 'services-paused.json'), '{}');
  const result = await until(wrapper.result, 'wrapper exit after parent-only wait', 8000);
  assert.deepEqual(result, {code:0, signal:null}, wrapper.output());
  assert.equal(alive(childPid), true, 'Pause must preserve the detached service');
  assert.equal(await readStatus(lockPort), null, 'Supervisor released its lock');
  const response = await fetch(`http://127.0.0.1:${port}`, {signal:AbortSignal.timeout(1000)});
  assert.equal(await response.text(), 'fixture');
});

test('Windows wrapper preserves a failing supervisor exit code', {skip:!windows, timeout:20000}, async t => {
  const f = fixture(t, 'process.exit(7);');
  const wrapper = f.launch({runtimeDir:f.runtime}, {MaxRestarts:0});
  const result = await until(wrapper.result, 'failing supervisor exit');
  assert.deepEqual(result, {code:7, signal:null}, wrapper.output());
  const diagnostic = fs.readFileSync(path.join(f.runtime, 'service-supervisor-startup-error.log'), 'utf8');
  assert.match(diagnostic, /exited with code 7/);
  assert.ok(diagnostic.length < 200, 'Wrapper failure diagnosis stays bounded');
});

function countedSupervisor(exitExpression) {
  return `import fs from 'node:fs';
    const config=JSON.parse(fs.readFileSync(process.argv.at(-1),'utf8'));
    const file=config.runtimeDir+'/attempts.json';
    const attempts=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];
    attempts.push({pid:process.pid,at:Date.now()});fs.writeFileSync(file,JSON.stringify(attempts));
    process.exit(${exitExpression});`;
}

test('Windows wrapper retries an unexpected exit and stops retrying after clean exit', {skip:!windows, timeout:20000}, async t => {
  const f = fixture(t, countedSupervisor('attempts.length===1?7:0'));
  const wrapper = f.launch({runtimeDir:f.runtime}, {RetryDelaySeconds:1});
  const result = await until(wrapper.result, 'successful supervisor retry');
  assert.deepEqual(result, {code:0, signal:null}, wrapper.output());
  const attempts = JSON.parse(fs.readFileSync(path.join(f.runtime, 'attempts.json'), 'utf8'));
  assert.equal(attempts.length, 2, 'A clean exit stops all further retries');
  assert.notEqual(attempts[0].pid, attempts[1].pid);
  assert.ok(attempts[1].at - attempts[0].at >= 1000, 'Unexpected exit receives backoff');
});

test('Windows wrapper exhausts a bounded exponential retry budget and preserves the last failure', {skip:!windows, timeout:20000}, async t => {
  const f = fixture(t, countedSupervisor('6+attempts.length'));
  const wrapper = f.launch({runtimeDir:f.runtime}, {MaxRestarts:2, RetryDelaySeconds:1});
  const result = await until(wrapper.result, 'bounded supervisor failures');
  assert.deepEqual(result, {code:9, signal:null}, wrapper.output());
  const attempts = JSON.parse(fs.readFileSync(path.join(f.runtime, 'attempts.json'), 'utf8'));
  assert.equal(attempts.length, 3, 'Initial attempt plus exactly two restarts');
  assert.ok(attempts[1].at - attempts[0].at >= 1000);
  assert.ok(attempts[2].at - attempts[1].at >= 2000);
});

test('Windows wrapper pause marker cancels a pending retry', {skip:!windows, timeout:20000}, async t => {
  const f = fixture(t, countedSupervisor('7'));
  const wrapper = f.launch({runtimeDir:f.runtime}, {RetryDelaySeconds:1});
  const attemptsFile = path.join(f.runtime, 'attempts.json');
  const diagnosticFile = path.join(f.runtime, 'service-supervisor-startup-error.log');
  await until(() => fs.existsSync(diagnosticFile), 'failed supervisor entered retry delay');
  fs.writeFileSync(path.join(f.runtime, 'services-paused.json'), '{}');
  const result = await until(wrapper.result, 'pause cancels retry');
  assert.deepEqual(result, {code:0, signal:null}, wrapper.output());
  assert.equal(JSON.parse(fs.readFileSync(attemptsFile, 'utf8')).length, 1, 'Pause must not relaunch the monitor');
});
