import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const DEFAULTS = {lockPort:3221, intervalMs:5000, probeTimeoutMs:1000, failureThreshold:3,
  backoffBaseMs:2000, backoffMaxMs:60000, restartLimit:5, restartWindowMs:300000, stableMs:60000};

export function supervisorConfig(input) {
  if (!input || typeof input !== 'object' || !path.isAbsolute(input.runtimeDir || '')) throw new Error('Absolute runtimeDir required');
  const config = {...DEFAULTS, ...input, runtimeDir:path.resolve(input.runtimeDir)};
  for (const key of Object.keys(DEFAULTS)) if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`Invalid ${key}`);
  if (config.lockPort > 65535) throw new Error('Invalid lockPort');
  if (!Array.isArray(config.services) || !config.services.length || config.services.length > 8) throw new Error('One to eight services required');
  const ids = new Set(), ports = new Set([config.lockPort]);
  config.services = config.services.map(service => {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(service.id || '') || ids.has(service.id)) throw new Error('Invalid or duplicate service id');
    if (!Number.isSafeInteger(service.port) || service.port < 1 || service.port > 65535 || ports.has(service.port)) throw new Error('Invalid or duplicate service port');
    if (!path.isAbsolute(service.command || '') || !path.isAbsolute(service.cwd || '')) throw new Error('Absolute service command and cwd required');
    if (!Array.isArray(service.args) || service.args.some(arg => typeof arg !== 'string')) throw new Error('Service args must be strings');
    if (service.env != null && (typeof service.env !== 'object' || Array.isArray(service.env) || Object.values(service.env).some(value => typeof value !== 'string'))) throw new Error('Invalid service environment');
    ids.add(service.id); ports.add(service.port);
    return {...service, args:[...service.args], env:{...service.env}};
  });
  return config;
}

// Any listening service owns its port, even if it is unhealthy or unfamiliar.
// Opening a TCP connection avoids invoking metrics, models, authentication, or vault reads.
export function portReachable(port, timeoutMs) {
  return new Promise(resolve => {
    const socket = net.createConnection({host:'127.0.0.1', port});
    let settled = false;
    const finish = result => { if (!settled) { settled = true; socket.destroy(); resolve(result); } };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

function atomicJson(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data)}\n`);
  fs.renameSync(temp, file);
}

function readJson(file) {
  // Windows PowerShell 5 writes a BOM with its standard UTF-8 file encoding.
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

export async function startSupervisor(input, options = {}) {
  const config = supervisorConfig(input);
  const pauseFile = path.join(config.runtimeDir, 'services-paused.json');
  const stateFile = path.join(config.runtimeDir, 'service-recovery-state.json');
  const logFile = path.join(config.runtimeDir, 'service-supervisor.jsonl');
  const states = config.services.map(service => ({service, child:null, phase:'checking', failures:0,
    starts:[], nextStartAt:0, blocked:false, healthySince:0, lastExitCode:null, lastExitSignal:null, lastSpawnErrorCode:null}));
  let running = false, timer, closing, closedResolve;
  const closed = new Promise(resolve => { closedResolve = resolve; });
  const snapshot = () => ({kind:'agentic-os-service-supervisor', version:1, pid:process.pid,
    runtimeDir:config.runtimeDir, paused:fs.existsSync(pauseFile),
    services:states.map(state => ({id:state.service.id, port:state.service.port, phase:state.phase,
      pid:state.child?.pid ?? null, failures:state.failures, attempts:state.starts.length,
      retryAt:state.nextStartAt || null, blocked:state.blocked,
      lastExitCode:state.lastExitCode, lastExitSignal:state.lastExitSignal, lastSpawnErrorCode:state.lastSpawnErrorCode}))});
  const server = http.createServer((req, res) => {
    const localHost = req.headers.host === `127.0.0.1:${config.lockPort}` || req.headers.host === `localhost:${config.lockPort}`;
    if (!localHost || req.headers.origin) { res.writeHead(403); res.end(); return; }
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405, {'Allow':'GET, HEAD'}); res.end(); return; }
    if (!['/status','/health'].includes(req.url)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {'Content-Type':'application/json', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(req.url === '/health' ? {ok:true} : snapshot()));
  });
  // The exclusive loopback listener is the ownership lock. Nothing is written,
  // probed, or started until it has been acquired successfully.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({host:'127.0.0.1', port:config.lockPort, exclusive:true}, () => { server.removeListener('error', reject); resolve(); });
  });
  const log = (event, details = {}) => {
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size >= 256 * 1024) fs.renameSync(logFile, `${logFile}.previous`);
      fs.appendFileSync(logFile, `${JSON.stringify({at:new Date().toISOString(), event, ...details})}\n`);
    } catch { /* Recovery does not depend on diagnostic log availability. */ }
  };
  const save = () => atomicJson(stateFile, {version:1, services:Object.fromEntries(states.map(state => [state.service.id,
    {starts:state.starts, nextStartAt:state.nextStartAt, blocked:state.blocked}]))});
  const stop = async ({pause=false, reason='stopped', exitCode=0} = {}) => {
    if (closing) return closing;
    running = false;
    clearTimeout(timer);
    if (pause) atomicJson(pauseFile, {at:new Date().toISOString(), reason:'manual supervisor stop'});
    log('stop', {reason});
    closing = new Promise(resolve => {
      server.close(() => { closedResolve({reason, exitCode}); resolve(); });
      server.closeAllConnections?.();
    });
    // Deliberately leave all services and agent tasks alone.
    return closing;
  };
  const delay = state => Math.min(config.backoffMaxMs, config.backoffBaseMs * 2 ** Math.min(20, Math.max(0, state.starts.length - 1)));
  const failedChild = (state, child, code, signal, spawnErrorCode = null) => {
    if (state.child !== child) return;
    state.child = null;
    if (!running) return;
    state.lastExitCode = Number.isInteger(code) ? code : null;
    state.lastExitSignal = typeof signal === 'string' ? signal : null;
    state.lastSpawnErrorCode = typeof spawnErrorCode === 'string' && /^[A-Z0-9_]{1,40}$/.test(spawnErrorCode) ? spawnErrorCode : null;
    state.nextStartAt = Date.now() + delay(state);
    state.healthySince = 0;
    state.phase = 'backoff';
    log('child_exit', {id:state.service.id, code:state.lastExitCode, signal:state.lastExitSignal, spawnErrorCode:state.lastSpawnErrorCode});
    try { save(); } catch { void stop({reason:'state_write_failed', exitCode:1}); }
  };
  const tick = async () => {
    if (!running) return;
    if (fs.existsSync(pauseFile)) { await stop({reason:'pause_marker'}); return; }
    const results = await Promise.all(states.map(async state => [state, await portReachable(state.service.port, config.probeTimeoutMs)]));
    if (!running) return;
    if (fs.existsSync(pauseFile)) { await stop({reason:'pause_marker'}); return; }
    const now = Date.now();
    for (const [state, reachable] of results) {
      if (reachable) {
        if (state.phase !== 'online') log('online', {id:state.service.id, managed:!!state.child});
        state.phase = 'online'; state.failures = 0;
        state.healthySince ||= now;
        if (now - state.healthySince >= config.stableMs && (state.starts.length || state.blocked || state.nextStartAt)) {
          state.starts = []; state.blocked = false; state.nextStartAt = 0; save();
        }
        continue;
      }
      state.healthySince = 0;
      state.failures = Math.min(config.failureThreshold, state.failures + 1);
      // A live child may be starting slowly or stuck. Neither condition permits
      // launching a competing process or killing work it might be handling.
      if (state.child) { state.phase = 'waiting_for_listener'; continue; }
      if (state.blocked) { state.phase = 'blocked'; continue; }
      if (state.failures < config.failureThreshold) { state.phase = 'checking'; continue; }
      if (now < state.nextStartAt) { state.phase = 'backoff'; continue; }
      state.starts = state.starts.filter(time => now - time < config.restartWindowMs);
      if (state.starts.length >= config.restartLimit) {
        state.blocked = true; state.phase = 'blocked'; save(); log('restart_budget_exhausted', {id:state.service.id}); continue;
      }
      // Recheck immediately before spawning to narrow an external-launch race.
      if (await portReachable(state.service.port, config.probeTimeoutMs)) continue;
      if (!running || fs.existsSync(pauseFile)) break;
      state.starts.push(Date.now()); state.nextStartAt = Date.now() + delay(state); save();
      const child = spawn(state.service.command, state.service.args, {cwd:state.service.cwd,
        env:{...process.env, ...state.service.env}, detached:true, windowsHide:true, stdio:'ignore'});
      state.child = child; state.phase = 'starting'; state.failures = 0;
      child.once('error', error => failedChild(state, child, null, null, error.code));
      child.once('exit', (code, signal) => failedChild(state, child, code, signal));
      child.unref();
      log('start', {id:state.service.id, pid:child.pid ?? null, attempt:state.starts.length});
    }
    if (running) timer = setTimeout(() => { void tick().catch(() => stop({reason:'supervisor_error', exitCode:1})); }, config.intervalMs);
  };
  try {
    fs.mkdirSync(config.runtimeDir, {recursive:true});
    if (!options.resetRecovery && fs.existsSync(stateFile)) {
      const saved = readJson(stateFile);
      if (saved.version !== 1 || !saved.services || typeof saved.services !== 'object') throw new Error('Invalid recovery state');
      for (const state of states) {
        const prior = saved.services[state.service.id];
        if (!prior) continue;
        if (!Array.isArray(prior.starts) || prior.starts.some(time => !Number.isFinite(time)) || prior.starts.length > 1000 || !Number.isFinite(prior.nextStartAt) || typeof prior.blocked !== 'boolean') throw new Error('Invalid recovery state');
        state.starts = prior.starts; state.nextStartAt = prior.nextStartAt; state.blocked = prior.blocked;
      }
    }
    if (options.resetRecovery) save();
    running = true;
    log('boot', {pid:process.pid});
    await tick();
  } catch (error) {
    await stop({reason:'startup_error', exitCode:1});
    throw error;
  }
  return {config, snapshot, stop, closed};
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--config');
  if (at < 0 || !args[at + 1]) throw new Error('Use --config <absolute JSON file>');
  const supervisor = await startSupervisor(readJson(args[at + 1]), {resetRecovery:args.includes('--reset-recovery')});
  const signal = () => { void supervisor.stop({pause:true, reason:'signal'}).catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', signal); process.once('SIGTERM', signal);
  const result = await supervisor.closed;
  process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Service recovery could not start (${error.code || 'configuration or runtime error'}).`); process.exitCode = 1; });
}
