// Cross-platform start / stop / status. Same rules as start-recovery.ps1 and
// services.ps1: nothing is written or stopped until ownership is proven, and
// an intentional stop pauses recovery so nothing restarts behind the user.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {projectRoot} from '../../runner/runtime.mjs';
import {listener, processInfo, processCwd, samePath, commandRuns, tryJson, fetchJson, sleep} from './platform.mjs';
import {autostartOwner, kickAutostart} from './autostart.mjs';

export const PORTS = {jarvis: 3217, preview: 3218, bridge: 3219, speech: 3220, supervisor: 3221};
const local = port => `http://127.0.0.1:${port}`;
const OPEN_STATES = new Set(['working', 'ready', 'editing', 'starting', 'needs input']);

export function layout(root = projectRoot) {
  const runtime = path.join(root, '.runtime'), jarvis = path.resolve(root, '..', 'jarvis-v2');
  const venv = path.join(runtime, 'speech-venv');
  return {root, runtime, jarvis, config: path.join(runtime, 'service-recovery.json'), pause: path.join(runtime, 'services-paused.json'),
    recoveryState: path.join(runtime, 'service-recovery-state.json'), vaultFile: path.join(runtime, 'vault.json'), auth: path.join(runtime, 'bridge-auth.json'),
    supervisor: path.join(root, 'runner', 'service-supervisor.mjs'), bridge: path.join(root, 'runner', 'bridge.mjs'), preview: path.join(root, 'preview', 'server.mjs'),
    next: path.join(jarvis, 'node_modules', 'next', 'dist', 'bin', 'next'), buildId: path.join(jarvis, '.next', 'BUILD_ID'),
    speechScript: path.join(root, 'runner', 'speech.py'), speechAssets: path.join(runtime, 'speech-assets'),
    speechPython: process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python'), venv};
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export const configuredVaultPath = at => fs.existsSync(at.vaultFile) ? readJson(at.vaultFile).vault : null;
export const speechInstalled = at => fs.existsSync(at.speechPython) && ['kokoro-v1.0.onnx', 'voices-v1.0.bin'].every(name => fs.existsSync(path.join(at.speechAssets, name)));

// Pure: the list of services the monitor should keep alive.
export function desiredServices(at, {node = process.execPath, speechUrl = null, vault = null, preview = false, jarvisBuilt = false, ownSpeech = false} = {}) {
  const env = {...(speechUrl ? {AOS_V2_SPEECH_URL: speechUrl} : {}), ...(vault ? {AOS_V2_VAULT: vault} : {})};
  const services = [{id: 'bridge', port: PORTS.bridge, command: node, args: [at.bridge], cwd: at.root, env}];
  if (preview) services.push({id: 'preview', port: PORTS.preview, command: node, args: [at.preview], cwd: at.root, env});
  if (jarvisBuilt) services.push({id: 'jarvis', port: PORTS.jarvis, command: node, args: [at.next, 'start', '--hostname', '127.0.0.1', '--port', String(PORTS.jarvis)], cwd: at.jarvis});
  if (ownSpeech) services.push({id: 'speech', port: PORTS.speech, command: at.speechPython, args: ['-u', at.speechScript, '--assets', at.speechAssets], cwd: at.root});
  return services;
}

// Pure: a normal start keeps optional services an earlier start configured.
export function mergePrior(services, prior, runtimeDir) {
  if (!prior) return services;
  if (!samePath(prior.runtimeDir, runtimeDir)) throw new Error('Recovery configuration belongs to another installation.');
  const ids = new Set(services.map(service => service.id));
  return [...services, ...(prior.services || []).filter(service => ['preview', 'jarvis', 'speech'].includes(service.id) && !ids.has(service.id))];
}

async function healthySpeech() {
  for (const port of [PORTS.speech, 3108]) {
    const health = await tryJson(`${local(port)}/health`, {timeoutMs: 2000});
    if (health?.ok && health?.stt?.ok) return local(port);
  }
  return null;
}

const supervisorStatus = (timeoutMs = 2000) => tryJson(`${local(PORTS.supervisor)}/status`, {timeoutMs});
async function waitForSupervisorExit() {
  for (let attempt = 0; attempt < 20; attempt++) { await sleep(500); if (!await supervisorStatus(1000)) return true; }
  return false;
}
function atomicWrite(file, text) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, text); fs.renameSync(temp, file);
}

export async function start({root = projectRoot, preview = false, resetRecovery = false, log = console.log} = {}) {
  const at = layout(root);
  let supervisor = await supervisorStatus();
  if (supervisor && (supervisor.kind !== 'agentic-os-service-supervisor' || !samePath(supervisor.runtimeDir, at.runtime))) throw new Error('Port 3221 belongs to another installation; nothing changed.');
  if (!supervisor && listener(PORTS.supervisor)) throw new Error('An unrecognized service owns port 3221; nothing changed.');
  fs.mkdirSync(at.runtime, {recursive: true});
  if (resetRecovery && supervisor) atomicWrite(at.pause, '{"reason":"explicit recovery reset"}');
  // A paused monitor may still be exiting. Do not clear its marker until it leaves.
  if (supervisor && fs.existsSync(at.pause)) {
    if (!await waitForSupervisorExit()) throw new Error('The recovery monitor is still pausing; try again shortly.');
    supervisor = null;
  }
  if (resetRecovery) fs.rmSync(at.recoveryState, {force: true});
  const speechUrl = process.env.AOS_V2_SPEECH_URL || await healthySpeech();
  const ownSpeech = speechInstalled(at) && (!speechUrl || speechUrl === local(PORTS.speech));
  let services = desiredServices(at, {speechUrl: speechUrl || (ownSpeech ? local(PORTS.speech) : null), vault: configuredVaultPath(at), preview, jarvisBuilt: fs.existsSync(at.buildId), ownSpeech});
  if (supervisor && services.some(service => !supervisor.services.some(known => known.id === service.id))) {
    // Reconfigure the monitor alone when an existing installation adds a service.
    atomicWrite(at.pause, '{"reason":"recovery services changed"}');
    if (!await waitForSupervisorExit()) throw new Error('The recovery monitor is still reconfiguring; try again shortly.');
    supervisor = null;
  }
  if (!supervisor) {
    services = mergePrior(services, fs.existsSync(at.config) ? readJson(at.config) : null, at.runtime);
    atomicWrite(at.config, JSON.stringify({runtimeDir: at.runtime, lockPort: PORTS.supervisor, services}, null, 1));
  }
  fs.rmSync(at.pause, {force: true});
  if (supervisor) { log('Recovery is already running. Existing services and conversations were retained.'); return {started: false}; }
  // A login item owns the monitor when one is installed, so it survives this shell.
  const owner = autostartOwner(at);
  if (owner === 'other') throw new Error('A different installation owns the recovery login item.');
  if (!(owner === 'ours' && kickAutostart(at))) {
    const child = spawn(process.execPath, [at.supervisor, '--config', at.config], {cwd: at.root, detached: true, windowsHide: true, stdio: 'ignore'});
    child.unref();
  }
  for (let attempt = 0; attempt < 24; attempt++) {
    await sleep(500);
    const ready = await supervisorStatus(1000);
    if (ready && samePath(ready.runtimeDir, at.runtime)) { log('Local service recovery is active on 127.0.0.1:3221.'); return {started: true}; }
  }
  throw new Error('The recovery monitor did not become available. Inspect .runtime/service-supervisor.jsonl.');
}

export async function waitForServices(ids, {timeoutMs = 120000} = {}) {
  const deadline = Date.now() + timeoutMs;
  let pending = ids;
  while (Date.now() < deadline) {
    const status = await supervisorStatus();
    pending = ids.filter(id => status?.services?.find(service => service.id === id)?.phase !== 'online');
    if (status && !pending.length) return [];
    await sleep(1500);
  }
  return pending;
}

export async function status({root = projectRoot} = {}) {
  void layout(root);
  return {bridge: await tryJson(`${local(PORTS.bridge)}/services`, {timeoutMs: 5000}), supervisor: await supervisorStatus()};
}

// Pure: is this listener exactly the command this checkout launches for that service?
export function ownedBy(info, script, options = {}) {
  return !!info && !info.ambiguous && commandRuns(info.commandLine, script, options);
}
const PYTHON = /(^|\/)python[\d.]*(\.exe)?$/i;

export async function stop({root = projectRoot, log = console.log, find = listener, inspect = processInfo, cwdOf = processCwd, kill = pid => process.kill(pid), get = tryJson, post = fetchJson} = {}) {
  const at = layout(root);
  const vault = configuredVaultPath(at);
  if (!vault) throw new Error('This installation has no configured vault; nothing stopped.');
  const state = await get(`${local(PORTS.bridge)}/state`);
  // Fail closed before stopping any service: no unsent CLI drafts or active agents discarded.
  if (!state) throw new Error('Bridge is unavailable, so task state cannot be verified. No service was stopped.');
  if (!samePath(state.vault, vault)) throw new Error('The bridge belongs to another vault; nothing stopped.');
  const work = await get(`${local(PORTS.bridge)}/work`);
  if (!work || (work.tasks || []).some(task => task.pid || OPEN_STATES.has(task.state))) throw new Error('Stop active tasks in Terminals first. No service was stopped.');
  const expected = [
    {name: 'bridge', port: PORTS.bridge, script: at.bridge},
    {name: 'preview', port: PORTS.preview, script: at.preview},
    {name: 'jarvis', port: PORTS.jarvis, script: at.next, after: /^"?\s+start\s+--hostname 127\.0\.0\.1 --port 3217(\s|$)/},
    {name: 'speech', port: PORTS.speech, script: at.speechScript, interpreter: PYTHON, flags: ['-u'], after: /^"?\s+--assets\s/, optional: true},
  ];
  // Next renames its process on macOS and Linux, so the command line no longer names the script.
  // Two other proofs are accepted: OUR monitor started exactly this pid, or it is a next-server
  // whose working directory is this checkout's HUD.
  const monitor = await get(`${local(PORTS.supervisor)}/status`, {timeoutMs: 2000});
  const monitored = monitor?.kind === 'agentic-os-service-supervisor' && samePath(monitor.runtimeDir, at.runtime) ? monitor.services || [] : [];
  const proven = (service, info) => ownedBy(info, service.script, service)
    || (!info.ambiguous && Number.isSafeInteger(info.pid) && /^(node|next-server|python)/i.test(info.name || '') && monitored.some(item => item.id === service.name && item.pid === info.pid))
    || (service.name === 'jarvis' && !info.ambiguous && /^next-server\b/.test(info.commandLine || '') && samePath(cwdOf(info.pid) || '', at.jarvis));
  const targets = [];
  for (const service of expected) {
    const info = find(service.port);
    if (!info) continue;
    if (!proven(service, info)) {
      // Speech may be a shared service from another installation: leave it alone.
      if (service.optional) continue;
      throw new Error(`Unexpected process on ${service.port}; nothing stopped.`);
    }
    if (service.name === 'jarvis') {
      const web = await get(`${local(PORTS.jarvis)}/api/state`, {timeoutMs: 5000});
      if (!web || !samePath(web.vault_root, state.vault)) throw new Error('Jarvis belongs to another vault; nothing stopped.');
    }
    targets.push({...service, pid: info.pid, startedAt: info.startedAt});
  }
  const token = readJson(at.auth).token;
  const shutdown = await post(`${local(PORTS.bridge)}/shutdown`, {method: 'POST', headers: {'X-V2-Token': token}, body: {}, timeoutMs: 5000});
  if (!shutdown.ok) throw new Error(shutdown.data?.error || 'The bridge refused to stop; nothing stopped.');
  for (const target of targets.filter(item => item.name !== 'bridge')) {
    // Process ids are reused: stop only the exact process verified above.
    const current = inspect(target.pid);
    if (current && current.startedAt === target.startedAt) { try { kill(target.pid); log(`Stopped ${target.name}.`); } catch { log(`Could not stop ${target.name} (${target.pid}).`); } }
  }
  log('Idle services stopped; automatic recovery is paused. Saved conversations and message-box drafts are retained. Run `node aos.mjs start` to start again.');
  return {stopped: targets.map(target => target.name)};
}
