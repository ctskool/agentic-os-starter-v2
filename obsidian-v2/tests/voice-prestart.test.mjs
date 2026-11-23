import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {prestartCli, executeCli} from '../runner/adapters.mjs';
import {prepareFastVoice, executeFastVoice} from '../runner/fast-voice.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-prestart-'));
// A program that was just stopped can hold its folder for a moment on Windows; that is not a test failure.
test.after(() => { try { fs.rmSync(scratch, {recursive: true, force: true, maxRetries: 10, retryDelay: 300}); } catch { /* left for the system's own temp cleanup */ } });
const vault = () => fs.mkdtempSync(path.join(scratch, 'vault-'));
const line = value => JSON.stringify(value) + '\n';
const answer = '{"tier":2,"reply":"Your next meeting is at three."}';
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check, label) => { for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); } assert.fail(`timed out: ${label}`); };

// A stand-in CLI that behaves like the real one: it prints nothing while it waits for its input, then prints
// an "init" line and what it was given (as its answer), and stays open for a minute, as a program that is
// slow to close does.
const waits = `let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(line({type: 'system', subtype: 'init'}))});process.stdout.write(JSON.stringify({type:'result',is_error:false,result:JSON.stringify({got:input})})+'\\n');setTimeout(()=>{},60000)});`;
// One that speaks before it is spoken to, including a line that looks like a finished answer.
const talkative = `process.stdout.write(${JSON.stringify(line({type: 'result', is_error: false, result: 'said before being asked'}))});` + waits;
const command = script => () => ({command: process.execPath, args: ['-e', script]});
const job = (id, extra = {}) => ({id, provider: 'claude', model: 'haiku', ...extra});

test('a program started ahead of time is the one that answers', async () => {
  const root = vault(), launched = [];
  const launch = (...args) => { const child = spawn(...args); launched.push(child); return child; };
  const handle = prestartCli(root, job('pre-1'), {launch, resolveCommand: command(waits)});
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(handle.gone, false); assert.equal(handle.taken, false); assert.deepEqual(handle.out, [], 'it says nothing while it waits');
  let closing;
  const result = await executeCli(root, job('pre-1'), 'Utterance: "hello"', {early: true, prestarted: handle, onDetached: closed => { closing = closed; }, launch: () => assert.fail('no second program is started'), resolveCommand: command(waits)});
  assert.deepEqual(JSON.parse(result.text), {got: ' Utterance: "hello"'}, 'the keep-waiting space arrives in front of the prompt and nothing else changes');
  assert.equal(launched.length, 1); assert.equal(handle.taken, true);
  assert.match(fs.readFileSync(path.join(root, 'system/v2/logs/pre-1.log'), 'utf8'), /"subtype":"init"/, 'its output is in the run log as usual');
  await closing; assert.equal(alive(launched[0].pid), false, 'and it is stopped once it has answered');
  assert.doesNotThrow(() => handle.discard(), 'discarding an adopted program is harmless');
});

test('a waiting program that does not fit the request, has gone, or is not wanted is never used', async () => {
  const root = vault();
  // Not the program this request would start: discarded, and a fresh one answers.
  const other = prestartCli(root, job('pre-2'), {resolveCommand: command(waits + '/* a different command line */')});
  let fresh = 0;
  const result = await executeCli(root, job('pre-2'), 'Utterance', {early: true, prestarted: other, resolveCommand: command(waits), launch: (...args) => { fresh++; return spawn(...args); }, onDetached: () => {}});
  assert.deepEqual(JSON.parse(result.text), {got: 'Utterance'}); assert.equal(fresh, 1);
  await other.closed; assert.equal(alive(other.child.pid), false, 'the unused program was stopped');

  // It printed something before it was asked, even a line that looks like a finished answer: that is never
  // taken for the answer to this request. It is stopped and a fresh program is asked.
  const chatty = prestartCli(root, job('pre-2b'), {resolveCommand: command(talkative)});
  await until(() => chatty.out.length > 0, 'the talkative program has spoken');
  const asked = await executeCli(root, job('pre-2b'), 'Utterance', {early: true, prestarted: chatty, resolveCommand: command(talkative), launch: (bin, args, options) => spawn(bin, ['-e', waits], options), onDetached: () => {}});
  assert.deepEqual(JSON.parse(asked.text), {got: 'Utterance'});
  await chatty.closed; assert.equal(alive(chatty.child.pid), false);

  // It can no longer be asked anything (its input broke) but is still running: not used, and still stopped.
  const deaf = prestartCli(root, job('pre-2c'), {resolveCommand: command(waits)});
  await new Promise(resolve => setTimeout(resolve, 200));
  deaf.inputClosed = true;
  assert.deepEqual(JSON.parse((await executeCli(root, job('pre-2c'), 'Utterance', {early: true, prestarted: deaf, resolveCommand: command(waits), onDetached: () => {}})).text), {got: 'Utterance'});
  await deaf.closed; assert.equal(alive(deaf.child.pid), false, 'a program that cannot be asked is still stopped');

  // It died while waiting: a fresh one answers.
  const died = prestartCli(root, job('pre-3'), {resolveCommand: command('process.exit(0)')});
  await died.closed; assert.equal(died.gone, true);
  assert.deepEqual(JSON.parse((await executeCli(root, job('pre-3'), 'Utterance', {early: true, prestarted: died, resolveCommand: command('process.exit(0)'), launch: (bin, args, options) => spawn(bin, ['-e', waits], options), onDetached: () => {}})).text), {got: 'Utterance'});

  // A request that is already cancelled, a workflow, and a request that does not read the stream all leave it unused and stop it.
  for (const [label, use] of [
    ['cancelled', handle => { const stop = new AbortController(); stop.abort(); return assert.rejects(executeCli(root, job('pre-4'), 'x', {early: true, prestarted: handle, signal: stop.signal, resolveCommand: command(waits)}), /cancelled/); }],
    ['not streaming', handle => executeCli(root, job('pre-5'), 'x', {prestarted: handle, resolveCommand: command(`process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(JSON.stringify({result: 'plain', is_error: false}))}))`)})],
  ]) {
    const handle = prestartCli(root, job('pre-x'), {resolveCommand: command(waits)});
    await use(handle);
    await handle.closed; assert.equal(alive(handle.child.pid), false, label);
  }

  // Never used at all: discard stops it, twice is harmless.
  const unused = prestartCli(root, job('pre-6'), {resolveCommand: command(waits)});
  await new Promise(resolve => setTimeout(resolve, 300));
  unused.discard(); unused.discard();
  await unused.closed; assert.equal(alive(unused.child.pid), false);
});

test('the program is started early only for Claude, only when the switches allow it, and is counted until it is adopted or gone', async () => {
  const root = vault(), on = () => ({earlyAnswer: true, streamSpeech: true, prestart: true}), quiet = () => ({total: 0});
  const fake = () => { const handle = {taken: false, gone: false, closed: new Promise(() => {}), discarded: 0, stopped: 0, stop() { handle.stopped++; }, discard() { handle.discarded++; handle.taken = true; }}; return handle; };
  const started = [], tracked = [];
  const deps = {speed: on, processes: quiet, unsupported: new Set(), prestart: (vaultRoot, request) => { const handle = fake(); started.push({request, handle}); return handle; }, track: (promise, controller) => tracked.push({promise, controller})};
  assert.equal(prepareFastVoice(root, {provider: 'codex', model: 'astra'}, deps), null, 'no gain was measured for Codex');
  assert.equal(prepareFastVoice(root, {provider: 'claude', model: 'opus'}, {...deps, speed: () => ({...on(), prestart: false})}), null, 'switched off');
  assert.equal(prepareFastVoice(root, {provider: 'claude', model: 'opus'}, {...deps, speed: () => ({...on(), earlyAnswer: false})}), null, 'it depends on reading the stream');
  assert.equal(prepareFastVoice(root, {provider: 'claude', model: 'opus'}, {...deps, unsupported: new Set(['claude'])}), null, 'a CLI that refused the stream is not started early');
  assert.equal(prepareFastVoice(root, {provider: 'claude', model: 'opus'}, {...deps, processes: () => ({total: 4})}), null, 'not while several programs are still closing');
  assert.equal(prepareFastVoice(root, {provider: 'claude', model: 'opus'}, {...deps, prestart: () => { throw new Error('cannot start'); }}), null, 'a failure to start is not an error for the request');
  assert.deepEqual(started, []);

  const prepared = prepareFastVoice(root, {provider: 'claude', model: 'opus'}, deps);
  assert.equal(started.length, 1);
  assert.equal(started[0].request.provider, 'claude'); assert.equal(started[0].request.model, 'haiku', 'the small routing model, whatever the member chose for work');
  assert.equal(tracked.length, 1); assert.equal(tracked[0].promise, started[0].handle.closed, 'counted as the bridge\'s own from its start until it has really closed, whoever is using it by then');
  // Shutdown can ask it to stop, whether or not a request has taken it.
  tracked[0].controller.abort(); assert.equal(started[0].handle.stopped, 1);
  // Only the small model's classifier call takes it, and only once.
  assert.equal(prepared.take({provider: 'claude', model: 'opus'}), null);
  assert.equal(prepared.take({provider: 'claude', model: 'haiku', skill: 'voice-ask'}), null, 'a worker is not a classifier');
  assert.equal(prepared.take({provider: 'codex', model: 'luna'}), null);
  assert.equal(prepared.take({provider: 'claude', model: 'haiku'}), started[0].handle);
  assert.equal(prepared.take({provider: 'claude', model: 'haiku'}), null, 'once');
  // One that has waited more than two and a half seconds is stopped, and the request starts a fresh program.
  let clock = 1000;
  const slow = prepareFastVoice(root, {provider: 'claude', model: 'opus'}, {...deps, now: () => clock});
  clock += 2400; const stillFresh = started.at(-1).handle;
  assert.equal(slow.take({provider: 'claude', model: 'haiku'}), stillFresh, 'within the window it is used');
  const stale = prepareFastVoice(root, {provider: 'claude', model: 'opus'}, {...deps, now: () => clock});
  clock += 2600;
  assert.equal(stale.take({provider: 'claude', model: 'haiku'}), null);
  assert.equal(started.at(-1).handle.discarded, 1, 'and the stale one is stopped');
  assert.equal(stale.take({provider: 'claude', model: 'haiku'}), null);
  // A request that never needed the model: the program is stopped, unused.
  const second = prepareFastVoice(root, {provider: 'claude', model: 'opus'}, deps);
  second.discard(); assert.equal(started.at(-1).handle.discarded, 1);
});

test('a spoken request uses the waiting program, and is asked again only when there is proof it never reached that program', async () => {
  const root = vault(), base = {speed: () => ({earlyAnswer: true, streamSpeech: true, prestart: true}), processes: () => ({total: 0}), track: () => {}};
  const prepared = handle => ({take: () => handle, discard() {}});
  const request = {id: 'r1', provider: 'claude', model: 'haiku'}, good = {text: answer};
  // Used: the launcher is handed the waiting program.
  let seen = [];
  assert.equal(await executeFastVoice(root, request, 'p', {}, {...base, unsupported: new Set(), prepared: prepared('HANDLE'), cli: async (_root, _job, _prompt, options) => { seen.push(options.prestarted); return good; }}), good);
  assert.deepEqual(seen, ['HANDLE']);
  // It had died while waiting and the request could not be written to it: asked once more with a fresh program.
  seen = [];
  assert.equal(await executeFastVoice(root, request, 'p', {}, {...base, unsupported: new Set(), prepared: prepared('HANDLE'), cli: async (_root, _job, _prompt, options) => { seen.push(options.prestarted || null); if (options.prestarted) throw Object.assign(new Error('claude exited 1'), {noOutput: true, notSubmitted: true}); return good; }}), good);
  assert.deepEqual(seen, ['HANDLE', null]);
  // It took the request and then ended without a word: it may have reached the model, so it is NOT asked again.
  seen = [];
  await assert.rejects(executeFastVoice(root, request, 'p', {}, {...base, unsupported: new Set(), prepared: prepared('HANDLE'), cli: async (_root, _job, _prompt, options) => { seen.push(options.prestarted || null); throw Object.assign(new Error('claude exited 1'), {noOutput: true}); }}), /exited 1/);
  assert.deepEqual(seen, ['HANDLE']);
  // The model ran and the request then failed: reported once, never asked again.
  seen = [];
  await assert.rejects(executeFastVoice(root, request, 'p', {}, {...base, unsupported: new Set(), prepared: prepared('HANDLE'), cli: async (_root, _job, _prompt, options) => { seen.push(options.prestarted || null); throw new Error('rate limited'); }}), /rate limited/);
  assert.deepEqual(seen, ['HANDLE']);
  // Cancelled while it ran: not asked again.
  seen = []; const stop = new AbortController();
  await assert.rejects(executeFastVoice(root, request, 'p', {signal: stop.signal}, {...base, unsupported: new Set(), prepared: prepared('HANDLE'), cli: async (_root, _job, _prompt, options) => { seen.push(1); stop.abort(); throw Object.assign(new Error('Voice request cancelled'), {noOutput: true, notSubmitted: true}); }}), /cancelled/);
  assert.deepEqual(seen, [1]);
  // An older CLI refused the streaming arguments from the waiting program: asked again the old way, and remembered.
  seen = []; const refused = new Set();
  assert.equal(await executeFastVoice(root, request, 'p', {}, {...base, unsupported: refused, prepared: prepared('HANDLE'), cli: async (_root, _job, _prompt, options) => { seen.push(options.early === true); if (options.early) throw Object.assign(new Error('claude exited 1'), {noOutput: true, streamUnsupported: true, notSubmitted: true}); return good; }}), good);
  assert.deepEqual(seen, [true, false]); assert.ok(refused.has('claude'));
  // Nothing was started early (typed request, Codex, switched off): exactly as before.
  seen = [];
  await executeFastVoice(root, request, 'p', {}, {...base, unsupported: new Set(), cli: async (_root, _job, _prompt, options) => { seen.push(options.prestarted); return good; }});
  assert.deepEqual(seen, [undefined]);
});
