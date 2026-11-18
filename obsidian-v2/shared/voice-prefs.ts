// How voice sounds in this vault, as both screens see it: spoken replies on or off, which voice, how fast.
// The bridge keeps it in the vault (runner/voice-prefs.mjs); each screen polls it, so a change made on one
// shows on the other within a few seconds.
import {createPollStore} from './poll-store.mjs';
import type {VoiceTransport} from './voice-session';

export interface VoicePrefs {spokenReplies: boolean; voice: string | null; rate: number}
export interface VoiceChoice {id: string; label: string; group: string; name: string}
// The voices in the order they arrived, gathered under their accent ("British": George, Lewis ...).
export const voiceGroups = (voices: VoiceChoice[]) => [...new Set(voices.map(voice => voice.group))].map(group => ({group, voices: voices.filter(voice => voice.group === group)}));
export interface VoicePrefsSnapshot {prefs: VoicePrefs; voices: VoiceChoice[]; fallback: string | null; ready: boolean}

export const VOICE_RATES = [0.9, 1, 1.1, 1.2, 1.3];
export const rateLabel = (rate: number) => rate === 1 ? 'Normal' : rate < 1 ? `Slower (${rate}×)` : `Faster (${rate}×)`;
export const VOICE_SAMPLE = 'This is how I sound now.';

const prefsOf = (json: any): VoicePrefs | null => json && typeof json.spokenReplies === 'boolean'
  ? {spokenReplies: json.spokenReplies, voice: typeof json.voice === 'string' ? json.voice : null, rate: typeof json.rate === 'number' ? json.rate : 1}
  : null;

export function createVoicePrefsStore(transport: VoiceTransport, {intervalMs = 5000}: {intervalMs?: number} = {}) {
  // Not ready until the bridge has answered: an older bridge has no voice settings, and then none are shown.
  const initial: VoicePrefsSnapshot = {prefs: {spokenReplies: true, voice: null, rate: 1}, voices: [], fallback: null, ready: false};
  const store = createPollStore({initial, intervalMs, load: async (): Promise<VoicePrefsSnapshot> => {
    const current: VoicePrefsSnapshot = store.getSnapshot();
    try {
      const prefs = prefsOf((await transport('/voice/prefs')).json);
      if (!prefs) return current;
      let next: VoicePrefsSnapshot = {...current, prefs, ready: true};
      // The list of voices does not change while the voice service runs; ask until one is really on screen.
      // (Judged by what is shown, not by a flag: a poll whose result was discarded must not count as done.)
      if (!current.voices.length) {
        const answer = (await transport('/voice/voices')).json;
        if (Array.isArray(answer?.voices)) {
          next = {...next, voices: answer.voices.filter((voice: any) => typeof voice?.id === 'string' && typeof voice?.label === 'string').map((voice: any) => ({id: voice.id, label: voice.label, group: typeof voice.group === 'string' ? voice.group : 'Voices', name: typeof voice.name === 'string' ? voice.name : voice.label})), fallback: typeof answer.fallback === 'string' ? answer.fallback : null};
        }
      }
      const same = current.ready && current.voices === next.voices && current.fallback === next.fallback && current.prefs.spokenReplies === prefs.spokenReplies && current.prefs.voice === prefs.voice && current.prefs.rate === prefs.rate;
      return same ? current : next;
    } catch { return current; }
  }});
  return {
    getSnapshot: store.getSnapshot as () => VoicePrefsSnapshot,
    subscribe: store.subscribe as (listener: (snapshot: VoicePrefsSnapshot) => void) => () => void,
    refresh: store.refresh as () => Promise<VoicePrefsSnapshot>,
    // Saved by the bridge first; the screen only shows what was really saved.
    async save(changes: Partial<VoicePrefs>): Promise<VoicePrefs> {
      const answer = await transport('/voice/prefs', {method: 'POST', body: JSON.stringify(changes)});
      const prefs = answer.status === 200 ? prefsOf(answer.json) : null;
      if (!prefs) throw new Error(typeof answer.json?.error === 'string' ? answer.json.error : 'The voice setting could not be saved.');
      store.publish({...store.getSnapshot(), prefs, ready: true});
      return prefs;
    },
  };
}
