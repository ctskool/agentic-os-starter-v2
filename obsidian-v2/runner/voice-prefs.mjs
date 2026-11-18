// How voice sounds in this vault, shared by both screens and kept in system/v2/profile.json next to the
// member's other preferences:
//
//   "spokenReplies": false   - replies are written but not spoken (requested by a member who works in
//                              shared rooms and on calls). Hearing, the shortcut and everything else stay on.
//   "voice": "af_heart"      - which of the voices that already ship is used. Unset = the language's default.
//   "voiceRate": 1.1         - how fast it speaks (0.8 to 1.4). Unset = 1.
//
// Nothing here restarts anything: the choice travels with each request to the voice service.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {vaultPath} from './core.mjs';
import {withFileLock} from './file-lock.mjs';

export const VOICE_RATE = Object.freeze({min: 0.8, max: 1.4, fallback: 1});
export const VOICE_PREFS_DEFAULTS = Object.freeze({spokenReplies: true, voice: null, rate: 1});
const VOICE_ID = /^[a-z]{2}_[a-z0-9]{1,30}$/;
// Inside the vault, and never through a linked folder: two vaults sharing one linked system folder would
// otherwise overwrite each other's settings.
const profileFile = root => vaultPath(path.resolve(root), 'system/v2/profile.json');

const readProfile = (root, {missingOk = true} = {}) => {
  let text;
  try { text = fs.readFileSync(profileFile(root), 'utf8'); } catch (error) { if (error.code === 'ENOENT' && missingOk) return {}; throw error; }
  const value = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
  return value;
};

// Pure: whatever the profile holds, the three settings come out valid.
export function voicePrefsFrom(profile) {
  const rate = typeof profile?.voiceRate === 'number' && Number.isFinite(profile.voiceRate) ? Math.min(VOICE_RATE.max, Math.max(VOICE_RATE.min, Math.round(profile.voiceRate * 100) / 100)) : VOICE_RATE.fallback;
  return {spokenReplies: profile?.spokenReplies !== false, voice: typeof profile?.voice === 'string' && VOICE_ID.test(profile.voice) ? profile.voice : null, rate};
}

// A missing or unreadable profile means the defaults: voice must never stop working over a preference.
export function readVoicePrefs(root) {
  try { return voicePrefsFrom(readProfile(root)); } catch { return {...VOICE_PREFS_DEFAULTS}; }
}

// Changes only the named settings and keeps everything else in the member's profile untouched. A profile
// that exists but cannot be read is never overwritten: the member's Daily Drivers live in the same file.
export function saveVoicePrefs(root, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Voice settings must be an object.');
  // Read, change and write back as one step: the bridge and `node aos.mjs voice` may both be saving.
  return withFileLock(profileFile(root), () => saveVoicePrefsLocked(root, changes));
}
function saveVoicePrefsLocked(root, changes) {
  let profile;
  try { profile = readProfile(root); } catch { throw new Error('system/v2/profile.json in this vault is not valid JSON, so the voice setting was not saved. Fix or remove that file first.'); }
  for (const [name, value] of Object.entries(changes)) {
    if (name === 'spokenReplies') { if (typeof value !== 'boolean') throw new Error('spokenReplies takes true or false.'); if (value) delete profile.spokenReplies; else profile.spokenReplies = false; }
    else if (name === 'voice') { if (value === null || value === '') delete profile.voice; else if (typeof value === 'string' && VOICE_ID.test(value)) profile.voice = value; else throw new Error('That is not a voice name.'); }
    else if (name === 'rate') { if (typeof value !== 'number' || !Number.isFinite(value) || value < VOICE_RATE.min || value > VOICE_RATE.max) throw new Error(`Speed must be between ${VOICE_RATE.min} and ${VOICE_RATE.max}.`); const rounded = Math.round(value * 100) / 100; if (rounded === 1) delete profile.voiceRate; else profile.voiceRate = rounded; }
    else throw new Error(`Unknown voice setting: ${String(name).slice(0, 40)}`);
  }
  const file = profileFile(root), temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(temporary, JSON.stringify(profile, null, 1));
  try { fs.renameSync(temporary, file); } catch (error) { try { fs.unlinkSync(temporary); } catch { /* nothing to remove */ } throw error; }
  return voicePrefsFrom(profile);
}

// What the bridge adds to a request to the voice service. An older or borrowed service ignores what it does not know.
export function speakPrefsQuery(prefs) {
  return `${prefs.voice ? `&voice=${encodeURIComponent(prefs.voice)}` : ''}${prefs.rate !== 1 ? `&speed=${prefs.rate}` : ''}`;
}

// "bm_george" -> "George · British, male". The first letter is the accent or language, the second the gender.
const ACCENTS = {a: 'American', b: 'British', e: 'Spanish', f: 'French', h: 'Hindi', i: 'Italian', j: 'Japanese', p: 'Portuguese', z: 'Chinese'};
export function voiceLabel(id) {
  if (typeof id !== 'string' || !VOICE_ID.test(id)) return String(id);
  const name = id.slice(3);
  return `${name[0].toUpperCase()}${name.slice(1)} · ${ACCENTS[id[0]] || 'Other'}, ${id[1] === 'f' ? 'female' : id[1] === 'm' ? 'male' : 'voice'}`;
}
// What both screens show in their voice list, from what the voice service says it can speak. `group` and
// `name` are the same label in two short parts ("British" / "George (male)"), for a list grouped by accent:
// the menus are narrow, and a full label would be cut off.
export function voiceChoices(service) {
  const ids = Array.isArray(service?.voices) ? service.voices.filter(id => typeof id === 'string' && VOICE_ID.test(id)).slice(0, 80) : [];
  const name = id => `${id[3].toUpperCase()}${id.slice(4)} (${id[1] === 'f' ? 'female' : id[1] === 'm' ? 'male' : 'voice'})`;
  return {language: typeof service?.language === 'string' ? service.language : 'en', fallback: typeof service?.default === 'string' && VOICE_ID.test(service.default) ? service.default : null,
    voices: ids.map(id => ({id, label: voiceLabel(id), group: ACCENTS[id[0]] || 'Other', name: name(id)}))};
}
