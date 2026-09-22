// The Python the Obsidian Terminal plugin needs for conversations inside Obsidian. Terminal runs a
// small helper through `pythonExecutable`: on Windows it keeps the console sized to the pane
// (imports psutil and pywinctl), on macOS/Linux the shell itself is started through it (standard
// library only). A fresh computer has neither, so setup keeps a small managed environment in
// .runtime/terminal-venv and records it in .runtime/terminal-python.json ONLY after a successful
// check. The bridge hands that path to the plugin with each launch; no record, no override.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {findPython, pythonSupported, parsePythonVersion} from './speech.mjs';
import {processesUsing} from './platform.mjs';
import {terminalVenv, terminalPythonPath, terminalMarker, recordedTerminalPython} from '../../runner/terminal-python-record.mjs';
export {terminalVenv, terminalPythonPath, terminalMarker, recordedTerminalPython};

// The helper is standard-library-only on macOS/Linux and psutil/pywinctl ship wheels for 3.9-3.14;
// macOS command-line tools provide 3.9.
export const TERMINAL_PYTHON = {min: 9, max: 14};
export const TERMINAL_PACKAGES = ['psutil==7.2.2', 'pywinctl==0.4.1'];
const checkArgs = platform => ['-c', platform === 'win32' ? 'import psutil, pywinctl' : 'import pty, selectors'];

// Pure-ish health check shared with the doctor: the interpreter runs and imports what the helper needs.
export function terminalPythonWorks(python, {run = spawnSync, platform = process.platform} = {}) {
  return fs.existsSync(python) && run(python, checkArgs(platform), {encoding: 'utf8', timeout: 30000, windowsHide: true}).status === 0;
}

// 'ready' | 'installed' | 'no-python' | 'deferred' | 'failed'. Never throws: conversations still run
// in Jarvis. The environment is only created, repaired or replaced when nothing runs from it
// (conversations open inside Obsidian run their helper from it); unknown counts as in use.
export function prepareTerminalPython(at, {log = console.log, run = spawnSync, platform = process.platform, find = options => findPython({run, platform, range: TERMINAL_PYTHON, ...options}),
  inUse = dir => processesUsing(dir, {platform}), rename = fs.renameSync, now = Date.now} = {}) {
  const python = terminalPythonPath(at.runtime, platform), marker = terminalMarker(at.runtime), venv = terminalVenv(at.runtime);
  const check = () => terminalPythonWorks(python, {run, platform});
  const record = () => { const temporary = `${marker}.${process.pid}.tmp`; fs.writeFileSync(temporary, JSON.stringify({version: 1, python, verifiedAt: new Date().toISOString()})); fs.renameSync(temporary, marker); };
  try {
    if (recordedTerminalPython(at.runtime, {platform}) && check()) return 'ready';
    // Invalidate first: a failed repair must never leave an old record pointing at a broken environment.
    fs.rmSync(marker, {force: true});
    if (check()) { record(); log('-> Conversations inside Obsidian: Python helper ready'); return 'installed'; }
    if (fs.existsSync(venv)) {
      const users = inUse(venv);
      if (users === null || users.length) { log('-> Conversations inside Obsidian: the Python helper needs repairing, but a conversation inside Obsidian may be using it. Close those conversations and run `node aos.mjs setup` again; meanwhile use the same buttons in Jarvis.'); return 'deferred'; }
    }
    const seen = [], base = find({seen});
    const current = fs.existsSync(python) ? run(python, ['--version'], {encoding: 'utf8', timeout: 10000, windowsHide: true}) : null;
    const currentOk = current?.status === 0 && pythonSupported(parsePythonVersion(current.stdout || current.stderr), TERMINAL_PYTHON);
    if (!currentOk) {
      if (!base) { log(`-> Conversations inside Obsidian: no usable Python found${seen.length ? ` (found ${seen.join(', ')})` : ''}. Install Python 3.12 (Windows: \`winget install Python.Python.3.12\`; Mac: \`xcode-select --install\` or \`brew install python@3.12\`) and run setup again, or use the same buttons in Jarvis.`); return 'no-python'; }
      if (fs.existsSync(venv)) {
        // Moved away first: Windows refuses to rename a folder a running program uses, so nothing is half-deleted.
        const aside = `${venv}.old-${now()}`;
        try { rename(venv, aside); } catch { log('-> Conversations inside Obsidian: the Python helper is in use; close conversations inside Obsidian and run `node aos.mjs setup` again.'); return 'deferred'; }
        try { fs.rmSync(aside, {recursive: true, force: true}); } catch { /* removed by a later setup */ }
      }
      const made = run(base.command, [...base.prefix, '-m', 'venv', venv], {encoding: 'utf8', timeout: 5 * 60 * 1000, windowsHide: true});
      if (made.status !== 0) throw new Error(String(made.stderr || made.stdout || made.error?.message || 'venv failed').trim().split(/\r?\n/).slice(-3).join(' | '));
    }
    if (platform === 'win32') {
      const installed = run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '--prefer-binary', ...TERMINAL_PACKAGES], {encoding: 'utf8', timeout: 10 * 60 * 1000, windowsHide: true, maxBuffer: 16 * 1024 * 1024});
      if (installed.status !== 0) throw new Error(String(installed.stderr || installed.stdout || installed.error?.message || 'pip failed').trim().split(/\r?\n/).slice(-3).join(' | '));
    }
    if (!check()) throw new Error('the helper modules did not load');
    record();
    log('-> Conversations inside Obsidian: Python helper ready');
    return 'installed';
  } catch (error) {
    fs.rmSync(marker, {force: true});
    log(`-> Conversations inside Obsidian: the Python helper could not be prepared (${String(error.message || error).slice(0, 300)}). Run setup again later, or use the same buttons in Jarvis.`);
    return 'failed';
  }
}
