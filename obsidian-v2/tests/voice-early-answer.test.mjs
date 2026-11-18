import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {answerStream, executeCli, commandFor} from '../runner/adapters.mjs';
import {voiceSpeed, saveVoiceSpeed, speakStreamQuery, VOICE_SPEED_DEFAULTS} from '../runner/voice-speed.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-early-answer-'));
// A program that was just stopped can hold its folder for a moment on Windows; that is not a test failure.
test.after(() => { try { fs.rmSync(scratch, {recursive: true, force: true, maxRetries: 10, retryDelay: 300}); } catch { /* left for the system's own temp cleanup */ } });
const vault = () => fs.mkdtempSync(path.join(scratch, 'vault-'));
const line = value => JSON.stringify(value) + '\n';
const answer = '{"tier":2,"reply":"Your next meeting is at three."}';
const assistant = blocks => ({type: 'assistant', message: {content: blocks, stop_reason: null}});

test('a Claude answer is taken from the line that ends a successful turn, and from nothing earlier', () => {
  const stream = answerStream('claude');
  assert.equal(stream.seen(), false);
  assert.equal(stream.push(line({type: 'system', subtype: 'init'})), null);
  assert.equal(stream.seen(), true);
  assert.equal(stream.push(line(assistant([{type: 'thinking', thinking: ''}]))), null, 'thinking is not an answer');
  assert.equal(stream.push(line(assistant([{type: 'text', text: answer}]))), null, 'text written before the turn has ended is not acted on: the turn can still fail');
  assert.deepEqual(stream.push(line({type: 'result', is_error: false, result: answer})), {text: answer});

  // The closing line arriving in three pieces, with a line that is not JSON in front of it.
  const pieces = answerStream('claude'), whole = 'warning: something\n' + line({type: 'result', is_error: false, result: answer});
  assert.equal(pieces.push(whole.slice(0, 30)), null);
  assert.equal(pieces.push(whole.slice(30, 60)), null);
  assert.deepEqual(pieces.push(whole.slice(60)), {text: answer});

  // A turn that failed is never an answer, even when a complete answer was written first and both arrive together.
  const failed = answerStream('claude');
  assert.equal(failed.push(line(assistant([{type: 'text', text: answer}])) + line({type: 'result', is_error: true, result: 'Please run /login'})), null);
  assert.equal(failed.result().is_error, true);
  assert.equal(answerStream('claude').push(line({type: 'result', is_error: false})), null, 'a result with no text is not an answer');
});

test('a Codex answer is taken when its turn is complete', () => {
  const stream = answerStream('codex');
  assert.equal(stream.push(line({type: 'thread.started'}) + line({type: 'turn.started'})), null);
  assert.equal(stream.push(line({type: 'item.completed', item: {type: 'error', message: 'a notice'}})), null);
  assert.equal(stream.push(line({type: 'item.completed', item: {type: 'agent_message', text: answer}})), null, 'the turn is not over yet');
  assert.deepEqual(stream.push(line({type: 'turn.completed'})), {text: answer});
  assert.equal(answerStream('codex').push(line({type: 'turn.completed'})), null, 'a turn with no message is not an answer');
  const failed = answerStream('codex');
  assert.equal(failed.push(line({type: 'item.completed', item: {type: 'agent_message', text: answer}}) + line({type: 'turn.failed'}) + line({type: 'turn.completed'})), null, 'a failed turn discards what was written before it');
});

// A stand-in CLI: prints the given lines, then stays open for a minute, as a program that is slow to close does.
const slowToClose = lines => `process.stdin.resume();process.stdin.on('end',()=>{${lines.map(text => `process.stdout.write(${JSON.stringify(text)});`).join('')}setTimeout(()=>{},60000)});`;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

for (const provider of ['claude', 'codex']) test(`${provider}: the answer is returned at once and the program that is slow to close is stopped`, async () => {
  const root = vault(), lines = provider === 'claude'
    ? [line({type: 'system', subtype: 'init'}), line(assistant([{type: 'text', text: answer}])), line({type: 'result', is_error: false, result: answer})]
    : [line({type: 'thread.started'}), line({type: 'item.completed', item: {type: 'agent_message', text: answer}}), line({type: 'turn.completed'})];
  let child, detached, streamed, controller;
  const started = performance.now();
  const result = await executeCli(root, {id: 'early-1', provider, model: 'fixture'}, 'Utterance', {early: true, onDetached: (closed, given) => { detached = closed; controller = given; },
    resolveCommand: (_root, job) => { streamed = job.stream; return {command: process.execPath, args: ['-e', slowToClose(lines)], final: path.join(root, 'never-written.md')}; },
    launch: (command, args, options) => { child = spawn(command, args, options); return child; }});
  assert.deepEqual(result, {text: answer});
  assert.ok(performance.now() - started < 20000, 'did not wait for the program to close');
  assert.equal(streamed, true, 'the classifier was asked for its event stream');
  assert.ok(detached && typeof detached.then === 'function', 'the caller is handed the closing program to keep counting');
  assert.equal(typeof controller.abort, 'function', 'and a way to ask again for it to be stopped');
  assert.doesNotThrow(() => controller.abort());
  await detached;
  assert.equal(alive(child.pid), false, 'the program is gone');
  assert.match(fs.readFileSync(path.join(root, 'system/v2/logs/early-1.log'), 'utf8'), /tier/, 'the run log is still written');
});

test('without an early answer the result line is used when the program closes by itself', async () => {
  const root = vault();
  const script = `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(line(assistant([{type: 'text', text: 'Plain words.'}])) + line({type: 'post', note: 'x'}))});process.stdout.write(${JSON.stringify(line({type: 'result', is_error: true, result: 'Please run /login'}))});});`;
  await assert.rejects(executeCli(root, {id: 'early-2', provider: 'claude', model: 'fixture'}, 'Utterance', {early: true, resolveCommand: () => ({command: process.execPath, args: ['-e', script]})}), /Please run \/login/);
  const silent = `process.stdin.resume();process.stdin.on('end',()=>{});`;
  await assert.rejects(executeCli(root, {id: 'early-3', provider: 'claude', model: 'fixture'}, 'Utterance', {early: true, resolveCommand: () => ({command: process.execPath, args: ['-e', silent]})}), /closed without a result/);
});

test('an older CLI that refuses the streaming arguments is recognised, and a real failure is not mistaken for one', async () => {
  const root = vault();
  const refuses = `process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write("error: unknown option '--verbose'\\n");process.exit(1)});`;
  const refusal = await executeCli(root, {id: 'old-1', provider: 'claude', model: 'fixture'}, 'Utterance', {early: true, resolveCommand: () => ({command: process.execPath, args: ['-e', refuses]})}).catch(error => error);
  assert.equal(refusal.streamUnsupported, true); assert.equal(refusal.notSubmitted, true, 'a refusal of the arguments is proof nothing was asked');
  // The refusal worded the other way round, naming the value instead of the option.
  const reversed = `process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write("error: option '--output-format <format>' argument 'stream-json' is invalid\\n");process.exit(1)});`;
  assert.equal((await executeCli(root, {id: 'old-1b', provider: 'claude', model: 'fixture'}, 'Utterance', {early: true, resolveCommand: () => ({command: process.execPath, args: ['-e', reversed]})}).catch(error => error)).streamUnsupported, true);
  // The model ran and then the CLI failed: that is an ordinary failure, to be reported, not retried.
  const ranThenFailed = `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(line({type: 'system', subtype: 'init'}))});process.stderr.write("invalid value somewhere\\n");process.exit(1)});`;
  const failure = await executeCli(root, {id: 'old-2', provider: 'claude', model: 'fixture'}, 'Utterance', {early: true, resolveCommand: () => ({command: process.execPath, args: ['-e', ranThenFailed]})}).catch(error => error);
  assert.equal(failure.streamUnsupported, undefined); assert.match(failure.message, /exited 1/);
  // A refusal that does not name the streaming arguments is not "streaming is unsupported": retrying the old way
  // would not help, and streaming must not be switched off for the rest of the day because of it.
  const wrongModel = `process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write("error: invalid value for --model\\n");process.exit(1)});`;
  const unrelated = await executeCli(root, {id: 'old-4', provider: 'claude', model: 'fixture'}, 'Utterance', {early: true, resolveCommand: () => ({command: process.execPath, args: ['-e', wrongModel]})}).catch(error => error);
  assert.equal(unrelated.streamUnsupported, undefined); assert.equal(unrelated.noOutput, true);
  assert.equal(unrelated.notSubmitted, undefined, 'silence is not proof that nothing was asked');
  // Codex is given the same arguments either way, so nothing it says can mean that.
  const codex = await executeCli(root, {id: 'old-5', provider: 'codex', model: 'fixture'}, 'Utterance', {early: true, resolveCommand: () => ({command: process.execPath, args: ['-e', refuses], final: path.join(root, 'none.md')})}).catch(error => error);
  assert.equal(codex.streamUnsupported, undefined);
  // Half a line printed and then a crash: something was printed, so the request is not asked again.
  const partial = `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('{"type":"assis');process.exit(1)});`;
  const cut = await executeCli(root, {id: 'old-6', provider: 'claude', model: 'fixture'}, 'Utterance', {early: true, resolveCommand: () => ({command: process.execPath, args: ['-e', partial]})}).catch(error => error);
  assert.equal(cut.noOutput, undefined);
  // It closed normally without a word: nothing was asked.
  const silentExit = await executeCli(root, {id: 'old-7', provider: 'claude', model: 'fixture'}, 'Utterance', {early: true, resolveCommand: () => ({command: process.execPath, args: ['-e', `process.stdin.resume();process.stdin.on('end',()=>{});`]})}).catch(error => error);
  assert.match(silentExit.message, /closed without a result/); assert.equal(silentExit.notSubmitted, undefined, 'it may have taken the request before going quiet');
  // Without streaming there is nothing to fall back from.
  const plain = await executeCli(root, {id: 'old-3', provider: 'claude', model: 'fixture'}, 'Utterance', {resolveCommand: () => ({command: process.execPath, args: ['-e', refuses]})}).catch(error => error);
  assert.equal(plain.streamUnsupported, undefined);
});

test('a letter split across two reads of the stream arrives whole', async () => {
  const root = vault(), reply = '{"tier":2,"reply":"Você tem três reuniões — às 15h."}';
  const bytes = Buffer.from(line({type: 'result', is_error: false, result: reply})), cut = bytes.indexOf(Buffer.from('ê')) + 1;
  const script = `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(Buffer.from(${JSON.stringify(bytes.subarray(0, cut).toString('base64'))},'base64'));setTimeout(()=>{process.stdout.write(Buffer.from(${JSON.stringify(bytes.subarray(cut).toString('base64'))},'base64'));setTimeout(()=>{},60000)},150)});`;
  let closing;
  const result = await executeCli(root, {id: 'utf-1', provider: 'claude', model: 'fixture'}, 'Utterance', {early: true, onDetached: closed => { closing = closed; }, resolveCommand: () => ({command: process.execPath, args: ['-e', script]})});
  assert.equal(result.text, reply);
  await closing;
});

test('a workflow never streams, and only a classifier is asked for an event stream', async () => {
  const root = vault(), cli = {command: 'claude', prefix: []};
  const plain = commandFor(root, {id: 'a', provider: 'claude', model: 'haiku'}, cli).args;
  assert.equal(plain[plain.indexOf('--output-format') + 1], 'json'); assert.ok(!plain.includes('--verbose'));
  const stream = commandFor(root, {id: 'a', provider: 'claude', model: 'haiku', stream: true}, cli).args;
  assert.equal(stream[stream.indexOf('--output-format') + 1], 'stream-json'); assert.ok(stream.includes('--verbose'));
  const worker = commandFor(root, {id: 'a', provider: 'claude', model: 'sonnet', skill: 'vault-summary', stream: true}, cli).args;
  assert.equal(worker[worker.indexOf('--output-format') + 1], 'json', 'a workflow keeps its structured result');
  // executeCli itself does not ask a workflow to stream, whatever the caller passes.
  let asked;
  const payload = {status: 'ok', summary: 'Done', markdown: '# Report'};
  const script = `process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(JSON.stringify({structured_output: payload}))}));`;
  const result = await executeCli(root, {id: 'wf-1', provider: 'claude', model: 'sonnet', skill: 'vault-summary'}, 'Run', {early: true, resolveCommand: (_root, job) => { asked = job.stream; return {command: process.execPath, args: ['-e', script]}; }});
  assert.equal(asked, undefined); assert.equal(result.text, '# Report');
});

test('only the player that plays audio as it arrives is sent speech sentence by sentence', () => {
  assert.equal(speakStreamQuery('GET', {streamSpeech: true}), '&stream=1');
  assert.equal(speakStreamQuery('POST', {streamSpeech: true}), '', 'the buffered fallback decodes one complete file');
  assert.equal(speakStreamQuery('GET', {streamSpeech: false}), '', 'switched off');
  const bridge = fs.readFileSync(new URL('../runner/bridge.mjs', import.meta.url), 'utf8');
  assert.ok(bridge.includes('}${speakStreamQuery(req.method)}${speakPrefsQuery(readVoicePrefs(root))}`'), 'the bridge asks the voice service that way');
});

test('the two tested speed-ups are on by default, the third is off, and each has its own switch', () => {
  const file = path.join(scratch, 'install', '.runtime', 'voice-speed.json');
  assert.deepEqual(voiceSpeed({file}), VOICE_SPEED_DEFAULTS);
  assert.equal(VOICE_SPEED_DEFAULTS.prestart, false, 'starting the program early is something to try, not a default');
  assert.deepEqual(saveVoiceSpeed({earlyAnswer: false}, {file}), {earlyAnswer: false, streamSpeech: true, prestart: false});
  assert.deepEqual(saveVoiceSpeed({streamSpeech: false}, {file}), {earlyAnswer: false, streamSpeech: false, prestart: false});
  assert.deepEqual(saveVoiceSpeed({earlyAnswer: true, prestart: true}, {file}), {earlyAnswer: true, streamSpeech: false, prestart: true});
  assert.throws(() => saveVoiceSpeed({turbo: true}, {file}), /Unknown voice speed setting/);
  assert.throws(() => saveVoiceSpeed({earlyAnswer: 'no'}, {file}), /Unknown voice speed setting/);
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(voiceSpeed({file, now: () => Date.now() + 5000}), VOICE_SPEED_DEFAULTS, 'an unreadable file means the defaults');
  fs.writeFileSync(file, '{"earlyAnswer":"yes","streamSpeech":0}');
  assert.deepEqual(voiceSpeed({file, now: () => Date.now() + 10000}), VOICE_SPEED_DEFAULTS, 'only true and false count');
});
