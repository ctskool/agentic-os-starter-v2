// Local voice: a private Python environment, the Kokoro voice files and a
// cached Whisper model, all inside .runtime/. Safe to re-run; finished parts are skipped.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {which} from './platform.mjs';

const RELEASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0';
export const SPEECH_ASSETS = [{name: 'kokoro-v1.0.onnx', minBytes: 200e6}, {name: 'voices-v1.0.bin', minBytes: 10e6}];

export function parsePythonVersion(text) {
  const match = String(text || '').match(/Python (\d+)\.(\d+)\.(\d+)/);
  return match ? {major: +match[1], minor: +match[2], text: `${match[1]}.${match[2]}.${match[3]}`} : null;
}
// Voice: the speech libraries (kokoro-onnx 0.6.x: Python <3.14) support 3.10-3.13. Python.org and
// Homebrew default to newer releases, so the upper bound is checked, not assumed.
export const VOICE_PYTHON = {min: 10, max: 13};
export const pythonSupported = (version, range = VOICE_PYTHON) => !!version && version.major === 3 && version.minor >= range.min && version.minor <= range.max;

// Versioned interpreters first, preferring the 3.12 the setup guide installs, so a newer default
// `py -3` / `python3` never wins over a supported one that is also present.
const PREFERRED_MINORS = [12, 13, 11, 10];
export function pythonCandidates({env = process.env, platform = process.platform} = {}) {
  const versioned = PREFERRED_MINORS.map(minor => platform === 'win32' ? ['py', `-3.${minor}`] : [`python3.${minor}`]);
  return [env.AOS_V2_PYTHON && [env.AOS_V2_PYTHON], ...versioned, ...(platform === 'win32' ? [['py', '-3'], ['python']] : [['python3'], ['python']])].filter(Boolean);
}

// {command, prefix, version} for the first supported interpreter; null otherwise, with every
// working interpreter's version added to `seen`, so the caller can say what it found instead.
export function findPython({env = process.env, run = spawnSync, platform = process.platform, range = VOICE_PYTHON, seen = []} = {}) {
  for (const [command, ...prefix] of pythonCandidates({env, platform})) {
    const file = path.isAbsolute(command) ? command : which(command, {env, platform});
    // Windows ships a `python.exe` stub that only opens the Store; a real one answers --version.
    const result = file ? run(file, [...prefix, '--version'], {encoding: 'utf8', timeout: 10000, windowsHide: true}) : null;
    const version = result && result.status === 0 ? parsePythonVersion(result.stdout || result.stderr) : null;
    if (version && !seen.includes(version.text)) seen.push(version.text);
    if (pythonSupported(version, range)) return {command: file, prefix, version: version.text};
  }
  return null;
}

export function voicePythonMissing(seen = []) {
  const install = 'Install Python 3.12 (Windows: `winget install Python.Python.3.12`; Mac: `brew install python@3.12`) and run this again. If it is installed somewhere unusual, set AOS_V2_PYTHON to its absolute executable path.';
  return seen.length
    ? `Found Python ${seen.join(', ')}, but voice needs Python 3.10-3.13 (its speech libraries do not support newer versions yet). ${install}`
    : `Python 3.10-3.13 was not found. ${install}`;
}

// The version an existing environment's interpreter reports, or null when it does not answer.
export function venvVersion(python, {run = spawnSync, exists = fs.existsSync} = {}) {
  if (!exists(python)) return null;
  const result = run(python, ['--version'], {encoding: 'utf8', timeout: 10000, windowsHide: true});
  return result.status === 0 ? parsePythonVersion(result.stdout || result.stderr) : null;
}

// A voice environment built with an unsupported Python (a 3.14 install got an old, untested voice
// library) is set aside and rebuilt, but only when it is PROVEN that nothing uses it:
//   busy()      - a reason when this installation's monitor or voice port is still up, else null
//   inUse(dir)  - pids running from `dir`, or null when that cannot be read (unknown = in use)
// Result: 'not-needed' | 'no-python' | 'deferred' (both with .reason) | 'set-aside'.
// Nothing is moved before a supported interpreter is found; a failed rename (Windows locks a
// running interpreter's folder) also defers.
export const voiceRebuildMarker = at => path.join(at.runtime, 'voice-rebuild-pending.json');
export const VOICE_BUSY = 'The voice environment was made with an unsupported Python and needs rebuilding, but the voice service may still be running. Run `node aos.mjs stop`, then `node aos.mjs setup --voice yes`.';
export async function setAsideUnsupportedVoice(at, {run = spawnSync, find = options => findPython({run, ...options}), busy, inUse, rename = fs.renameSync, remove = fs.rmSync, now = Date.now, log = console.log} = {}) {
  if (!fs.existsSync(at.speechPython)) return {state: 'not-needed'};
  const current = venvVersion(at.speechPython, {run});
  if (pythonSupported(current)) return {state: 'not-needed'};
  const seen = [];
  if (!find({seen})) return {state: 'no-python', reason: voicePythonMissing(seen)};
  if (await busy()) return {state: 'deferred', reason: VOICE_BUSY};
  const users = inUse(at.venv);
  if (users === null || users.length) return {state: 'deferred', reason: VOICE_BUSY};
  const aside = `${at.venv}.old-${now()}`;
  // Written before the move and cleared only after the replacement installed: a failed rebuild is
  // retried by the next ordinary setup or update instead of passing for an installed voice.
  fs.writeFileSync(voiceRebuildMarker(at), JSON.stringify({since: new Date(now()).toISOString()}));
  try { rename(at.venv, aside); } catch { fs.rmSync(voiceRebuildMarker(at), {force: true}); return {state: 'deferred', reason: VOICE_BUSY}; }
  log(`  the voice environment used Python ${current?.text || '(not answering)'}; it was set aside and will be rebuilt`);
  // Kept until the replacement installed successfully (the caller then calls removeSetAsideVoice).
  return {state: 'set-aside', aside};
}

// Environments set aside earlier are removed once nothing runs from them (unknown = keep).
export function removeSetAsideVoice(at, {inUse, remove = fs.rmSync} = {}) {
  const dir = path.dirname(at.venv), base = path.basename(at.venv) + '.old-';
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.startsWith(base)) continue;
    const full = path.join(dir, name), users = inUse(full);
    if (users === null || users.length) continue;
    try { remove(full, {recursive: true, force: true}); } catch { /* try again next time */ }
  }
}

async function download(url, target, minBytes, log) {
  if (fs.existsSync(target) && fs.statSync(target).size >= minBytes) { log(`  already have ${path.basename(target)}`); return; }
  log(`  downloading ${path.basename(target)} ...`);
  const response = await fetch(url, {redirect: 'follow', signal: AbortSignal.timeout(30 * 60 * 1000)});
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${path.basename(target)}`);
  const part = `${target}.part`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(part));
  if (fs.statSync(part).size < minBytes) { fs.rmSync(part, {force: true}); throw new Error(`${path.basename(target)} arrived incomplete; run the command again.`); }
  fs.renameSync(part, target);
}

export async function setupSpeech(at, {log = console.log, run = spawnSync, find = options => findPython({run, ...options})} = {}) {
  const step = (label, command, args, timeout) => {
    log(`  ${label}`);
    const result = run(command, args, {encoding: 'utf8', timeout, windowsHide: true, cwd: at.root, maxBuffer: 32 * 1024 * 1024});
    if (result.status !== 0) throw new Error(`${label} failed: ${String(result.stderr || result.stdout || result.error?.message || '').trim().split(/\r?\n/).slice(-6).join(' | ').slice(0, 900)}`);
  };
  fs.mkdirSync(at.runtime, {recursive: true});
  if (!fs.existsSync(at.speechPython)) {
    const seen = [], python = find({seen});
    if (!python) throw new Error(voicePythonMissing(seen));
    step(`creating the voice environment with Python ${python.version}`, python.command, [...python.prefix, '-m', 'venv', at.venv], 5 * 60 * 1000);
  } else if (!pythonSupported(venvVersion(at.speechPython, {run}))) {
    // Reached only when the caller did not set the old environment aside (it may be in use).
    throw new Error('The voice environment was made with an unsupported Python. Run `node aos.mjs stop`, then `node aos.mjs setup --voice yes` to rebuild it.');
  }
  // Exact pins for our direct packages, bounds for the heavy ones; prefer published wheels over building.
  step('installing voice packages (a few minutes the first time)', at.speechPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '--prefer-binary', '-r', path.join(at.root, 'runner', 'speech-requirements.txt')], 30 * 60 * 1000);
  fs.mkdirSync(at.speechAssets, {recursive: true});
  for (const asset of SPEECH_ASSETS) await download(`${RELEASE}/${asset.name}`, path.join(at.speechAssets, asset.name), asset.minBytes, log);
  // The service loads Whisper with local_files_only, so the model is fetched once here.
  step('fetching the speech-recognition model (about 460 MB the first time)', at.speechPython,
    ['-c', "from faster_whisper import WhisperModel; WhisperModel('small.en', device='cpu', compute_type='int8'); print('ready')"], 40 * 60 * 1000);
  return true;
}
