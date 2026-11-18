// Jarvis learns your words.
//
// Speech-to-text mishears names it has never seen: one member's "Jev" kept arriving as "Jeff". The words a
// person actually uses are sitting in their vault, in the names of their notes. This collects the unusual
// ones and hands them to the voice service as a short list to listen for. Nothing leaves the computer: the
// list is a file in .runtime/, read by the local voice service.
//
//   learned  - from note and folder names: words that keep coming up and are not everyday English
//   yours    - "voiceWords": ["Jev", "Zettelkasten"] in system/v2/profile.json, always included, in your spelling
//   ignored  - "voiceWordsIgnore": ["draft"] in the same file: never listened for (the "forget" button)
//   off      - "voiceWordsLearn": false keeps only your own list
//
// The list is short on purpose. Speech-to-text takes a hint of about 220 word-pieces; more than that is
// cut off, and a long list makes it hear the listed words where they were not said.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {projectRoot} from './runtime.mjs';
import {targetIndex} from './voice-targets.mjs';
import {EVERYDAY_WORDS} from './voice-everyday-words.mjs';
import {vaultPath} from './core.mjs';
import {withFileLock} from './file-lock.mjs';

export const VOICE_WORDS_LIMIT = 60;
// The hint itself is kept to this many characters, at whole words, your own words first. The voice service
// refuses a longer one outright, and speech-to-text would cut it off anyway.
export const VOICE_PROMPT_LIMIT = 500;
const MAX_ENTRIES = 40000;
const profileFile = vault => vaultPath(path.resolve(vault), 'system/v2/profile.json');
export const voiceWordsFile = (root = projectRoot) => path.join(root, '.runtime', 'voice-words.json');

const EVERYDAY = EVERYDAY_WORDS;

const cleanWord = value => typeof value === 'string' ? value.normalize('NFKC').replace(/[^\p{L}\p{N} .&'’+-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
const key = word => word.toLowerCase();
const shown = token => token.length <= 3 && /^[a-z]+$/.test(token) && !/[aeiouy]/.test(token) ? token.toUpperCase() : token[0].toUpperCase() + token.slice(1);

// The member's own settings for this, read from their profile. Anything unreadable means "learn, nothing extra".
export function voiceWordSettings(vault, {read = fs.readFileSync} = {}) {
  let profile = {};
  try { const value = JSON.parse(String(read(profileFile(vault), 'utf8')).replace(/^\uFEFF/, '')); if (value && typeof value === 'object' && !Array.isArray(value)) profile = value; } catch { /* defaults */ }
  const list = value => [...new Map((Array.isArray(value) ? value : []).map(cleanWord).filter(word => word.length >= 2).slice(0, 200).map(word => [key(word), word])).values()];
  return {learn: profile.voiceWordsLearn !== false, yours: list(profile.voiceWords).slice(0, VOICE_WORDS_LIMIT), ignored: list(profile.voiceWordsIgnore)};
}

// Pure: from the vault's file index (voice-targets.mjs) to the words worth listening for, best first.
// A word counts once per note or folder name it appears in; recent notes count for more; a word that
// appears only once in the whole vault is as likely a typo as a name, so it waits for a second sighting.
export function learnVoiceWords(entries, {now = Date.now(), limit = VOICE_WORDS_LIMIT, ignored = []} = {}) {
  const skip = new Set(ignored.map(key)), score = new Map(), seen = new Map();
  const month = 30 * 24 * 60 * 60 * 1000;
  for (const entry of (entries || []).slice(0, MAX_ENTRIES)) {
    if (entry.archived || entry.index) continue;
    const age = entry.mtime ? Math.max(0, now - entry.mtime) : 12 * month;
    const weight = age < month ? 3 : age < 3 * month ? 2 : 1;
    for (const token of new Set([...(entry.tokens || []), ...(entry.folderTokens || [])])) {
      // "frame3" and "v2" are file numbering, not words anyone says.
      if (token.length < 3 || token.length > 24 || /^\d+$/.test(token) || /^[a-z]+\d+$/.test(token) || /^v?\d/.test(token) && !/[a-z]{2}/.test(token) || EVERYDAY.has(token) || skip.has(token)) continue;
      score.set(token, (score.get(token) || 0) + weight); seen.set(token, (seen.get(token) || 0) + 1);
    }
  }
  return [...score.entries()].filter(([token]) => seen.get(token) >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([token]) => shown(token));
}

// What the voice service is given: your own words first (in your spelling), then the learned ones, without
// repeats, cut to the room there is.
export function voiceWordList(vault, {entries, now = Date.now(), settings = voiceWordSettings(vault)} = {}) {
  const learned = settings.learn ? learnVoiceWords(entries ?? targetIndex(vault, {now}), {now, ignored: [...settings.ignored, ...settings.yours]}) : [];
  const skip = new Set(settings.ignored.map(key));
  const yours = settings.yours.filter(word => !skip.has(key(word)));
  // As many as fit the hint, in order: every one of your own words that fits comes before any learned one.
  const words = [];
  let length = 0;
  for (const word of [...yours, ...learned].slice(0, VOICE_WORDS_LIMIT)) { if (length + word.length + 2 > VOICE_PROMPT_LIMIT) break; words.push(word); length += word.length + 2; }
  const kept = new Set(words);
  return {words, yours: yours.filter(word => kept.has(word)), learned: learned.filter(word => kept.has(word)), ignored: settings.ignored, learn: settings.learn};
}

// Written where the local voice service looks for it (next to its own files). Only rewritten when the list
// changes, so the voice service is not made to re-read it for nothing.
export function writeVoiceWords(vault, {file = voiceWordsFile(), now = Date.now(), entries} = {}) {
  const list = voiceWordList(vault, {entries, now});
  const prompt = list.words.length ? `${list.words.join(', ')}.` : '';
  let before = null; try { before = JSON.parse(fs.readFileSync(file, 'utf8')).prompt; } catch { /* first time */ }
  if (before !== prompt) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({updated: new Date(now).toISOString(), prompt, words: list.words}, null, 1));
    try { fs.renameSync(temporary, file); } catch (error) { try { fs.unlinkSync(temporary); } catch { /* nothing to remove */ } throw error; }
  }
  return list;
}

// The "teach" and "forget" buttons. Changes only these lines of the member's profile and never overwrites a
// profile it cannot read.
export function saveVoiceWords(vault, changes = {}) {
  // Read, change and write back as one step: the bridge and `node aos.mjs voice` may both be saving.
  return withFileLock(profileFile(vault), () => saveVoiceWordsLocked(vault, changes));
}
function saveVoiceWordsLocked(vault, {add = [], forget = [], restore = [], learn} = {}) {
  const file = profileFile(vault);
  let profile = {};
  try { profile = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('not an object'); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('system/v2/profile.json in this vault is not valid JSON, so nothing was saved. Fix or remove that file first.'); profile = {}; }
  const words = value => { if (!Array.isArray(value)) throw new Error('Words must be a list.'); const cleaned = value.map(cleanWord); if (cleaned.some(word => word.length < 2)) throw new Error('A word needs at least two letters.'); return cleaned; };
  const merge = (current, extra) => [...new Map([...(Array.isArray(current) ? current.map(cleanWord).filter(Boolean) : []), ...extra].map(word => [key(word), word])).values()];
  const without = (current, gone) => { const drop = new Set(gone.map(key)); return (Array.isArray(current) ? current.map(cleanWord).filter(Boolean) : []).filter(word => !drop.has(key(word))); };
  const adding = words(add), forgetting = words(forget), restoring = words(restore);
  // Teaching a word you once told it to forget brings it back; forgetting a word you taught removes it.
  let yours = without(merge(profile.voiceWords, adding), forgetting), ignored = without(merge(profile.voiceWordsIgnore, forgetting), [...adding, ...restoring]);
  if (yours.length > VOICE_WORDS_LIMIT) throw new Error(`Voice can listen for ${VOICE_WORDS_LIMIT} of your own words at most. Remove some first.`);
  if (yours.length) profile.voiceWords = yours; else delete profile.voiceWords;
  if (ignored.length) profile.voiceWordsIgnore = ignored.slice(0, 200); else delete profile.voiceWordsIgnore;
  if (learn !== undefined) { if (typeof learn !== 'boolean') throw new Error('learn takes true or false.'); if (learn) delete profile.voiceWordsLearn; else profile.voiceWordsLearn = false; }
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(profile, null, 1));
  try { fs.renameSync(temporary, file); } catch (error) { try { fs.unlinkSync(temporary); } catch { /* nothing to remove */ } throw error; }
}
