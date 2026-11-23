// The three things that make a spoken request answer sooner, each with its own off switch.
//
//   earlyAnswer  - take the small model's answer the moment it appears in its output, instead of
//                  waiting for its program to finish closing (which can take seconds on a busy machine)
//   streamSpeech - start speaking after the first sentence, instead of after the whole reply is built
//   prestart     - OFF unless switched on. Start the small model's program the moment a spoken request
//                  arrives, so that it is already running by the time the words have been turned into
//                  text (Claude only; it is stopped again, unused, when the request turns out not to need
//                  it). Measured on a fast desktop it saves a quarter of a second, and only when the words
//                  are ready within about two seconds; it costs one extra program start on every spoken
//                  request. It may help more where programs start slowly, which is why it exists.
//
// The first two are on, the third off, unless .runtime/voice-speed.json says otherwise:
//   {"earlyAnswer": false, "streamSpeech": false, "prestart": true}
// `node aos.mjs voice-speed` shows and changes them. A missing or unreadable file means the defaults,
// and each piece falls back to the old behaviour by itself when it cannot do its job.
import fs from 'node:fs';
import path from 'node:path';
import {projectRoot} from './runtime.mjs';

export const VOICE_SPEED_DEFAULTS = Object.freeze({earlyAnswer: true, streamSpeech: true, prestart: false});
export const voiceSpeedFile = (root = projectRoot) => path.join(root, '.runtime', 'voice-speed.json');

let cached = null;
// Read at most once a second: this is asked on every spoken request.
export function voiceSpeed({file = voiceSpeedFile(), read = target => JSON.parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '')), now = Date.now, fresh = false} = {}) {
  if (!fresh && cached && cached.file === file && now() - cached.at < 1000) return cached.value;
  let saved = {};
  try { const value = read(file); if (value && typeof value === 'object' && !Array.isArray(value)) saved = value; } catch { /* no file, or not JSON: the defaults */ }
  const value = Object.freeze(Object.fromEntries(Object.entries(VOICE_SPEED_DEFAULTS).map(([name, fallback]) => [name, typeof saved[name] === 'boolean' ? saved[name] : fallback])));
  cached = {file, at: now(), value};
  return value;
}

// What the bridge adds to its request to the voice service. A GET comes from the player that plays audio
// as it arrives, so it may be sent sentence by sentence; a POST is the buffered fallback, which decodes one
// complete file and keeps getting exactly that.
export const speakStreamQuery = (method, speed = voiceSpeed()) => method === 'GET' && speed.streamSpeech ? '&stream=1' : '';

// Changes only the named switches and keeps anything else already in the file.
export function saveVoiceSpeed(changes, {file = voiceSpeedFile()} = {}) {
  let saved = {};
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); if (value && typeof value === 'object' && !Array.isArray(value)) saved = value; } catch { /* start from nothing */ }
  for (const [name, value] of Object.entries(changes)) {
    if (!Object.hasOwn(VOICE_SPEED_DEFAULTS, name) || typeof value !== 'boolean') throw new Error(`Unknown voice speed setting: ${name}`);
    saved[name] = value;
  }
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(saved, null, 1));
  fs.renameSync(temporary, file);
  cached = null;
  return voiceSpeed({file});
}
