// The one place that says which language voice hears and speaks. Chosen per vault in
// system/v2/profile.json ("speechLanguage": "pt"); anything else, or nothing, means English, so an
// installation without the setting behaves exactly as before.
//
// Why a setting and not auto-detection: the English-only speech model does not refuse other languages.
// It writes down English-looking words, which were then answered as if they had been said.
//
// Only hearing and speaking change. The instant spoken commands (open, stop, show ...) are written for
// English; in another language a request goes to the model, which is slower but understands it.
//
//   whisper - the faster-whisper model: English keeps the English-only one the installer always fetches
//   voice / kokoro - a Kokoro voice from the voice file that already ships, and its language code
//   phrase / heard - what the doctor says and the words it must hear back. The new languages leave
//                    numerals out of "heard": speech-to-text writes spoken numbers as digits. English
//                    keeps exactly the words the check accepted before this file existed.
import fs from 'node:fs';
import path from 'node:path';

export const SPEECH_LANGUAGES = Object.freeze({
  en: Object.freeze({name: 'English', whisper: 'small.en', voice: 'bm_george', kokoro: 'en-gb', phrase: 'Voice check, one two three.', heard: ['voice', 'check', 'one', 'two', 'three']}),
  es: Object.freeze({name: 'Spanish', whisper: 'small', voice: 'ef_dora', kokoro: 'es', phrase: 'Prueba de voz, uno dos tres.', heard: ['prueba', 'voz']}),
  fr: Object.freeze({name: 'French', whisper: 'small', voice: 'ff_siwis', kokoro: 'fr-fr', phrase: 'Bonjour, ceci est un test, un deux trois.', heard: ['bonjour', 'test']}),
  it: Object.freeze({name: 'Italian', whisper: 'small', voice: 'if_sara', kokoro: 'it', phrase: 'Prova della voce, uno due tre.', heard: ['prova', 'voce']}),
  pt: Object.freeze({name: 'Portuguese (Brazil)', whisper: 'small', voice: 'pf_dora', kokoro: 'pt-br', phrase: 'Teste de voz, um dois três.', heard: ['teste', 'voz']}),
});
export const SPEECH_LANGUAGE_CODES = Object.freeze(Object.keys(SPEECH_LANGUAGES));

// {code, asked, known}: `asked` is what the profile says (null when it says nothing); `known` is false
// when that is not a language we support, in which case `code` is English and the doctor says so.
export function speechLanguage(vault, {read = fs.readFileSync} = {}) {
  let asked = null;
  if (vault) {
    try {
      const value = JSON.parse(String(read(path.join(vault, 'system', 'v2', 'profile.json'), 'utf8')).replace(/^\uFEFF/, '')).speechLanguage;
      if (typeof value === 'string' && value.trim()) asked = value.trim().toLowerCase().slice(0, 20);
    } catch { /* no profile, or not JSON: English */ }
  }
  const known = asked === null || Object.hasOwn(SPEECH_LANGUAGES, asked);
  return {code: asked !== null && known ? asked : 'en', asked, known};
}

// Extra arguments for runner/speech.py. English adds none, so existing installations keep the exact
// command they already run.
export function speechArguments(code) {
  const language = Object.hasOwn(SPEECH_LANGUAGES, code) ? SPEECH_LANGUAGES[code] : null;
  if (!language || code === 'en') return [];
  return ['--language', code, '--whisper-model', language.whisper, '--voice', language.voice, '--kokoro-lang', language.kokoro];
}

// What the doctor says and how it judges what came back, for the language the service reports.
export function speechCheck(code) {
  const language = SPEECH_LANGUAGES[Object.hasOwn(SPEECH_LANGUAGES, code) ? code : 'en'];
  const plain = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return {phrase: language.phrase, name: language.name, heard: text => language.heard.some(word => plain(text).includes(word))};
}
