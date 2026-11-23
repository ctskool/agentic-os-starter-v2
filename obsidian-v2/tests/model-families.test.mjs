// Jarvis stores model families, never pinned releases, so a new model release needs no Jarvis update.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MODELS,VOICE_MODELS,DEFAULT_SELECTION,validateSelection,modelFamily} from '../shared/contract.mjs';
import {newestCodexModel,resolveCodexModel,CODEX_FALLBACK} from '../runner/codex-models.mjs';

const codexHome = models => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-codex-home-'));
 if (models) fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify({models}));
 return {CODEX_HOME: dir};
};

test('the contract lists families only', () => {
 assert.deepEqual(MODELS, {codex: ['astra', 'luna'], claude: ['opus', 'sonnet', 'haiku', 'fable']});
 assert.deepEqual({...VOICE_MODELS}, {codex: 'luna', claude: 'haiku'});
 assert.deepEqual(DEFAULT_SELECTION, {provider: 'codex', model: 'astra'});
});

test('older pinned selections are read as their family', () => {
 assert.deepEqual(validateSelection({provider: 'codex', model: 'gpt-6-astra'}), {provider: 'codex', model: 'astra'});
 assert.deepEqual(validateSelection({provider: 'codex', model: 'gpt-5.6-luna'}), {provider: 'codex', model: 'luna'});
 assert.deepEqual(validateSelection({provider: 'claude', model: 'claude-fable-5-1'}), {provider: 'claude', model: 'fable'});
 assert.equal(modelFamily('codex', 'gpt-6.2-sol'), 'gpt-6.2-sol');
 assert.throws(() => validateSelection({provider: 'codex', model: 'opus'}), /Unsupported/);
 assert.throws(() => validateSelection({provider: 'claude', model: 'astra'}), /Unsupported/);
});

test('a Codex family resolves to the newest listed model of that family', () => {
 const env = codexHome([
  {slug: 'gpt-6.2-sol', visibility: 'list'}, {slug: 'gpt-6.2-astra', visibility: 'list'}, {slug: 'gpt-6-astra', visibility: 'list'},
  {slug: 'gpt-6-luna', visibility: 'list'}, {slug: 'gpt-5.6-luna', visibility: 'list'}, {slug: 'gpt-7-luna', visibility: 'hide'},
  {slug: 'gpt-6.10-astra', visibility: 'list', supported_in_api: false}
 ]);
 assert.equal(newestCodexModel('astra', {env}), 'gpt-6.2-astra');
 assert.equal(newestCodexModel('luna', {env}), 'gpt-6-luna', 'hidden models are skipped');
 assert.equal(resolveCodexModel('astra', {env}), 'gpt-6.2-astra');
 assert.equal(resolveCodexModel('gpt-6-astra', {env}), 'gpt-6.2-astra', 'an old pinned ID upgrades too');
 assert.equal(resolveCodexModel('gpt-6.2-sol', {env}), 'gpt-6.2-sol', 'other models pass through');
});

test('a newer release in the list is picked up without any Jarvis change', () => {
 const env = codexHome([{slug: 'gpt-6.2-astra', visibility: 'list'}]);
 assert.equal(newestCodexModel('astra', {env}), 'gpt-6.2-astra');
 const file = path.join(env.CODEX_HOME, 'models_cache.json');
 fs.writeFileSync(file, JSON.stringify({models: [{slug: 'gpt-6.2-astra', visibility: 'list'}, {slug: 'gpt-6.10-astra', visibility: 'list'}]}));
 const later = new Date(Date.now() + 5000);fs.utimesSync(file, later, later);
 assert.equal(newestCodexModel('astra', {env}), 'gpt-6.10-astra', 'versions compare numerically, not as text');
});

test('a missing or broken model list falls back to the newest known model', () => {
 assert.equal(newestCodexModel('astra', {env: codexHome(null)}), CODEX_FALLBACK.astra);
 const broken = codexHome(null);fs.writeFileSync(path.join(broken.CODEX_HOME, 'models_cache.json'), '{not json');
 assert.equal(newestCodexModel('luna', {env: broken}), CODEX_FALLBACK.luna);
});
