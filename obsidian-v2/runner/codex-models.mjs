import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {modelFamily} from '../shared/contract.mjs';

// Jarvis stores Codex models by family ("astra", "luna") so a new release is picked up without updating Jarvis.
// Codex has no family aliases, so each call takes the newest listed model of that family from Codex's own
// model list (models_cache.json, which Codex refreshes itself). A missing or unreadable list falls back to the
// newest model known when this was written. Claude needs none of this: Claude Code resolves opus, sonnet,
// haiku and fable to the newest release itself.
export const CODEX_FALLBACK = Object.freeze({astra: 'gpt-6.2-astra', luna: 'gpt-6-luna'});
let cached = null;

export function codexModelsCachePath(env = process.env) {
 return path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json');
}

const compare = (a, b) => {
 for (let index = 0; index < Math.max(a.length, b.length); index++) {const delta = (a[index] ?? 0) - (b[index] ?? 0);if (delta) return delta}
 return 0;
};

export function newestCodexModel(family, {env = process.env, read = fs.readFileSync, stat = fs.statSync} = {}) {
 if (!Object.hasOwn(CODEX_FALLBACK, family)) throw new Error('Unknown Codex model family.');
 const file = codexModelsCachePath(env);
 let models = [];
 try {
  const mtime = stat(file).mtimeMs;
  if (cached?.file !== file || cached.mtime !== mtime) {const list = JSON.parse(read(file, 'utf8'))?.models;cached = {file, mtime, models: Array.isArray(list) ? list : []}}
  models = cached.models;
 } catch {}
 const pattern = new RegExp(`^gpt-(\\d+(?:\\.\\d+)*)-${family}$`);
 let best = null;
 for (const model of models) {
  if (model?.visibility === 'hide' || model?.supported_in_api === false) continue;
  const hit = pattern.exec(typeof model?.slug === 'string' ? model.slug : '');
  if (!hit) continue;
  const version = hit[1].split('.').map(Number);
  if (!best || compare(version, best.version) > 0) best = {slug: model.slug, version};
 }
 return best?.slug ?? CODEX_FALLBACK[family];
}

// A family name, or an older pinned ID of a family (gpt-6-astra), becomes the newest model of that family.
// Anything else (an explicit model a user typed elsewhere) passes through unchanged.
export function resolveCodexModel(model, options) {
 const family = modelFamily('codex', model);
 return Object.hasOwn(CODEX_FALLBACK, family) ? newestCodexModel(family, options) : model;
}
