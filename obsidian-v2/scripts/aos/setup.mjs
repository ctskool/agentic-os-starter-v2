// `aos setup` and `aos update`. Every step can be run again: finished work is
// detected and skipped, notes are never overwritten, and a failed HUD build
// puts the previous build back.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {projectRoot} from '../../runner/runtime.mjs';
import {isWindows, tryJson, sleep, listener, samePath} from './platform.mjs';
import {layout, start, stop, waitForServices, speechInstalled, bridgeIsOurs, hudIsOurs, PORTS} from './services.mjs';
import {enableAutostart} from './autostart.mjs';
import {setupSpeech} from './speech.mjs';
import {scaffoldVault} from './vault.mjs';
import {doctor} from './doctor.mjs';

const hashOf = file => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : '';

function runStep(label, command, args, {cwd, log, timeout = 30 * 60 * 1000, shell = false}) {
  log(`-> ${label}`);
  const result = spawnSync(command, args, {cwd, encoding: 'utf8', timeout, windowsHide: true, shell, maxBuffer: 64 * 1024 * 1024});
  if (result.status !== 0) throw new Error(`${label} failed:\n${String(result.stderr || result.stdout || result.error?.message || '').trim().split(/\r?\n/).slice(-15).join('\n')}`);
  return result.stdout;
}
const npm = (label, args, cwd, log) => runStep(label, isWindows ? 'npm.cmd' : 'npm', args, {cwd, log, shell: isWindows});

// Installs only when the lockfile changed since the last successful install.
function installPackages(dir, label, log, stamps) {
  const lock = hashOf(path.join(dir, 'package-lock.json'));
  if (fs.existsSync(path.join(dir, 'node_modules')) && stamps[label] === lock) { log(`-> ${label}: packages already installed`); return false; }
  npm(`${label}: installing packages`, ['ci', '--no-audit', '--no-fund'], dir, log);
  stamps[label] = lock;
  return true;
}

function buildHud(at, log) {
  const current = path.join(at.jarvis, '.next'), previous = path.join(at.runtime, 'next-previous');
  fs.rmSync(previous, {recursive: true, force: true});
  if (fs.existsSync(current)) fs.renameSync(current, previous);
  try { npm('Jarvis HUD: building (about a minute)', ['run', 'build'], at.jarvis, log); }
  catch (error) {
    // A half-written build cannot serve; the previous one can.
    fs.rmSync(current, {recursive: true, force: true});
    if (fs.existsSync(previous)) fs.renameSync(previous, current);
    throw error;
  }
  fs.rmSync(previous, {recursive: true, force: true});
}

const readState = at => { try { return JSON.parse(fs.readFileSync(path.join(at.runtime, 'aos-setup.json'), 'utf8')); } catch { return {}; } };
const writeState = (at, state) => { fs.mkdirSync(at.runtime, {recursive: true}); fs.writeFileSync(path.join(at.runtime, 'aos-setup.json'), JSON.stringify(state, null, 1)); };

async function pauseMonitor(at) {
  if (!await tryJson(`http://127.0.0.1:${PORTS.supervisor}/status`)) return;
  fs.writeFileSync(at.pause, '{"reason":"login item change"}');
  for (let attempt = 0; attempt < 24 && await tryJson(`http://127.0.0.1:${PORTS.supervisor}/status`, {timeoutMs: 1000}); attempt++) await sleep(500);
}

// The login item must own the monitor, so hand over: pause ours, install, start through it.
// Services keep running throughout; only the monitor changes hands.
export async function startAtLogin({root = projectRoot, log = console.log} = {}) {
  const at = layout(root);
  if (!fs.existsSync(at.config)) await start({root, log});
  await pauseMonitor(at);
  log('-> ' + enableAutostart(at));
  await start({root, log});
}

// Nothing is installed, built or written into a vault until this passes: another copy of the
// system must not own the ports, and the vault must not belong to another installation.
export async function preflight(at, vault, {adopt = false, get = tryJson, find = listener, post} = {}) {
  const monitor = await get(`http://127.0.0.1:${PORTS.supervisor}/status`);
  if (monitor && !(monitor.kind === 'agentic-os-service-supervisor' && samePath(monitor.runtimeDir, at.runtime))) throw new Error('Another installation of this system (or another program) is running on port 3221. Stop it from its own folder first. Nothing was changed.');
  if (!monitor && find(PORTS.supervisor)) throw new Error('Another program is using port 3221. Nothing was changed.');
  // Whatever listens on our ports must prove it is this installation; our own monitor running is no excuse.
  if (find(PORTS.bridge) && !await bridgeIsOurs(at, post ? {post} : {})) throw new Error('Another program (or another installation of this system) is using port 3219. Stop it first. Nothing was changed.');
  if (find(PORTS.jarvis) && !await hudIsOurs(at, {get, find})) throw new Error('Another program (or another installation of this system) is using port 3217. Stop it first. Nothing was changed.');
  const marker = path.join(vault, '.obsidian', 'plugins', 'agentic-os-v2', 'terminal-runtime.json');
  let owner = null; try { owner = JSON.parse(fs.readFileSync(marker, 'utf8')).runtimeDir; } catch { /* not connected yet */ }
  if (owner && !samePath(owner, at.runtime) && !adopt) throw new Error(`This vault is already connected to another installation (${path.dirname(owner)}). Use that one, or run setup again with --adopt to move the vault to this installation. Nothing was changed.`);
}

export async function setup({root = projectRoot, vault, voice, autostart, rebuild = false, ci = false, adopt = false, log = console.log} = {}) {
  const at = layout(root), state = readState(at);
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error(`Node.js 22 or newer is required (this is ${process.versions.node}). Install the LTS from nodejs.org, open a new terminal and run setup again.`);
  if (!fs.existsSync(path.join(at.jarvis, 'package.json'))) throw new Error(`The Jarvis HUD folder is missing next to this one (${at.jarvis}). Clone the whole starter repository, not one folder.`);
  vault = vault ? path.resolve(vault) : state.vault;
  if (!vault) throw new Error('Tell setup where the vault lives: node aos.mjs setup --vault "<absolute path>"');
  await preflight(at, vault, {adopt});
  state.stamps ||= {};
  const wantVoice = voice === undefined ? state.voice === true : voice;

  const bridgeChanged = installPackages(at.root, 'Bridge and plugin', log, state.stamps);
  const hudChanged = installPackages(at.jarvis, 'Jarvis HUD', log, state.stamps);
  writeState(at, state);
  npm('Obsidian plugin: building', ['run', 'build'], at.root, log);

  const report = scaffoldVault(path.join(at.root, 'vault-template'), vault);
  log(`-> Vault ${report.newVault ? 'created' : 'completed'} at ${vault} (${report.created} file(s) added, ${report.kept} existing kept)`);
  const install = () => runStep('Obsidian plugin: installing into the vault', process.execPath, [path.join(at.root, 'scripts', 'install-live.mjs'), vault], {cwd: at.root, log});
  install();
  Object.assign(state, {vault, voice: wantVoice});
  writeState(at, state);

  if (rebuild || hudChanged || bridgeChanged || !fs.existsSync(at.buildId)) buildHud(at, log); else log('-> Jarvis HUD: already built');
  if (wantVoice && !speechInstalled(at)) { log('-> Voice: installing (about 800 MB of models the first time)'); await setupSpeech(at, {log}); }

  await start({root, log});
  if (autostart === true) await startAtLogin({root, log});
  const wanted = ['bridge', 'jarvis', ...(wantVoice && speechInstalled(at) ? ['speech'] : [])];
  log('-> Waiting for services to come up (voice models can take a minute)');
  const pending = await waitForServices(wanted, {timeoutMs: 180000});
  if (pending.length) log(`  still starting: ${pending.join(', ')}`);
  // The bridge mints its access token on first start; the plugin needs a copy.
  install();
  log('');
  return doctor({root, ci, phase: 'install', log});
}

export async function update({root = projectRoot, log = console.log} = {}) {
  const at = layout(root), repo = path.resolve(at.root, '..'), state = readState(at);
  if (!state.vault) throw new Error('Nothing is installed here yet. Run `node aos.mjs setup --vault "<path>"` first.');
  const git = args => runStep(`git ${args.join(' ')}`, 'git', args, {cwd: repo, log, timeout: 5 * 60 * 1000});
  // Stop first: packages and the HUD build are replaced on disk, and stop refuses while any task is open.
  if (await tryJson(`http://127.0.0.1:${PORTS.bridge}/state`)) await stop({root, log});
  else await pauseMonitor(at);
  git(['pull', '--ff-only']);
  return setup({root, vault: state.vault, voice: state.voice, rebuild: true, log});
}
