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
export const pythonSupported = version => !!version && version.major === 3 && version.minor >= 10;

export function findPython({env = process.env, run = spawnSync, platform = process.platform} = {}) {
  // Homebrew's python@3.12 keeps its generic aliases outside the usual bin directory.
  const versioned = platform === 'darwin' ? [['python3.12']] : [];
  const candidates = [env.AOS_V2_PYTHON && [env.AOS_V2_PYTHON], ...(platform === 'win32' ? [['py', '-3'], ['python']] : [['python3'], ['python']]), ...versioned].filter(Boolean);
  for (const [command, ...prefix] of candidates) {
    const file = path.isAbsolute(command) ? command : which(command, {env, platform});
    // Windows ships a `python.exe` stub that only opens the Store; a real one answers --version.
    const result = file ? run(file, [...prefix, '--version'], {encoding: 'utf8', timeout: 10000, windowsHide: true}) : null;
    const version = result && result.status === 0 ? parsePythonVersion(result.stdout || result.stderr) : null;
    if (pythonSupported(version)) return {command: file, prefix, version: version.text};
  }
  return null;
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

export async function setupSpeech(at, {log = console.log, run = spawnSync} = {}) {
  const step = (label, command, args, timeout) => {
    log(`  ${label}`);
    const result = run(command, args, {encoding: 'utf8', timeout, windowsHide: true, cwd: at.root, maxBuffer: 32 * 1024 * 1024});
    if (result.status !== 0) throw new Error(`${label} failed: ${String(result.stderr || result.stdout || result.error?.message || '').trim().split(/\r?\n/).slice(-6).join(' | ').slice(0, 900)}`);
  };
  fs.mkdirSync(at.runtime, {recursive: true});
  if (!fs.existsSync(at.speechPython)) {
    const python = findPython();
    if (!python) throw new Error('Python 3.10 or newer was not found. Install it (Windows: python.org, tick "Add to PATH"; Mac: `brew install python@3.12`) and run this again. If already installed, set AOS_V2_PYTHON to its absolute executable path.');
    step(`creating the voice environment with Python ${python.version}`, python.command, [...python.prefix, '-m', 'venv', at.venv], 5 * 60 * 1000);
  }
  step('installing voice packages (a few minutes the first time)', at.speechPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', path.join(at.root, 'runner', 'speech-requirements.txt')], 30 * 60 * 1000);
  fs.mkdirSync(at.speechAssets, {recursive: true});
  for (const asset of SPEECH_ASSETS) await download(`${RELEASE}/${asset.name}`, path.join(at.speechAssets, asset.name), asset.minBytes, log);
  // The service loads Whisper with local_files_only, so the model is fetched once here.
  step('fetching the speech-recognition model (about 460 MB the first time)', at.speechPython,
    ['-c', "from faster_whisper import WhisperModel; WhisperModel('small.en', device='cpu', compute_type='int8'); print('ready')"], 40 * 60 * 1000);
  return true;
}
