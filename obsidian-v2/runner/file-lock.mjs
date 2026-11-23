// One writer at a time for a small settings file, across programs: the bridge and `node aos.mjs ...` both
// change the member's profile and schedule by reading the file, changing a line and writing it back. Without
// this, two of them at the same moment could each write back the other's old value.
//
// The lock is a file created next to the one being changed, holding its owner's process number and a token.
//   - A lock is only ever taken over when its owner is no longer running. An owner that is merely slow is
//     waited for and, if it stays slow, the newcomer gives up with a sentence; it never pushes the owner aside.
//   - An owner removes only its own lock (it checks the token), so it cannot remove a successor's.
//   - Waiting is bounded on every path. The bridge waits on its own thread, so the bound is short: holders
//     keep the lock for a few milliseconds.
// Hand edits in an editor are not covered: nothing here can stop a person saving over a file.
// Known limit: there is no lock the operating system releases by itself here, so taking over an abandoned
// lock is "look, then act". If a program died holding the lock AND two others arrive in the same instant,
// one settings write can be lost. Holders keep the lock for milliseconds, so this needs a crash at exactly
// the wrong moment plus a coincidence.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// A process we may not signal still exists.
const running = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// now: the wall clock, for a lock's age. tick: a clock that never jumps, for how long we have waited
// (a test that passes only `now` gets it for both).
export function withFileLock(file, work, {waitMs = 1500, staleMs = 10000, now, tick, sleep = pause, alive = running} = {}) {
  tick ||= now || (() => performance.now());
  now ||= Date.now;
  const lock = `${file}.lock`, deadline = tick() + waitMs, token = `${process.pid}:${crypto.randomUUID()}`;
  fs.mkdirSync(path.dirname(lock), {recursive: true});
  for (;;) {
    try { fs.writeFileSync(lock, token, {flag: 'wx'}); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    // Someone holds it. Who, and since when? (Unreadable means it was released this instant: try again.)
    let owner = null, age = 0;
    try { owner = fs.readFileSync(lock, 'utf8'); age = now() - fs.statSync(lock).mtimeMs; } catch { /* released meanwhile */ }
    const pid = Number(String(owner ?? '').split(':')[0]);
    if (owner !== null && age > staleMs && !(Number.isInteger(pid) && pid > 0 && alive(pid))) {
      // Abandoned by a program that is gone. It is moved aside under a name of its own first, so that of two
      // programs that both saw it abandoned only one removes it; if what was moved turns out to be someone's
      // fresh lock (taken in that instant), it is put back.
      const aside = `${lock}.${crypto.randomUUID()}.stale`;
      try {
        // Looked at once more at the last moment: if another program has just taken it over, leave it alone.
        if (fs.readFileSync(lock, 'utf8') !== owner) throw new Error('taken over meanwhile');
        fs.renameSync(lock, aside);
        if (fs.readFileSync(aside, 'utf8') === owner) fs.unlinkSync(aside); else fs.renameSync(aside, lock);
      } catch { /* the other program got there first */ }
    }
    if (tick() >= deadline) throw new Error('Another program is saving this setting right now. Try again in a moment.');
    sleep(25);
  }
  try { return work(); }
  finally { try { if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock); } catch { /* already gone */ } }
}
