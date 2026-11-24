// The skill pack: optional skills that ship with the starter and become the member's own.
//   node aos.mjs skills list [--provider claude|codex]
//   node aos.mjs skills install --skills "close-day,yt-search" | --all   --provider claude|codex
// Installing copies a skill's folder into the coding tool's own skills folder. From then on it is the member's:
// they can edit it, and a later install never overwrites a copy they changed. Nothing here runs a skill,
// starts or stops a service, or touches the vault. Putting one on the dashboard is `dashboard add`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {projectRoot} from '../../runner/runtime.mjs';
import {layout} from './services.mjs';

export const SKILLS_HELP = `Usage: node aos.mjs skills <action>

  list [--provider claude|codex]                       what the pack holds, and what is already installed
  install --skills "<id>,<id>" --provider claude|codex  copy the chosen skills into that tool's skills folder
  install --all --provider claude|codex                 copy every skill that works with that tool
  offered --skills "<id>,<id>"                         remember that these were shown to the member (yes or no)

Installed skills are yours to edit. A copy you changed is never overwritten.`;

const PROVIDERS = ['claude', 'codex'];
// Where each tool reads its own skills (the first folder dashboard discovery looks in).
export const skillsFolder = (provider, home = os.homedir()) => provider === 'claude' ? path.join(home, '.claude', 'skills') : path.join(home, '.agents', 'skills');
const safeRelative = file => typeof file === 'string' && file && !path.isAbsolute(file) && !file.split(/[\\/]/).some(part => part === '..' || part === '' || part.startsWith('.git'));

export function readSkillPack(packDir = path.join(projectRoot, 'skill-pack')) {
  let catalog;
  try { catalog = JSON.parse(fs.readFileSync(path.join(packDir, 'catalog.json'), 'utf8')); } catch { throw new Error('This starter has no skill pack (skill-pack/catalog.json is missing or unreadable).'); }
  if (catalog?.version !== 1 || !Array.isArray(catalog.skills)) throw new Error('The skill pack catalog has an unsupported format.');
  for (const skill of catalog.skills) {
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(skill.id || '') || !Array.isArray(skill.files) || !skill.files.includes('SKILL.md') || !skill.files.every(safeRelative)) throw new Error(`The skill pack entry "${skill.id}" is malformed.`);
    if (!Array.isArray(skill.providers) || !skill.providers.every(name => PROVIDERS.includes(name))) throw new Error(`The skill pack entry "${skill.id}" names an unknown coding tool.`);
    for (const file of skill.files) if (!fs.existsSync(path.join(packDir, skill.id, file))) throw new Error(`The skill pack is incomplete: ${skill.id}/${file} is missing.`);
  }
  return {packDir, skills: catalog.skills};
}
// One fingerprint for a skill's shipped files as they are on disk in a folder. Line endings do not count.
function fingerprint(folder, files) {
  const hash = crypto.createHash('sha256');
  for (const file of [...files].sort()) {
    const full = path.join(folder, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    hash.update(file + '\0').update(fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n')).update('\0');
  }
  return hash.digest('hex');
}
const recordFile = runtimeDir => path.join(runtimeDir, 'skill-pack-installed.json');
// Which pack skills the member has been shown, whatever they answered. "What's new after an update"
// offers a skill once: comparing versions missed members whose earlier update nobody walked through.
const offeredFile = runtimeDir => path.join(runtimeDir, 'skill-pack-offered.json');
function readOffered(runtimeDir) { try { const ids = JSON.parse(fs.readFileSync(offeredFile(runtimeDir), 'utf8')).offered; return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []; } catch { return []; } }
export function recordOffered({ids, packDir, runtimeDir} = {}) {
  const known = new Set(readSkillPack(packDir).skills.map(skill => skill.id));
  if (!ids?.length) throw new Error('Name the skills that were shown: skills offered --skills "<id>,<id>"');
  const unknown = ids.filter(id => !known.has(id));
  if (unknown.length) throw new Error(`Not in the skill pack: ${unknown.join(', ')}`);
  const offered = [...new Set([...readOffered(runtimeDir), ...ids])];
  fs.mkdirSync(runtimeDir, {recursive: true}); fs.writeFileSync(offeredFile(runtimeDir), JSON.stringify({offered}, null, 1));
  return {offered};
}
function readRecord(runtimeDir) { try { const value = JSON.parse(fs.readFileSync(recordFile(runtimeDir), 'utf8')); return value && typeof value === 'object' ? value : {}; } catch { return {}; } }
function writeRecord(runtimeDir, record) { fs.mkdirSync(runtimeDir, {recursive: true}); fs.writeFileSync(recordFile(runtimeDir), JSON.stringify(record, null, 1)); }

// missing | installed (same as the pack) | update (an older copy we installed, untouched) | edited (theirs now)
function stateOf(skill, provider, {packDir, home, record}) {
  const folder = path.join(skillsFolder(provider, home), skill.id);
  if (!fs.existsSync(folder)) return {state: 'missing', folder};
  const now = fingerprint(folder, skill.files), pack = fingerprint(path.join(packDir, skill.id), skill.files);
  if (now && now === pack) return {state: 'installed', folder};
  if (now && record?.[provider]?.[skill.id] === now) return {state: 'update', folder};
  return {state: 'edited', folder};
}

export function listSkillPack({provider, packDir, home = os.homedir(), runtimeDir} = {}) {
  const pack = readSkillPack(packDir), record = readRecord(runtimeDir), offered = new Set(readOffered(runtimeDir));
  const tools = provider ? [provider] : PROVIDERS;
  return {
    skills: pack.skills.filter(skill => !provider || skill.providers.includes(provider)).map(skill => ({
      id: skill.id, label: skill.label, description: skill.description, needs: skill.needs || [], providers: skill.providers, since: skill.since,
      ...(skill.with?.length ? {installsWith: skill.with} : {}),
      installed: Object.fromEntries(tools.filter(tool => skill.providers.includes(tool)).map(tool => [tool, stateOf(skill, tool, {packDir: pack.packDir, home, record}).state])),
      offered: offered.has(skill.id),
    })),
    folders: Object.fromEntries(tools.map(tool => [tool, skillsFolder(tool, home)])),
  };
}

export function installSkillPack({ids, all = false, provider, packDir, home = os.homedir(), runtimeDir} = {}) {
  if (!PROVIDERS.includes(provider)) throw new Error('--provider takes claude or codex: the coding tool that should get the skills.');
  const pack = readSkillPack(packDir), byId = new Map(pack.skills.map(skill => [skill.id, skill])), record = readRecord(runtimeDir);
  const wanted = all ? pack.skills.filter(skill => skill.providers.includes(provider)).map(skill => skill.id) : [...new Set(ids || [])];
  if (!wanted.length) throw new Error('Name the skills to install with --skills "<id>,<id>", or use --all.');
  for (const id of wanted) if (!byId.has(id)) throw new Error(`"${id}" is not in the skill pack. Run \`node aos.mjs skills list\` to see what is.`);
  // A skill that leans on another brings it along.
  const queue = [...wanted], order = [];
  while (queue.length) { const id = queue.shift(); if (order.includes(id)) continue; order.push(id); for (const more of byId.get(id).with || []) if (byId.has(more)) queue.push(more); }
  const root = skillsFolder(provider, home), results = [];
  for (const id of order) {
    const skill = byId.get(id);
    if (!skill.providers.includes(provider)) { results.push({id, status: 'not-for-this-tool', note: `${skill.label} works with ${skill.providers.join(' and ')}.`}); continue; }
    const {state, folder} = stateOf(skill, provider, {packDir: pack.packDir, home, record});
    const skillFile = path.join(folder, 'SKILL.md');
    if (state === 'installed') { results.push({id, status: 'already-installed', path: skillFile}); (record[provider] ||= {})[id] = fingerprint(folder, skill.files); continue; }
    if (state === 'edited') { results.push({id, status: 'kept-yours', path: skillFile, note: 'A different copy is already there, so it was left alone. Rename that folder first if you want the pack\'s version.'}); continue; }
    for (const part of [root, folder]) { try { if (fs.lstatSync(part).isSymbolicLink()) throw new Error(`${part} is a link; install into a real folder.`); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    for (const file of skill.files) {
      const to = path.join(folder, file);
      fs.mkdirSync(path.dirname(to), {recursive: true});
      fs.copyFileSync(path.join(pack.packDir, id, file), to);
    }
    (record[provider] ||= {})[id] = fingerprint(folder, skill.files);
    results.push({id, status: state === 'update' ? 'updated' : 'installed', path: skillFile, ...(wanted.includes(id) ? {} : {note: 'Installed because another chosen skill uses it.'})});
  }
  writeRecord(runtimeDir, record);
  return {provider, folder: root, results, next: 'To put one on the dashboard: node aos.mjs dashboard add --path "<path above>" --provider ' + provider + ' --revision "<revision from dashboard list>"'};
}

export function skillsCommand({words = [], flags = {}, log = console.log, at = layout(), options = {}} = {}) {
  const action = words[0] || 'list';
  if (flags.help || action === 'help') { log(SKILLS_HELP); return 0; }
  if (!['list', 'install', 'offered'].includes(action) || words.length > 1) throw new Error('Use: skills list, skills install  or  skills offered');
  const allowed = action === 'list' ? ['provider'] : action === 'offered' ? ['skills'] : ['provider', 'skills', 'all'];
  for (const name of Object.keys(flags)) if (!allowed.includes(name)) throw new Error('Unknown skills flag: --' + name);
  if (flags.provider !== undefined && !PROVIDERS.includes(flags.provider)) throw new Error('--provider takes claude or codex.');
  const shared = {runtimeDir: at.runtime, ...options, provider: flags.provider};
  const ids = typeof flags.skills === 'string' ? flags.skills.split(',').map(id => id.trim()).filter(Boolean) : [];
  const result = action === 'list' ? listSkillPack(shared)
    : action === 'offered' ? recordOffered({...shared, ids})
    : installSkillPack({...shared, all: flags.all === true, ids});
  log(JSON.stringify(result, null, 2));
  return 0;
}
