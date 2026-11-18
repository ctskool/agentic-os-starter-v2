// Scheduled workflows as the HUD shows them: one read-only line under the dashboard buttons.
import {browserVoiceTransport} from '../../obsidian-v2/shared/voice-session';
import {createScheduleNoteStore} from '../../obsidian-v2/shared/schedule-note';
import {authorizeBridge} from './bridge-auth';

export const scheduleNote = createScheduleNoteStore(browserVoiceTransport(undefined, authorizeBridge));
