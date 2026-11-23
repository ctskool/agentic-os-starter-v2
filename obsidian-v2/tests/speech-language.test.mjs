import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SPEECH_LANGUAGES, SPEECH_LANGUAGE_CODES, speechLanguage, speechArguments, speechCheck} from '../shared/speech-language.mjs';
import {layout, desiredServices} from '../scripts/aos/services.mjs';
import {setupSpeech} from '../scripts/aos/speech.mjs';
import {prepareVoice} from '../scripts/aos/setup.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-speech-language-'));
test.after(() => fs.rmSync(scratch, {recursive: true, force: true}));
const vaultWith = text => { const vault = fs.mkdtempSync(path.join(scratch, 'vault-')); if (text !== undefined) { fs.mkdirSync(path.join(vault, 'system', 'v2'), {recursive: true}); fs.writeFileSync(path.join(vault, 'system', 'v2', 'profile.json'), text); } return vault; };

test('English is the language unless the vault names another one we support', () => {
  assert.deepEqual(speechLanguage(null), {code: 'en', asked: null, known: true});
  assert.deepEqual(speechLanguage(vaultWith(undefined)), {code: 'en', asked: null, known: true}, 'no profile');
  assert.deepEqual(speechLanguage(vaultWith('not json')), {code: 'en', asked: null, known: true});
  assert.deepEqual(speechLanguage(vaultWith('{"dailyDrivers":["Inbox triage"]}')), {code: 'en', asked: null, known: true}, 'a profile that says nothing about language');
  assert.deepEqual(speechLanguage(vaultWith('{"speechLanguage":"pt"}')), {code: 'pt', asked: 'pt', known: true});
  assert.deepEqual(speechLanguage(vaultWith('\uFEFF{"speechLanguage":" PT "}')), {code: 'pt', asked: 'pt', known: true}, 'a byte-order mark, capitals and spaces');
  assert.deepEqual(speechLanguage(vaultWith('{"speechLanguage":"klingon"}')), {code: 'en', asked: 'klingon', known: false}, 'an unknown language runs English and is reported');
  for (const value of ['{"speechLanguage":5}', '{"speechLanguage":""}', '{"speechLanguage":null}', '{"speechLanguage":["pt"]}']) assert.equal(speechLanguage(vaultWith(value)).code, 'en', value);
  assert.equal(speechLanguage(vaultWith('{"speechLanguage":"__proto__"}')).known, false);
});

test('every language has a voice, a model and a check that survives speech-to-text', () => {
  assert.deepEqual(SPEECH_LANGUAGE_CODES, ['en', 'es', 'fr', 'it', 'pt']);
  for (const [code, language] of Object.entries(SPEECH_LANGUAGES)) {
    assert.equal(language.whisper, code === 'en' ? 'small.en' : 'small', 'only English may use the English-only model');
    assert.match(language.voice, /^[a-z]{2}_[a-z]+$/);
    const check = speechCheck(code);
    assert.equal(check.phrase, language.phrase);
    assert.ok(check.heard(language.phrase), `${code}: its own phrase`);
    // Numerals come back as digits and accents are not guaranteed, so neither may decide the check.
    assert.ok(check.heard(language.phrase.split(',')[0].normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase() + ' 1, 2, 3.'), `${code}: digits, no accents, capitals`);
    assert.equal(check.heard(''), false);
    assert.equal(check.heard('1, 2, 3.'), false, `${code}: numerals alone prove nothing`);
    if (code !== 'en') for (const word of language.heard) assert.doesNotMatch(word, /^(uno|dos|tres|un|deux|trois|due|tre|um|dois)$/);
  }
  assert.equal(speechCheck('pt').heard('Voice check 123'), false, 'English words are not Portuguese heard back');
  assert.equal(speechCheck('klingon').phrase, SPEECH_LANGUAGES.en.phrase);
  // English accepts everything the check accepted before the language setting existed.
  for (const before of ['Voice Check 123', 'One two three.', 'check']) assert.equal(speechCheck('en').heard(before), true, before);
});

test('English adds nothing to the voice command; another language adds all four settings together', () => {
  const at = layout(path.resolve('/x/aos/obsidian-v2'));
  const speech = options => desiredServices(at, {ownSpeech: true, ...options}).find(service => service.id === 'speech').args;
  const english = ['-u', at.speechScript, '--assets', at.speechAssets];
  assert.deepEqual(speech({}), english, 'an installation without the setting keeps the exact command it already runs');
  assert.deepEqual(speech({language: 'en'}), english);
  assert.deepEqual(speech({language: 'klingon'}), english);
  assert.deepEqual(speech({language: 'pt'}), [...english, '--language', 'pt', '--whisper-model', 'small', '--voice', 'pf_dora', '--kokoro-lang', 'pt-br']);
  assert.deepEqual(speechArguments('fr'), ['--language', 'fr', '--whisper-model', 'small', '--voice', 'ff_siwis', '--kokoro-lang', 'fr-fr']);
  assert.deepEqual(speechArguments('toString'), []);
});

test('setup fetches the English model always, and the other language\'s model only when asked', async () => {
  const fetched = language => {
    const at = layout(path.join(fs.mkdtempSync(path.join(scratch, 'install-')), 'obsidian-v2'));
    fs.mkdirSync(path.dirname(at.speechPython), {recursive: true}); fs.writeFileSync(at.speechPython, '');
    fs.mkdirSync(at.speechAssets, {recursive: true});
    for (const [name, bytes] of [['kokoro-v1.0.onnx', 200e6], ['voices-v1.0.bin', 10e6]]) { const file = path.join(at.speechAssets, name); fs.writeFileSync(file, ''); fs.truncateSync(file, bytes); }
    const models = [];
    const run = (command, args) => { const model = /WhisperModel\('([^']+)'/.exec(args.join(' ')); if (model) models.push(model[1]); return {status: 0, stdout: args.includes('--version') || /version/.test(args.join(' ')) ? 'Python 3.12.4' : 'ready'}; };
    return setupSpeech(at, {log: () => {}, run, ...(language ? {language} : {})}).then(() => models);
  };
  assert.deepEqual(await fetched(), ['small.en']);
  assert.deepEqual(await fetched('en'), ['small.en']);
  assert.deepEqual(await fetched('pt'), ['small.en', 'small'], 'English stays: it is what the service falls back to');
  assert.deepEqual(await fetched('klingon'), ['small.en']);
});

test('the vault\'s language reaches the voice installer', async () => {
  const at = layout(path.join(fs.mkdtempSync(path.join(scratch, 'install-')), 'obsidian-v2'));
  fs.mkdirSync(at.runtime, {recursive: true});
  const asked = [];
  const options = {wantVoice: true, explicit: true, log: () => {}, plan: async () => ({own: true, shared: false, healthy: false, url: null}), installVoice: async (_at, given) => { asked.push(given.language); return true; },
    installed: () => true, setAside: async () => ({state: 'ok'}), removeAside: () => {}, busy: async () => false, inUse: () => []};
  await prepareVoice(at, {...options, language: 'pt'});
  await prepareVoice(at, options);
  assert.deepEqual(asked, ['pt', 'en']);
});
