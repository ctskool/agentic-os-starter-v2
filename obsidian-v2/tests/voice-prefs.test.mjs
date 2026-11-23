import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createJiti} from 'jiti';
import {readVoicePrefs, saveVoicePrefs, voicePrefsFrom, speakPrefsQuery, voiceLabel, voiceChoices, VOICE_PREFS_DEFAULTS} from '../runner/voice-prefs.mjs';
import {dailyDrivers} from '../runner/profile.mjs';
import {speechLanguage} from '../shared/speech-language.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-voice-prefs-'));
test.after(() => fs.rmSync(scratch, {recursive: true, force: true}));
const vault = profile => { const root = fs.mkdtempSync(path.join(scratch, 'vault-')); if (profile !== undefined) { fs.mkdirSync(path.join(root, 'system', 'v2'), {recursive: true}); fs.writeFileSync(path.join(root, 'system', 'v2', 'profile.json'), typeof profile === 'string' ? profile : JSON.stringify(profile)); } return root; };
const saved = root => JSON.parse(fs.readFileSync(path.join(root, 'system', 'v2', 'profile.json'), 'utf8'));

test('a vault that says nothing speaks, in the default voice, at normal speed', () => {
  assert.deepEqual(readVoicePrefs(vault()), VOICE_PREFS_DEFAULTS);
  assert.deepEqual(readVoicePrefs(vault('not json')), VOICE_PREFS_DEFAULTS, 'an unreadable profile never silences voice');
  assert.deepEqual(readVoicePrefs(vault({dailyDrivers: ['Inbox triage']})), VOICE_PREFS_DEFAULTS);
  assert.deepEqual(voicePrefsFrom({spokenReplies: 'no', voice: '../../etc', voiceRate: 'fast'}), VOICE_PREFS_DEFAULTS, 'only valid values count');
  assert.deepEqual(voicePrefsFrom({spokenReplies: false, voice: 'af_heart', voiceRate: 1.234}), {...VOICE_PREFS_DEFAULTS, spokenReplies: false, voice: 'af_heart', rate: 1.23});
  assert.equal(voicePrefsFrom({voiceRate: 9}).rate, 1.4); assert.equal(voicePrefsFrom({voiceRate: 0.1}).rate, 0.8);
});

test('saving a voice setting keeps everything else the member put in their profile', () => {
  const root = vault({dailyDrivers: ['Inbox triage', 'Deep work block'], speechLanguage: 'pt', cta: 'Join the community.'});
  assert.deepEqual(saveVoicePrefs(root, {spokenReplies: false}), {...VOICE_PREFS_DEFAULTS, spokenReplies: false, voice: null, rate: 1});
  assert.deepEqual(saveVoicePrefs(root, {voice: 'pm_alex', rate: 1.2}), {...VOICE_PREFS_DEFAULTS, spokenReplies: false, voice: 'pm_alex', rate: 1.2});
  assert.deepEqual(saved(root), {dailyDrivers: ['Inbox triage', 'Deep work block'], speechLanguage: 'pt', cta: 'Join the community.', spokenReplies: false, voice: 'pm_alex', voiceRate: 1.2});
  assert.deepEqual(dailyDrivers(root), ['Inbox triage', 'Deep work block']); assert.equal(speechLanguage(root).code, 'pt');
  // Back to the defaults removes the lines again instead of leaving noise in the member's file.
  assert.deepEqual(saveVoicePrefs(root, {spokenReplies: true, voice: null, rate: 1}), VOICE_PREFS_DEFAULTS);
  assert.deepEqual(saved(root), {dailyDrivers: ['Inbox triage', 'Deep work block'], speechLanguage: 'pt', cta: 'Join the community.'});
  // A vault with no profile yet gets one.
  const fresh = vault();
  assert.equal(saveVoicePrefs(fresh, {spokenReplies: false}).spokenReplies, false);
  assert.deepEqual(saved(fresh), {spokenReplies: false});
  assert.deepEqual(fs.readdirSync(path.join(fresh, 'system', 'v2')), ['profile.json'], 'no temporary file is left behind');
});

test('a bad value or an unreadable profile changes nothing', () => {
  const root = vault({dailyDrivers: ['Inbox triage']}), before = fs.readFileSync(path.join(root, 'system', 'v2', 'profile.json'), 'utf8');
  for (const [changes, message] of [[{spokenReplies: 'off'}, /true or false/], [{voice: '../x'}, /not a voice name/], [{voice: 5}, /not a voice name/], [{rate: 3}, /between 0\.8 and 1\.4/], [{rate: '1'}, /between/], [{volume: 2}, /Unknown voice setting/], [null, /must be an object/], [[], /must be an object/]])
    assert.throws(() => saveVoicePrefs(root, changes), message);
  assert.equal(fs.readFileSync(path.join(root, 'system', 'v2', 'profile.json'), 'utf8'), before);
  // One bad setting among good ones saves none of them.
  assert.throws(() => saveVoicePrefs(root, {spokenReplies: false, rate: 99}), /between/);
  assert.equal(fs.readFileSync(path.join(root, 'system', 'v2', 'profile.json'), 'utf8'), before);
  const broken = vault('{"dailyDrivers": ["Inbox triage"],');
  assert.throws(() => saveVoicePrefs(broken, {spokenReplies: false}), /not valid JSON, so the voice setting was not saved/);
  assert.equal(fs.readFileSync(path.join(broken, 'system', 'v2', 'profile.json'), 'utf8'), '{"dailyDrivers": ["Inbox triage"],', 'the member\'s file is left exactly as it was');
});

test('settings behind a linked folder are refused, and two programs saving at once keep both changes', t => {
  // The command line teaching a word while a screen switches spoken replies off: both lines survive.
  const root = vault({dailyDrivers: ['Inbox triage']});
  saveVoicePrefs(root, {spokenReplies: false});
  saveVoicePrefs(root, {rate: 1.2});
  assert.deepEqual(saved(root), {dailyDrivers: ['Inbox triage'], spokenReplies: false, voiceRate: 1.2});
  assert.equal(fs.existsSync(path.join(root, 'system', 'v2', 'profile.json.lock')), false, 'the lock is released');
  // While another program holds the profile, a save waits and then says so instead of writing over it.
  fs.writeFileSync(path.join(root, 'system', 'v2', 'profile.json.lock'), '');
  const started = Date.now();
  assert.throws(() => saveVoicePrefs(root, {spokenReplies: true}), /Another program is saving this setting right now/);
  assert.ok(Date.now() - started >= 1000, 'it waited first');
  fs.rmSync(path.join(root, 'system', 'v2', 'profile.json.lock'));
  assert.equal(saved(root).spokenReplies, false);

  const linked = vault(), elsewhere = fs.mkdtempSync(path.join(scratch, 'elsewhere-'));
  fs.mkdirSync(path.join(linked, 'system'), {recursive: true});
  try { fs.symlinkSync(elsewhere, path.join(linked, 'system', 'v2'), 'junction'); } catch { t.skip('this computer does not allow creating a linked folder'); return; }
  fs.writeFileSync(path.join(elsewhere, 'profile.json'), '{"spokenReplies":false}');
  assert.deepEqual(readVoicePrefs(linked), VOICE_PREFS_DEFAULTS, 'a profile reached through a link is not read');
  assert.throws(() => saveVoicePrefs(linked, {spokenReplies: false}), /Linked paths are not allowed/);
  assert.equal(fs.readFileSync(path.join(elsewhere, 'profile.json'), 'utf8'), '{"spokenReplies":false}');
});

test('the voice service is told the choice only when there is one', () => {
  assert.equal(speakPrefsQuery(VOICE_PREFS_DEFAULTS), '', 'an untouched vault sends exactly what it sent before');
  assert.equal(speakPrefsQuery({spokenReplies: true, voice: 'af_heart', rate: 1}), '&voice=af_heart');
  assert.equal(speakPrefsQuery({spokenReplies: true, voice: null, rate: 1.2}), '&speed=1.2');
  assert.equal(speakPrefsQuery({spokenReplies: false, voice: 'bm_lewis', rate: 0.9}), '&voice=bm_lewis&speed=0.9');
});

test('voices are listed with a name a person can read', () => {
  assert.equal(voiceLabel('bm_george'), 'George · British, male');
  assert.equal(voiceLabel('af_heart'), 'Heart · American, female');
  assert.equal(voiceLabel('pf_dora'), 'Dora · Portuguese, female');
  assert.equal(voiceLabel('not a voice'), 'not a voice');
  assert.deepEqual(voiceChoices({language: 'en', default: 'bm_george', voices: ['af_heart', 'bm_george', '<script>', 7]}),
    {language: 'en', fallback: 'bm_george', voices: [{id: 'af_heart', label: 'Heart · American, female', group: 'American', name: 'Heart (female)'}, {id: 'bm_george', label: 'George · British, male', group: 'British', name: 'George (male)'}]});
  assert.deepEqual(voiceChoices(null), {language: 'en', fallback: null, voices: []}, 'a voice service that cannot list its voices offers none');
});

const jiti = createJiti(import.meta.url, {fsCache: false});
const {VoiceSession} = jiti('../shared/voice-session.ts');
test('with spoken replies off the reply is written and its links appear, and no sound is requested', async () => {
  const calls = [], states = [], revealed = [], messages = [];
  const reveals = [{kind: 'link', target: 'https://example.com', label: 'Example', at: 3}];
  const voice = new VoiceSession(async (route, options) => { calls.push(route); return {status: 200, json: {reply: 'The saved headline is available.', reveals}}; }, async () => ({provider: 'claude', model: 'haiku'}));
  voice.onState = mode => states.push(mode); voice.onReveal = item => revealed.push(item); voice.onMessage = text => messages.push(text);
  voice.muted = true;
  voice.connect();
  await voice.sendText('Read the headline');
  assert.equal(voice.mode, 'idle');
  assert.deepEqual(messages, ['The saved headline is available.']);
  assert.deepEqual(revealed, reveals, 'links that normally appear in time with the speech appear at once');
  assert.ok(!calls.includes('/voice/speak'), 'no audio was requested');
  assert.ok(!states.includes('speaking'));
  assert.equal(await voice.speak('Anything at all.'), true, 'a muted announcement counts as delivered, so it is not retried');
  await voice.destroy();
  // A screen that has not heard about the setting yet asks for audio, is told the vault is muted, and
  // treats that as said: no error, the links appear, and it stops asking.
  // (Node has no audio device; the session only needs one to exist before it asks the bridge.)
  const hadContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  globalThis.AudioContext = class { state = 'running'; destination = {}; resume() { return Promise.resolve(); } close() { return Promise.resolve(); } };
  const late = [], shown = [], errors = [];
  const unaware = new VoiceSession(async route => { late.push(route); return route === '/voice/speak' ? {status: 200, json: {muted: true}} : {status: 200, json: {reply: 'Done.'}}; }, async () => ({provider: 'claude', model: 'haiku'}));
  unaware.onReveal = item => shown.push(item); unaware.onMessage = (text, isError) => { if (isError) errors.push(text); };
  assert.equal(unaware.muted, false);
  assert.equal(await unaware.speak('The saved headline is available.', undefined, reveals), true);
  assert.equal(unaware.muted, true); assert.deepEqual(shown, reveals); assert.deepEqual(errors, []); assert.equal(unaware.mode, 'idle');
  const asked = late.filter(route => route === '/voice/speak').length;
  await unaware.speak('Again.'); assert.equal(late.filter(route => route === '/voice/speak').length, asked, 'it does not ask again');
  await unaware.destroy();
  // Switched off while a reply is still loading: that reply is never spoken, and what it had not shown yet is shown.
  let release; const loading = new Promise(resolve => { release = resolve; });
  const midway = [], modes = [];
  const busy = new VoiceSession(async route => route === '/voice/speak' ? loading : {status: 200, json: {reply: 'Done.'}}, async () => ({provider: 'claude', model: 'haiku'}));
  busy.onReveal = item => midway.push(item); busy.onState = mode => modes.push(mode);
  const speaking = busy.speak('The saved headline is available.', undefined, reveals);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(busy.mode, 'working'); assert.deepEqual(midway, []);
  busy.setMuted(true);
  assert.deepEqual(midway, reveals, 'its links appear at once'); assert.equal(busy.mode, 'idle');
  release({status: 200, audio: new ArrayBuffer(8)});
  assert.equal(await speaking, false); assert.ok(!modes.includes('speaking'), 'nothing was spoken after the switch');
  busy.setMuted(false); assert.equal(busy.muted, false);
  await busy.destroy();
  if (hadContext) Object.defineProperty(globalThis, 'AudioContext', hadContext); else delete globalThis.AudioContext;
});

const {createVoicePrefsStore, voiceGroups, rateLabel} = jiti('../shared/voice-prefs.ts');
test('both screens read the same settings, show only what was really saved, and an older bridge shows none', async () => {
  let saved = {spokenReplies: true, voice: null, rate: 1}, voicesAsked = 0;
  const voices = [{id: 'af_heart', label: 'Heart · American, female', group: 'American', name: 'Heart (female)'}, {id: 'bm_george', label: 'George · British, male', group: 'British', name: 'George (male)'}, {id: 'bm_lewis', label: 'Lewis · British, male', group: 'British', name: 'Lewis (male)'}];
  const bridge = async (route, options = {}) => {
    if (route === '/voice/voices') { voicesAsked++; return {status: 200, json: {language: 'en', fallback: 'bm_george', voices}}; }
    if (route !== '/voice/prefs') return {status: 404, json: {error: 'not found'}};
    if (options.method !== 'POST') return {status: 200, json: saved};
    const changes = JSON.parse(options.body);
    if (changes.rate > 1.4) return {status: 400, json: {error: 'Speed must be between 0.8 and 1.4.'}};
    saved = {...saved, ...changes}; return {status: 200, json: saved};
  };
  const first = createVoicePrefsStore(bridge), second = createVoicePrefsStore(bridge);
  assert.equal(first.getSnapshot().ready, false, 'nothing is shown before the bridge has answered');
  await first.refresh(); await second.refresh();
  assert.equal(first.getSnapshot().ready, true);
  assert.deepEqual(first.getSnapshot().prefs, {spokenReplies: true, voice: null, rate: 1});
  assert.equal(first.getSnapshot().fallback, 'bm_george');
  assert.deepEqual(voiceGroups(first.getSnapshot().voices).map(set => [set.group, set.voices.map(voice => voice.name)]), [['American', ['Heart (female)']], ['British', ['George (male)', 'Lewis (male)']]]);
  // A change saved on one screen...
  assert.deepEqual(await first.save({spokenReplies: false, voice: 'af_heart'}), {spokenReplies: false, voice: 'af_heart', rate: 1});
  assert.equal(first.getSnapshot().prefs.spokenReplies, false);
  // ...shows on the other at its next poll, and the list of voices is not asked for again.
  await second.refresh();
  assert.deepEqual(second.getSnapshot().prefs, {spokenReplies: false, voice: 'af_heart', rate: 1});
  await first.refresh(); assert.equal(voicesAsked, 2, 'once per screen');
  // A refused change is an error the screen can show, and nothing changes.
  await assert.rejects(first.save({rate: 3}), /between 0\.8 and 1\.4/);
  assert.equal(first.getSnapshot().prefs.rate, 1);
  // An older bridge has no voice settings: the controls are simply not shown.
  const old = createVoicePrefsStore(async () => ({status: 404, json: {error: 'Unknown route'}}));
  await old.refresh(); assert.equal(old.getSnapshot().ready, false);
  const down = createVoicePrefsStore(async () => { throw new Error('offline'); });
  await down.refresh(); assert.equal(down.getSnapshot().ready, false);
  assert.equal(rateLabel(1), 'Normal'); assert.equal(rateLabel(0.9), 'Slower (0.9×)'); assert.equal(rateLabel(1.2), 'Faster (1.2×)');
});

test('the shared preferences store only shows Live fields returned by the bridge', async () => {
  const local = {spokenReplies: true, voice: null, rate: 1};
  const live = {voiceMode: 'live', liveVoice: 'cedar', liveConfirm: 'click', liveIdleMic: 'muted', liveIdleHangupMin: 15, liveCarryToday: false};
  let saved = {...local, ...live};
  const store = createVoicePrefsStore(async (route, options) => {
    if (route === '/voice/voices') return {status: 200, json: {voices: [{id: 'af_heart', label: 'Heart'}]}};
    if (options?.method === 'POST') saved = {...saved, liveConfirm: 'destructive'};
    return {status: 200, json: saved};
  });
  assert.deepEqual(store.getSnapshot().prefs, local);
  await store.refresh();
  assert.deepEqual(store.getSnapshot().prefs, {...local, ...live});
  assert.deepEqual(await store.save({liveConfirm: 'voice'}), {...local, ...live, liveConfirm: 'destructive'});

  saved = {...local, liveCarryToday: false};
  await store.refresh();
  assert.deepEqual(store.getSnapshot().prefs, saved);
  saved = local;
  await store.refresh();
  assert.deepEqual(store.getSnapshot().prefs, local);
});
