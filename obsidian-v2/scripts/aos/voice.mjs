// `node aos.mjs voice ...`: how voice sounds, how fast it answers, and which words it listens for.
// Everything here is also in the voice menu on both screens; the command exists for the setup agent and
// for members who prefer a terminal. It only edits small settings files, so no service has to be running.
import path from 'node:path';
import {layout, configuredVaultPath} from './services.mjs';
import {readVoicePrefs, saveVoicePrefs, voiceLabel, VOICE_RATE} from '../../runner/voice-prefs.mjs';
import {voiceSpeed, saveVoiceSpeed, voiceSpeedFile} from '../../runner/voice-speed.mjs';
import {voiceWordList, saveVoiceWords, writeVoiceWords, voiceWordsFile} from '../../runner/voice-words.mjs';
import {speechLanguage, SPEECH_LANGUAGES} from '../../shared/speech-language.mjs';

export const VOICE_HELP = `Voice settings

  voice                       show every setting below
  voice mute | unmute         spoken replies off or on (replies are still written; hearing you keeps working)
  voice use <name>            choose the voice, for example: voice use af_heart   (voice use default = the usual one)
  voice speed <0.8-1.4>       how fast it speaks (1 = normal)
  voice live-idle open|muted  whether the Live mic stays open in standby
  voice teach "<word>" ...    a name voice should listen for, in your spelling
  voice forget "<word>" ...   stop listening for a word (yours or a learned one)
  voice learn on | off        learn names from your notes' titles (on by default)
  voice fast on | off         the two speed-ups that are on by default: take the answer as it arrives,
                              speak after the first sentence (off also turns the third one off)
  voice fast --early on|off --stream on|off     each of those by itself
  voice fast --prestart on|off                  a third one to try, off by default: start the model's
                              program the moment a spoken request arrives (Claude only; saves about a
                              quarter of a second when your words are ready within two seconds)
`;

const onOff = (value, name) => { if (value === 'on') return true; if (value === 'off') return false; throw new Error(`${name} takes on or off.`); };

export async function voiceCommand({words = [], flags = {}, log = console.log, root, at = layout(root), vault = configuredVaultPath(at)} = {}) {
  if (!vault) throw new Error('Nothing is installed here yet. Run `node aos.mjs setup --vault "<path>"` first.');
  const speedFile = voiceSpeedFile(at.root), wordsFile = voiceWordsFile(at.root);
  const [action, ...rest] = words;
  const refreshWords = () => writeVoiceWords(vault, {file: wordsFile});
  switch (action) {
    case undefined: case 'show': case 'status': break;
    case 'mute': saveVoicePrefs(vault, {spokenReplies: false}); log('Spoken replies are off. Replies are still written, and voice still hears you.'); return 0;
    case 'unmute': saveVoicePrefs(vault, {spokenReplies: true}); log('Spoken replies are on.'); return 0;
    case 'use': {
      if (rest.length !== 1) throw new Error('Use: voice use <name>   (for example af_heart, or default)');
      saveVoicePrefs(vault, {voice: rest[0] === 'default' ? null : rest[0]});
      log(rest[0] === 'default' ? 'Voice is back to the usual one.' : `Voice is now ${voiceLabel(rest[0])}. If that voice is not available for your language, the usual one is used instead.`);
      return 0;
    }
    case 'speed': {
      const rate = Number(rest[0]);
      if (rest.length !== 1 || !Number.isFinite(rate)) throw new Error(`Use: voice speed <number between ${VOICE_RATE.min} and ${VOICE_RATE.max}>   (1 = normal)`);
      log(`Speaking speed is now ${saveVoicePrefs(vault, {rate}).rate}.`); return 0;
    }
    case 'live-idle':
      if(rest.length!==1||!['open','muted'].includes(rest[0]))throw new Error('Use: voice live-idle open|muted');
      saveVoicePrefs(vault,{liveIdleMic:rest[0]});log(`Live standby microphone will be ${rest[0]}.`);return 0;
    case 'teach': if (!rest.length) throw new Error('Use: voice teach "<word>" ...'); saveVoiceWords(vault, {add: rest}); refreshWords(); log(`Voice now listens for: ${rest.join(', ')}.`); return 0;
    case 'forget': if (!rest.length) throw new Error('Use: voice forget "<word>" ...'); saveVoiceWords(vault, {forget: rest}); refreshWords(); log(`Voice no longer listens for: ${rest.join(', ')}.`); return 0;
    case 'learn': saveVoiceWords(vault, {learn: onOff(rest[0], 'voice learn')}); refreshWords(); log(rest[0] === 'on' ? 'Voice learns names from your notes\' titles.' : 'Voice only listens for the words you teach it.'); return 0;
    case 'fast': {
      const changes = {};
      if (rest.length) { const value = onOff(rest[0], 'voice fast'); changes.earlyAnswer = value; changes.streamSpeech = value; if (!value) changes.prestart = false; }
      if (flags.prestart !== undefined) changes.prestart = onOff(flags.prestart, '--prestart');
      if (flags.early !== undefined) changes.earlyAnswer = onOff(flags.early, '--early');
      if (flags.stream !== undefined) changes.streamSpeech = onOff(flags.stream, '--stream');
      if (!Object.keys(changes).length) throw new Error('Use: voice fast on|off   or   voice fast --prestart on|off --early on|off --stream on|off');
      const now = saveVoiceSpeed(changes, {file: speedFile});
      log(`Start the model's program early: ${now.prestart ? 'on' : 'off'}. Take the answer as it arrives: ${now.earlyAnswer ? 'on' : 'off'}. Speak after the first sentence: ${now.streamSpeech ? 'on' : 'off'}. Applies to the next spoken request.`);
      return 0;
    }
    case 'help': log(VOICE_HELP); return 0;
    default: log(VOICE_HELP); return 1;
  }
  const prefs = readVoicePrefs(vault), speed = voiceSpeed({file: speedFile, fresh: true}), list = voiceWordList(vault), language = speechLanguage(vault);
  log(`Spoken replies:  ${prefs.spokenReplies ? 'on' : 'off (muted)'}`);
  log(`Voice:           ${prefs.voice ? voiceLabel(prefs.voice) : 'the usual one'}`);
  log(`Speaking speed:  ${prefs.rate === 1 ? 'normal' : prefs.rate}`);
  log(`Language:        ${SPEECH_LANGUAGES[language.code].name}${language.known ? '' : ` ("${language.asked}" is not supported)`}`);
  log(`Answers sooner:  start the model's program early ${speed.prestart ? 'on' : 'off'}, take the answer as it arrives ${speed.earlyAnswer ? 'on' : 'off'}, speak after the first sentence ${speed.streamSpeech ? 'on' : 'off'}`);
  log(`Listens for:     ${list.words.length} word(s)${list.learn ? '' : ' (learning from note titles is off)'}`);
  if (list.yours.length) log(`  yours:   ${list.yours.join(', ')}`);
  if (list.learned.length) log(`  learned: ${list.learned.join(', ')}`);
  if (list.ignored.length) log(`  forgotten: ${list.ignored.join(', ')}`);
  log('\n`node aos.mjs voice help` lists what you can change.');
  return 0;
}
