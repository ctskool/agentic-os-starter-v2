import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {voiceCommand, VOICE_HELP} from '../scripts/aos/voice.mjs';
import {layout} from '../scripts/aos/services.mjs';
import {main} from '../scripts/aos.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-voice-command-'));
test.after(() => fs.rmSync(scratch, {recursive: true, force: true}));

// An installation folder and a vault with a few notes, none of it real.
function installation() {
  const root = path.join(fs.mkdtempSync(path.join(scratch, 'install-')), 'obsidian-v2'), vault = path.join(path.dirname(root), 'vault'), at = layout(root);
  fs.mkdirSync(at.runtime, {recursive: true});
  for (const file of ['projects/2026-11-01-jev-plan.md', 'projects/2026-11-02-jev-batch.md', 'system/v2/profile.json']) { fs.mkdirSync(path.join(vault, path.dirname(file)), {recursive: true}); fs.writeFileSync(path.join(vault, file), file.endsWith('.json') ? '{"dailyDrivers":["Inbox triage"]}' : '# note'); }
  const run = async (...words) => { const lines = []; const flags = {}; const plain = []; for (let index = 0; index < words.length; index++) { if (String(words[index]).startsWith('--')) { flags[words[index].slice(2)] = words[index + 1]; index++; } else plain.push(words[index]); } const code = await voiceCommand({words: plain, flags, log: line => lines.push(line), at, vault}); return {code, text: lines.join('\n')}; };
  const profile = () => JSON.parse(fs.readFileSync(path.join(vault, 'system/v2/profile.json'), 'utf8'));
  return {at, vault, run, profile};
}

test('voice shows every setting, and each one can be changed from the command line', async () => {
  const f = installation();
  let shown = await f.run();
  assert.equal(shown.code, 0);
  for (const line of [/Spoken replies:\s+on/, /Voice:\s+the usual one/, /Speaking speed:\s+normal/, /Language:\s+English/, /start the model's program early off, take the answer as it arrives on, speak after the first sentence on/, /learned: Jev/]) assert.match(shown.text, line);

  assert.match((await f.run('mute')).text, /Spoken replies are off/);
  assert.match((await f.run('use', 'af_heart')).text, /Heart · American, female/);
  assert.match((await f.run('speed', '1.2')).text, /1\.2/);
  assert.deepEqual(f.profile(), {dailyDrivers: ['Inbox triage'], spokenReplies: false, voice: 'af_heart', voiceRate: 1.2}, 'the member\'s other preferences are untouched');

  assert.match((await f.run('teach', 'Zettelkasten', 'Acme Cloud')).text, /Zettelkasten, Acme Cloud/);
  assert.match((await f.run('forget', 'jev')).text, /no longer listens for: jev/);
  const words = JSON.parse(fs.readFileSync(path.join(f.at.runtime, 'voice-words.json'), 'utf8'));
  assert.deepEqual(words.words, ['Zettelkasten', 'Acme Cloud'], 'the voice service\'s list is rewritten at once: yours in, the forgotten one out');
  assert.match((await f.run('learn', 'off')).text, /only listens for the words you teach it/);

  assert.match((await f.run('fast', 'off')).text, /early: off\. Take the answer as it arrives: off\. Speak after the first sentence: off/);
  assert.match((await f.run('fast', '--early', 'on')).text, /early: off\. Take the answer as it arrives: on\. Speak after the first sentence: off/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.at.runtime, 'voice-speed.json'), 'utf8')), {earlyAnswer: true, streamSpeech: false, prestart: false});
  assert.match((await f.run('fast', '--prestart', 'on')).text, /early: on\./);
  // "fast on" is the two that are on by default; the third stays as the member set it. "fast off" turns all off.
  assert.match((await f.run('fast', 'on')).text, /early: on\. Take the answer as it arrives: on\. Speak after the first sentence: on/);
  await f.run('fast', '--prestart', 'off');
  assert.match((await f.run('fast', 'on')).text, /early: off\. Take the answer as it arrives: on/);
  await f.run('fast', '--prestart', 'on');
  assert.match((await f.run('fast', 'off')).text, /early: off\. Take the answer as it arrives: off\. Speak after the first sentence: off/);
  await f.run('fast', '--early', 'on');

  shown = await f.run();
  for (const line of [/off \(muted\)/, /Heart · American, female/, /Speaking speed:\s+1\.2/, /early off, take the answer as it arrives on, speak after the first sentence off/, /learning from note titles is off/, /yours:\s+Zettelkasten, Acme Cloud/, /forgotten: jev/]) assert.match(shown.text, line);

  assert.match((await f.run('unmute')).text, /Spoken replies are on/);
  assert.match((await f.run('use', 'default')).text, /usual one/);
  await f.run('speed', '1');
  assert.deepEqual(Object.keys(f.profile()).sort(), ['dailyDrivers', 'voiceWords', 'voiceWordsIgnore', 'voiceWordsLearn']);
});

test('a wrong command explains itself and changes nothing', async () => {
  const f = installation(), before = fs.readFileSync(path.join(f.vault, 'system/v2/profile.json'), 'utf8');
  for (const [words, message] of [[['speed', 'fast'], /between 0\.8 and 1\.4/], [['speed', '3'], /between 0\.8 and 1\.4/], [['use'], /voice use <name>/], [['use', '../x'], /not a voice name/], [['teach'], /voice teach/], [['teach', 'x'], /at least two letters/], [['learn', 'maybe'], /on or off/], [['fast'], /voice fast on\|off/], [['fast', 'sometimes'], /on or off/]])
    await assert.rejects(f.run(...words), message, words.join(' '));
  assert.equal(fs.readFileSync(path.join(f.vault, 'system/v2/profile.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.at.runtime, 'voice-speed.json')), false);
  const unknown = await f.run('louder');
  assert.equal(unknown.code, 1); assert.equal(unknown.text, VOICE_HELP);
  await assert.rejects(voiceCommand({words: [], at: f.at, vault: null}), /Nothing is installed here yet/);
});

test('the command is listed in the launcher\'s help', async () => {
  const lines = [];
  await main(['help'], line => lines.push(line));
  assert.match(lines.join('\n'), /\n  voice\s+how voice sounds, how fast it answers, the words it listens for/);
});
