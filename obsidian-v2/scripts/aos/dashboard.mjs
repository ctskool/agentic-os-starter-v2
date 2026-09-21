import path from 'node:path';
import {assertVault} from '../../runner/core.mjs';
import {readDashboard, saveDashboard, registerDashboardSkill, discoverDashboardSkills} from '../../runner/dashboard.mjs';
import {layout, configuredVaultPath} from './services.mjs';

const actions = new Set(['list', 'discover', 'select', 'add', 'reset']);
const allowedFlags = {
  list: ['vault'],
  discover: ['vault', 'provider'],
  select: ['vault', 'revision', 'skills'],
  add: ['vault', 'revision', 'path', 'provider', 'label'],
  reset: ['vault', 'revision'],
};
function required(flags, name) {
  if (typeof flags[name] !== 'string' || !flags[name].trim()) throw new Error('dashboard requires --' + name);
  return flags[name];
}

// Operates on this installation's vault configuration, never on a running
// bridge selected by a fixed port. The agent can personalize during setup
// without starting another install or exposing any bridge credentials.
export function dashboardCommand({words = [], flags = {}, log = console.log, at = layout(), options = {}} = {}) {
  const action = words[0] || 'list';
  if (!actions.has(action) || words.length > 1) throw new Error('Use: dashboard list|discover|select|add|reset');
  for (const name of Object.keys(flags)) {
    if (!allowedFlags[action].includes(name)) throw new Error('Unknown dashboard flag: --' + name);
  }
  if (flags.vault !== undefined && (typeof flags.vault !== 'string' || !path.isAbsolute(flags.vault))) {
    throw new Error('--vault must be an absolute path to an installed Agentic OS vault.');
  }
  const vault = flags.vault || configuredVaultPath(at);
  if (!vault) throw new Error('Set up a vault first, or pass --vault with its absolute path.');
  const root = assertVault(vault);
  let result;
  if (action === 'list') result = readDashboard(root, options);
  if (action === 'discover') {
    const provider = required(flags, 'provider');
    if (!['claude', 'codex'].includes(provider)) throw new Error('--provider takes claude or codex for discovery.');
    result = discoverDashboardSkills(root, {...options, provider});
  }
  if (action === 'select') {
    const value = required(flags, 'skills');
    const selected = value === 'none' ? [] : value.split(',').map(id => id.trim());
    result = saveDashboard(root, {revision: required(flags, 'revision'), selected}, options);
  }
  if (action === 'reset') result = saveDashboard(root, {revision: required(flags, 'revision'), selected: null}, options);
  if (action === 'add') {
    const provider = required(flags, 'provider');
    if (!['claude', 'codex', 'both'].includes(provider)) throw new Error('--provider takes claude, codex or both.');
    if (flags.label !== undefined && typeof flags.label !== 'string') throw new Error('--label requires a name.');
    result = registerDashboardSkill(root, {
      revision: required(flags, 'revision'), path: required(flags, 'path'),
      providers: provider === 'both' ? ['claude', 'codex'] : [provider],
      ...(flags.label !== undefined ? {label: flags.label} : {}),
    }, options);
  }
  log(JSON.stringify(result, null, 2));
  if (result?.error) throw new Error(result.error);
  return 0;
}
