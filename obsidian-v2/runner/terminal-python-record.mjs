// Where setup keeps the managed Python for the Obsidian Terminal plugin, and the record it writes
// only after that Python passed its check (scripts/aos/terminal-python.mjs). The bridge hands the
// recorded path to the plugin with each native launch; without a valid record it hands nothing.
import fs from 'node:fs';
import path from 'node:path';

export const terminalVenv = runtime => path.join(runtime, 'terminal-venv');
export const terminalPythonPath = (runtime, platform = process.platform) => platform === 'win32' ? path.join(terminalVenv(runtime), 'Scripts', 'python.exe') : path.join(terminalVenv(runtime), 'bin', 'python');
export const terminalMarker = runtime => path.join(runtime, 'terminal-python.json');
const same = (a, b, platform) => { const norm = value => path.resolve(String(value)).replace(/[\\/]+$/, ''); return platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b); };

// The recorded interpreter when the record is valid, names this installation's own managed
// interpreter and that file still exists; otherwise null.
export function recordedTerminalPython(runtime, {platform = process.platform, exists = fs.existsSync, read = fs.readFileSync} = {}) {
  let record; try { record = JSON.parse(String(read(terminalMarker(runtime), 'utf8')).replace(/^﻿/, '')); } catch { return null; }
  if (record?.version !== 1 || typeof record.python !== 'string' || !same(record.python, terminalPythonPath(runtime, platform), platform) || !exists(record.python)) return null;
  return record.python;
}
