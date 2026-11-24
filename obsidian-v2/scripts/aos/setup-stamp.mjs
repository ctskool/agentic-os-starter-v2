// Which setup code last ran to the end on this installation, as a fingerprint of the setup code's
// own files and the release file next to them. The doctor compares it with the files on disk.
//
// Why: an update replaces the files, then has to run the NEW setup. The update command of 0.3.64
// builds from before 22 September 2026 pulled the new files and then ran the setup it had already
// loaded, the old one. Everything new that setup does (switching the buttons away from a coding tool
// that is not installed, refreshing voice packages, repairing the Mac login item) silently did not
// happen, and nothing said so. Those installations cannot be fixed from here, but the doctor of the
// new release can notice and say "run setup once".
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STATE = 'aos-setup.json';
const readState = at => { try { return JSON.parse(fs.readFileSync(path.join(at.runtime, STATE), 'utf8')); } catch { return {}; } };

// null when the setup code cannot be read (a test installation, a broken folder): nothing to compare.
export function setupFingerprint(at) {
  const scripts = path.join(at.root, 'scripts', 'aos');
  let names;
  try { names = fs.readdirSync(scripts).filter(name => name.endsWith('.mjs')).sort(); } catch { return null; }
  if (!names.length) return null;
  const hash = crypto.createHash('sha256');
  const add = (label, file) => { hash.update(`${label}\0`); try { hash.update(fs.readFileSync(file)); } catch { hash.update('missing'); } hash.update('\0'); };
  for (const name of names) add(name, path.join(scripts, name));
  add('VERSION.json', path.resolve(at.root, '..', 'VERSION.json'));
  return hash.digest('hex');
}

// Called by setup once every step has finished, just before its closing doctor run.
export function stampSetup(at) {
  const now = setupFingerprint(at);
  if (now === null) return;
  const state = readState(at);
  state.stamps = {...(state.stamps || {}), setupCode: now};
  fs.mkdirSync(at.runtime, {recursive: true});
  fs.writeFileSync(path.join(at.runtime, STATE), JSON.stringify(state, null, 1));
}

// 'current' | 'behind' (setup has not finished with these files) | 'unknown' (nothing to compare).
export function setupStatus(at) {
  const now = setupFingerprint(at);
  if (now === null) return 'unknown';
  return readState(at).stamps?.setupCode === now ? 'current' : 'behind';
}
