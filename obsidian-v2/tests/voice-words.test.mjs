import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {learnVoiceWords, voiceWordList, voiceWordSettings, writeVoiceWords, saveVoiceWords, VOICE_WORDS_LIMIT, VOICE_PROMPT_LIMIT} from '../runner/voice-words.mjs';
import {EVERYDAY_WORDS} from '../runner/voice-everyday-words.mjs';
import {tokenize} from '../runner/voice-targets.mjs';
import {dailyDrivers} from '../runner/profile.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-voice-words-'));
test.after(() => fs.rmSync(scratch, {recursive: true, force: true}));
const NOW = Date.parse('2026-11-18T12:00:00Z'), DAY = 24 * 60 * 60 * 1000;
// One entry of the bridge's file index, as voice-targets.mjs builds it.
const note = (file, {daysOld = 5, archived = false} = {}) => {
  const name = path.basename(file, '.md'), folder = path.dirname(file) === '.' ? '' : path.dirname(file);
  return {path: file, name, tokens: tokenize(name.replace(/^\d{4}-\d{2}-\d{2}/, '')), folderTokens: tokenize(folder), mtime: NOW - daysOld * DAY, archived, index: name === '_index'};
};
const vault = profile => { const root = fs.mkdtempSync(path.join(scratch, 'vault-')); if (profile !== undefined) { fs.mkdirSync(path.join(root, 'system', 'v2'), {recursive: true}); fs.writeFileSync(path.join(root, 'system', 'v2', 'profile.json'), typeof profile === 'string' ? profile : JSON.stringify(profile)); } return root; };
const profileOf = root => JSON.parse(fs.readFileSync(path.join(root, 'system', 'v2', 'profile.json'), 'utf8'));

const entries = [
  note('projects/2026-11-01-jev-voice-integration-plan.md'), note('projects/2026-11-03-jev-batch-test.md'), note('inbox/research/2026-10-02-jev-notes.md', {daysOld: 50}),
  note('content/blog/2026-11-10-zettelkasten-motion-review.md'), note('projects/2026-10-05-zettelkasten-reel.md', {daysOld: 45}),
  note('projects/2026-11-12-skool-post-ideas.md'), note('inbox/notes/2026-11-13-skool-poll.md'),
  note('projects/2026-11-14-weekly-video-plan.md'), note('projects/2026-11-15-weekly-review-notes.md'),
  note('projects/2026-11-16-zebrafish-once.md'),
  note('projects/archive/2025-01-01-oldthing-plan.md', {archived: true}), note('projects/archive/2025-01-02-oldthing-review.md', {archived: true}),
  note('inbox/2026-11-17-frame3-export.md'), note('inbox/2026-11-17-frame3-notes.md'),
  note('inbox/2026-11-17-n8n-flow.md'), note('inbox/2026-11-16-n8n-setup.md'),
  note('wiki/claude-code/_index.md'), note('wiki/claude-code/hooks.md'), note('wiki/claude-code/skills.md'),
];

test('the unusual words that keep coming up are learned; everyday words, one-offs and archived notes are not', () => {
  const learned = learnVoiceWords(entries, {now: NOW});
  assert.equal(learned[0], 'Jev', 'most used and most recent first');
  for (const name of ['Zettelkasten', 'Skool']) assert.ok(learned.includes(name), name);
  assert.ok(learned.indexOf('Skool') < learned.indexOf('Zettelkasten'), 'two recent notes outrank one recent and one old');
  assert.ok(learned.includes('N8n'), 'a name with a digit inside it is a name');
  assert.ok(learned.includes('Claude'), 'folder names count too');
  for (const plain of ['Weekly', 'Plan', 'Review', 'Notes', 'Video', 'Voice', 'Integration', 'Post']) assert.ok(!learned.includes(plain), `${plain} is everyday English`);
  assert.ok(!learned.includes('Zebrafish'), 'a word seen once waits for a second sighting');
  assert.ok(!learned.includes('Oldthing'), 'archived notes do not teach');
  assert.ok(!learned.includes('Frame3'), 'file numbering is not a word');
  const forgotten = learnVoiceWords(entries, {now: NOW, ignored: ['jev', 'SKOOL']});
  assert.ok(!forgotten.includes('Jev') && !forgotten.includes('Skool') && forgotten.includes('Zettelkasten'), 'a forgotten word stays forgotten, whatever its capitals');
  assert.equal(learnVoiceWords(entries, {now: NOW, limit: 2}).length, 2);
  assert.deepEqual(learnVoiceWords([], {now: NOW}), []);
  assert.deepEqual(learnVoiceWords(null, {now: NOW}), []);
  // Short all-consonant names are spoken as letters.
  assert.ok(learnVoiceWords([note('a/2026-11-01-mcp-server.md'), note('a/2026-11-02-mcp-notes.md')], {now: NOW}).includes('MCP'));
  assert.ok(EVERYDAY_WORDS.size > 600 && !EVERYDAY_WORDS.has('jev') && !EVERYDAY_WORDS.has('claude') && !EVERYDAY_WORDS.has(''));
});

test('your own words come first, in your spelling, and the list never grows past what speech-to-text can take', () => {
  const root = vault({dailyDrivers: ['Inbox triage'], voiceWords: ['JEV', 'Acme Cloud', 'x'], voiceWordsIgnore: ['zettelkasten']});
  assert.deepEqual(voiceWordSettings(root), {learn: true, yours: ['JEV', 'Acme Cloud'], ignored: ['zettelkasten']});
  const list = voiceWordList(root, {entries, now: NOW});
  assert.deepEqual(list.words.slice(0, 2), ['JEV', 'Acme Cloud'], 'your words come first, in your spelling');
  assert.equal(list.words.filter(word => word.toLowerCase() === 'jev').length, 1, 'the learned copy of the same word is not repeated');
  assert.ok(list.words.includes('Skool'));
  assert.ok(!list.words.some(word => word.toLowerCase() === 'zettelkasten'));
  assert.deepEqual(list.yours, ['JEV', 'Acme Cloud']);
  // Learning switched off keeps only your own list.
  assert.deepEqual(voiceWordList(vault({voiceWords: ['Jev'], voiceWordsLearn: false}), {entries, now: NOW}).words, ['Jev']);
  // A vault with no profile, or one that cannot be read, still learns.
  assert.equal(voiceWordList(vault(), {entries, now: NOW}).words[0], 'Jev');
  assert.deepEqual(voiceWordList(vault('not json'), {entries, now: NOW}).yours, []);
  const many = Array.from({length: 200}, (_, index) => [note(`a/2026-11-01-zq${String.fromCharCode(97 + index % 26)}${String.fromCharCode(97 + Math.floor(index / 26))}x-one.md`), note(`b/2026-11-02-zq${String.fromCharCode(97 + index % 26)}${String.fromCharCode(97 + Math.floor(index / 26))}x-two.md`)]).flat();
  assert.equal(voiceWordList(vault({voiceWords: ['Jev']}), {entries: many, now: NOW}).words.length, VOICE_WORDS_LIMIT);
  // Sixty long words of your own do not fit the hint. As many as fit are kept, whole, yours before any
  // learned one, and the hint stays short enough for the voice service to accept (it refuses a long one outright).
  const long = Array.from({length: VOICE_WORDS_LIMIT}, (_, index) => `Extraordinarily Long Product Name ${String(index).padStart(3, '0')}`);
  const crowded = vault({voiceWords: long}), file = path.join(scratch, 'runtime-long', 'voice-words.json');
  const fitted = writeVoiceWords(crowded, {file, entries, now: NOW});
  const prompt = JSON.parse(fs.readFileSync(file, 'utf8')).prompt;
  assert.ok(prompt.length <= VOICE_PROMPT_LIMIT + 1, `${prompt.length} characters`);
  assert.ok(fitted.words.length > 5 && fitted.words.length < VOICE_WORDS_LIMIT);
  assert.deepEqual(fitted.words, long.slice(0, fitted.words.length), 'whole words, in order');
  assert.deepEqual(fitted.learned, [], 'no learned word takes room one of yours could not have');
  assert.equal(prompt, `${fitted.words.join(', ')}.`);
});

test('the list is written for the voice service, and only when it changes', () => {
  const root = vault({voiceWords: ['Jev']}), file = path.join(scratch, 'runtime-a', 'voice-words.json');
  const first = writeVoiceWords(root, {file, entries, now: NOW});
  assert.equal(first.words[0], 'Jev'); assert.ok(first.words.includes('Zettelkasten'));
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.prompt, `${first.words.join(', ')}.`); assert.deepEqual(written.words, first.words);
  const stamp = fs.statSync(file).mtimeMs;
  fs.utimesSync(file, new Date(1000), new Date(1000));
  writeVoiceWords(root, {file, entries, now: NOW + DAY});
  assert.equal(fs.statSync(file).mtimeMs, 1000, 'an unchanged list is not rewritten');
  writeVoiceWords(root, {file, entries: [...entries, note('z/2026-11-17-kokoro-a.md'), note('z/2026-11-18-kokoro-b.md')], now: NOW});
  assert.notEqual(fs.statSync(file).mtimeMs, 1000); assert.ok(stamp > 0);
  assert.match(JSON.parse(fs.readFileSync(file, 'utf8')).prompt, /Kokoro/);
  // A vault with nothing to learn writes an empty hint, which the voice service treats as none.
  const empty = path.join(scratch, 'runtime-b', 'voice-words.json');
  writeVoiceWords(vault(), {file: empty, entries: [], now: NOW});
  assert.equal(JSON.parse(fs.readFileSync(empty, 'utf8')).prompt, '');
  assert.deepEqual(fs.readdirSync(path.dirname(empty)), ['voice-words.json'], 'no temporary file is left behind');
});

test('teaching and forgetting change only those lines of the profile', () => {
  const root = vault({dailyDrivers: ['Inbox triage', 'Deep work block'], speechLanguage: 'pt'});
  saveVoiceWords(root, {add: ['Jev', 'Zettelkasten']});
  saveVoiceWords(root, {add: ['jev'], forget: ['Skool']});
  assert.deepEqual(profileOf(root), {dailyDrivers: ['Inbox triage', 'Deep work block'], speechLanguage: 'pt', voiceWords: ['jev', 'Zettelkasten'], voiceWordsIgnore: ['Skool']}, 'the newest spelling of a word replaces the old one');
  assert.deepEqual(dailyDrivers(root), ['Inbox triage', 'Deep work block']);
  // Forgetting a word you taught removes it from your list; teaching a forgotten word brings it back.
  saveVoiceWords(root, {forget: ['Zettelkasten']});
  assert.deepEqual(profileOf(root).voiceWords, ['jev']); assert.deepEqual(profileOf(root).voiceWordsIgnore, ['Skool', 'Zettelkasten']);
  saveVoiceWords(root, {add: ['Skool']});
  assert.deepEqual(profileOf(root).voiceWordsIgnore, ['Zettelkasten']);
  // "Learn again" for a forgotten word without adding it to your own list.
  saveVoiceWords(root, {restore: ['zettelkasten']});
  assert.equal(profileOf(root).voiceWordsIgnore, undefined);
  saveVoiceWords(root, {learn: false}); assert.equal(profileOf(root).voiceWordsLearn, false);
  saveVoiceWords(root, {learn: true}); assert.equal(profileOf(root).voiceWordsLearn, undefined);
  saveVoiceWords(root, {forget: ['jev', 'Skool'], restore: ['jev', 'Skool']});
  assert.deepEqual(profileOf(root), {dailyDrivers: ['Inbox triage', 'Deep work block'], speechLanguage: 'pt'}, 'back to nothing leaves no trace');
  // Bad input and an unreadable profile change nothing.
  for (const [input, message] of [[{add: 'Jev'}, /must be a list/], [{add: ['J']}, /at least two letters/], [{add: [5]}, /at least two letters/], [{learn: 'no'}, /true or false/], [{add: Array.from({length: 70}, (_, index) => `Word${index}x`)}, /60 of your own words/]])
    assert.throws(() => saveVoiceWords(root, input), message);
  assert.deepEqual(profileOf(root), {dailyDrivers: ['Inbox triage', 'Deep work block'], speechLanguage: 'pt'});
  const broken = vault('{"dailyDrivers": [');
  assert.throws(() => saveVoiceWords(broken, {add: ['Jev']}), /not valid JSON, so nothing was saved/);
  assert.equal(fs.readFileSync(path.join(broken, 'system', 'v2', 'profile.json'), 'utf8'), '{"dailyDrivers": [');
  // A vault with no profile yet gets one.
  const fresh = vault(); saveVoiceWords(fresh, {add: ['Jev']}); assert.deepEqual(profileOf(fresh), {voiceWords: ['Jev']});
  // Markup and control characters never reach the hint.
  saveVoiceWords(fresh, {add: ['<b>Kokoro</b>\n']}); assert.deepEqual(profileOf(fresh).voiceWords, ['Jev', 'bKokorob']);
});
