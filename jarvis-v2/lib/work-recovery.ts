import { readDraft, saveDraft, type DraftStorage } from '../../obsidian-v2/shared/drafts';

export type RecoverySelection = { provider: 'codex' | 'claude'; model: string };
export type SavedRequest = { prompt: string; title: string; selection: RecoverySelection; skill?: string; args?: Record<string, unknown> };
export type RecoveredDraft = { selection: RecoverySelection; title: string; prompt: string; skill?: string; args?: Record<string, unknown> };
const metadataKey = (key: string) => key + ':recovery';

export function readRecoveredDraft(storage: DraftStorage, key: string): RecoveredDraft | null {
  try {
    const value = JSON.parse(storage.getItem(metadataKey(key)) || 'null');
    return value && ['codex', 'claude'].includes(value.selection?.provider) && typeof value.selection?.model === 'string' && typeof value.title === 'string' && typeof value.prompt === 'string' && value.prompt.trim() && readDraft(storage,key) === value.prompt ? value : null;
  } catch { return null; }
}

export function clearRecoveredDraft(storage: DraftStorage, key: string): boolean {
  try { storage.removeItem(metadataKey(key)); return true; } catch { return false; }
}

export function stageRecoveredDraft(storage: DraftStorage, key: string, request: SavedRequest): RecoveredDraft {
  const prompt = request.skill ? `Workflow: ${request.skill}\n\nArguments:\n${JSON.stringify(request.args || {}, null, 2)}` : request.prompt;
  const existing = readDraft(storage, key);
  if (existing && existing !== prompt) throw new Error('A new-task draft is already saved. Open New terminal and save or clear that draft before recovering this request.');
  const metadata = { selection: request.selection, title: request.title, prompt, ...(request.skill ? {skill:request.skill,args:request.args||{}} : {}) };
  try {
    storage.setItem(metadataKey(key), JSON.stringify(metadata));
    if (!saveDraft(storage, key, prompt)) throw new Error('Could not save draft');
  } catch { throw new Error('The recovered request could not be saved on this device. The original request is still saved with its task.'); }
  return metadata;
}

// This is an explicit copy to a new composer, never a retry of expired work.
// Retain the old draft even if the new composer is occupied or storage fails.
export function stageExpiredTaskDraft(storage: DraftStorage, sourceKey: string, destinationKey: string, text: string, task: { title: string; provider: 'codex' | 'claude'; model: string }): RecoveredDraft {
  if (!text.trim()) throw new Error('There is no unsent draft to copy.');
  if (!saveDraft(storage, sourceKey, text)) throw new Error('Your draft could not be saved locally. Copy it before leaving this task.');
  if (readDraft(storage, destinationKey) || readRecoveredDraft(storage, destinationKey)) throw new Error('A new-task draft is already saved. Open New terminal and save or clear it before copying this draft.');
  return stageRecoveredDraft(storage, destinationKey, { prompt: text, title: `Draft from ${task.title}`, selection: { provider: task.provider, model: task.model } });
}

export function updateRecoveryText(storage: DraftStorage, key: string, metadata: RecoveredDraft | null, text: string): RecoveredDraft | null {
  if (!saveDraft(storage, key, text)) throw new Error('Draft could not be saved locally. Copy it before reloading.');
  if (!metadata || !text.trim()) {
    if (!clearRecoveredDraft(storage, key)) throw new Error('Draft recovery context could not be cleared.');
    return null;
  }
  const next = { ...metadata, prompt: text };
  try { storage.setItem(metadataKey(key), JSON.stringify(next)); }
  catch { throw new Error('The draft was saved but its original provider could not be saved. Recover the request again before submitting.'); }
  return next;
}
