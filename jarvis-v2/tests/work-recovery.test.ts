import test from 'node:test';
import assert from 'node:assert/strict';
import { draftKey, readDraft, type DraftStorage } from '../../obsidian-v2/shared/drafts';
import { stageRecoveredDraft, readRecoveredDraft, clearRecoveredDraft, updateRecoveryText } from '../lib/work-recovery';

function memory(): DraftStorage {
  const data = new Map<string, string>();
  return { getItem: key => data.get(key) || null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
}
const request = { prompt: 'Compare the two drafts', title: 'Compare drafts', selection: { provider: 'claude' as const, model: 'sonnet' } };

test('recovering an unsaved conversation stages its original prompt and provider without dispatching work', () => {
  const storage = memory(), key = draftKey('jarvis', 'C:/Test Vault', null);
  stageRecoveredDraft(storage, key, request);
  assert.equal(readDraft(storage, key), request.prompt);
  assert.deepEqual(readRecoveredDraft(storage, key), { selection: request.selection, title: request.title, prompt: request.prompt });
  // Reload and provider swaps read the draft's captured selection, not a new global provider.
  assert.equal(readRecoveredDraft(storage, key)?.selection.provider, 'claude');
  assert.equal(readRecoveredDraft(storage, draftKey('jarvis', 'C:/Other Vault', null)), null);
  assert.equal(clearRecoveredDraft(storage, key), true);
  assert.equal(readRecoveredDraft(storage, key), null);
  assert.equal(readDraft(storage, key), request.prompt, 'clearing recovery metadata does not discard typed text');
});

test('workflow recovery stages exact arguments for review and does not launch a task', () => {
  const storage = memory(), key = 'new';
  stageRecoveredDraft(storage, key, { ...request, skill: 'yt-search', args: { topic: 'agents' } });
  const recovery = readRecoveredDraft(storage, key)!;
  assert.equal(recovery.skill, 'yt-search');
  assert.deepEqual(recovery.args, { topic: 'agents' });
  assert.match(readDraft(storage, key), /Workflow: yt-search/);
  assert.match(readDraft(storage, key), /agents/);
});

test('recovery context follows composer edits but cannot survive an unrelated replacement or deleted draft', () => {
  const storage = memory(), key = 'new';
  const staged = stageRecoveredDraft(storage, key, request);
  updateRecoveryText(storage, key, staged, 'Compare three drafts');
  assert.equal(readRecoveredDraft(storage, key)?.selection.provider, 'claude');
  assert.equal(readRecoveredDraft(storage, key)?.prompt, 'Compare three drafts');
  storage.setItem(key, 'An unrelated request');
  assert.equal(readRecoveredDraft(storage, key), null);
  storage.removeItem(key);
  assert.equal(readRecoveredDraft(storage, key), null);
  assert.equal(updateRecoveryText(storage, key, staged, ''), null);
  assert.equal(readRecoveredDraft(storage, key), null);
});

test('recovering a request cannot overwrite an existing new-task draft', () => {
  const storage = memory(), key = 'new';
  storage.setItem(key, 'My unsent work');
  assert.throws(() => stageRecoveredDraft(storage, key, request), /draft is already saved/);
  assert.equal(readDraft(storage, key), 'My unsent work');
  assert.equal(readRecoveredDraft(storage, key), null);
});

test('unavailable browser storage does not pretend recovery was saved', () => {
  const storage: DraftStorage = { getItem: () => null, setItem: () => { throw new Error('Quota exceeded'); }, removeItem: () => { throw new Error('Unavailable'); } };
  assert.throws(() => stageRecoveredDraft(storage, 'new', request), /original request is still saved/);
  assert.equal(clearRecoveredDraft(storage, 'new'), false);
});
