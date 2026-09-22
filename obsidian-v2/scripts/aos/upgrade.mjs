// Upgrade starts with an inventory. Applying a member's chosen changes belongs
// to the reviewed procedure in setup/UPGRADE.md, never to this command.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {projectRoot} from '../../runner/runtime.mjs';
import {discoverInstallations} from './upgrade-discovery.mjs';
import {assessCheckout} from './upgrade-checkout.mjs';

export const UPGRADE_FEATURES = Object.freeze([
  {id: 'cockpit', name: 'Obsidian cockpit', description: 'Planning, conversations and workflows inside your vault.', dependencies: ['Compatible local bridge and plugin; Terminal plugin for interactive conversations.']},
  {id: 'hud', name: 'Jarvis HUD', description: 'A browser dashboard for conversations, workflows and voice.', dependencies: ['Matching bridge and HUD versions; shared dashboard data.']},
  {id: 'voice', name: 'Local voice', description: 'Speak requests and hear replies on your computer.', dependencies: ['Compatible bridge and speech service; microphone permission; Python for an owned speech service.']},
  {id: 'jev', name: 'Optional Jev router', description: 'Route voice requests using an optional OpenRouter model.', dependencies: ['Working voice and compatible bridge; the member enters their own OpenRouter key locally.']},
  {id: 'dashboard', name: 'Your own skill buttons', description: 'Choose and order up to ten buttons shared by both dashboards.', dependencies: ['Compatible bridge and dashboard interfaces; each personal skill needs its own tools and accounts.']},
  {id: 'workflows', name: 'Bundled workflows', description: 'Planning, research and writing workflows that save reports in your vault.', dependencies: ['Compatible bridge and vault conventions; a signed-in coding tool; accounts required by the chosen workflow.']},
]);

export const UPGRADE_HELP = `Inspect an existing Agentic OS before upgrading it:

  node aos.mjs upgrade
  node aos.mjs upgrade --install "<absolute installation folder>"
  node aos.mjs upgrade --vault "<absolute vault folder>" [--json]

Finds likely installations, checks local checkout metadata, and lists available
features. It does not install, fetch updates, copy files, stop services or apply
changes. Follow setup/UPGRADE.md to choose changes and preserve customizations.
`;

// Only a fixed loopback status endpoint is read. Bound both time and body size;
// redirects, arbitrary URLs and authorization material are never followed.
export function readUpgradeMonitor() {
  return new Promise(resolve => {
    let done = false, request, timer;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); request?.destroy(); resolve(value); };
    timer = setTimeout(() => finish(null), 1500);
    try {
      request = http.get('http://127.0.0.1:3221/status', {agent: false}, response => {
        if (response.statusCode !== 200) { response.resume(); finish(null); return; }
        const chunks = []; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > 128 * 1024) finish(null); else chunks.push(chunk); });
        response.on('error', () => finish(null));
        response.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(value?.kind === 'agentic-os-service-supervisor' && typeof value.runtimeDir === 'string'
              ? {kind: value.kind, runtimeDir: value.runtimeDir} : null);
          } catch { finish(null); }
        });
      });
      request.on('error', () => finish(null));
    } catch { finish(null); }
  });
}

const line = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1800);

export async function inspectUpgrade(options = {}) {
  const {platform = process.platform, install, vault,
    discover = discoverInstallations, assess = assessCheckout} = options;
  const root = Object.hasOwn(options, 'root') ? options.root : options.home === undefined ? projectRoot : undefined;
  const getMonitor = Object.hasOwn(options, 'getMonitor') ? options.getMonitor : options.home === undefined ? readUpgradeMonitor : undefined;
  const home = options.home ?? os.homedir(), env = options.env ?? (options.home === undefined ? process.env : {});
  const inventory = await discover({root, home, platform, env, install, vault, getMonitor});
  const checkouts = new Map();
  const candidates = inventory.candidates.map(candidate => {
    if (candidate.installPath && !checkouts.has(candidate.installPath)) checkouts.set(candidate.installPath, assess(candidate.installPath));
    const checkout = candidate.installPath ? checkouts.get(candidate.installPath) : null;
    const route = checkout?.updateAllowed && candidate.kind === 'starter-v2' && candidate.vaultPath && !candidate.warnings?.length ? 'review-stock-update'
      : candidate.kind === 'v1' ? 'review-v1-upgrade' : 'review-custom-integration';
    return {...candidate, checkout, route};
  });
  return {
    schemaVersion: 1, readOnly: true, changesApplied: false,
    selectionRequired: candidates.length > 1,
    candidates, warnings: inventory.warnings, searched: inventory.searched,
    availableFeatures: UPGRADE_FEATURES,
    nextStep: candidates.length === 0
      ? 'Ask which Obsidian vault the member uses, or help them reveal its folder in Obsidian. No installation was selected.'
      : candidates.length > 1
        ? 'Show the vault names and installation folders, then ask which system the member wants to upgrade. Do not choose one automatically.'
        : 'Confirm the detected system with the member, compare its non-secret customizations, then follow setup/UPGRADE.md before making changes.',
    limitation: 'An inventory is not a compatibility test. A clean checkout does not prove that installed plugin files, vault content or external integrations are unchanged. Review the selected system before recommending an update.',
  };
}

export function printUpgradeReport(report, log = console.log) {
  log('Upgrade assessment — read only. Nothing has been changed.');
  if (!report.candidates.length) log('No confirmed installation found in the checked locations.');
  report.candidates.forEach((candidate, index) => {
    log(`\n${index + 1}. ${line(candidate.label || candidate.kind)}`);
    if (candidate.vaultPath) log(`   Vault: ${line(candidate.vaultPath)}`);
    if (candidate.installPath) log(`   Installation: ${line(candidate.installPath)}`);
    log(`   Route: ${candidate.route === 'review-stock-update' ? 'Review a standard V2 update' : candidate.route === 'review-v1-upgrade' ? 'Review an upgrade from the original starter' : 'Review and preserve this customized or unrecognized system'}`);
    for (const issue of [...(candidate.warnings || []), ...(candidate.checkout?.issues || [])]) log(`   Review: ${line(issue)}`);
    for (const changed of (candidate.checkout?.changes || [])) log(`   Changed file: ${line(changed)}`);
  });
  for (const warning of report.warnings || []) log(`\nDiscovery note: ${line(warning)}`);
  log('\nFeatures available in this starter (compatibility must be checked):');
  for (const feature of report.availableFeatures) log(`- ${feature.name}: ${feature.description}`);
  log(`\n${report.nextStep}`);
  log(report.limitation);
  log('Guide: setup/UPGRADE.md');
}

export async function upgradeCommand({flags = {}, words = [], log = console.log, ...options} = {}) {
  const allowed = new Set(['help', 'install', 'vault', 'json']);
  if (words.length || Object.keys(flags).some(key => !allowed.has(key))) throw new Error('Use node aos.mjs upgrade [--install "<folder>"] [--vault "<folder>"] [--json]. Upgrade inspection has no apply option.');
  for (const name of ['help', 'json']) if (flags[name] !== undefined && flags[name] !== true) throw new Error(`--${name} takes no value.`);
  if (flags.help) { log(UPGRADE_HELP); return 0; }
  for (const name of ['install', 'vault']) if (flags[name] !== undefined && (typeof flags[name] !== 'string' || !path.isAbsolute(flags[name]) || /[\x00-\x1f\x7f]/.test(flags[name]))) throw new Error(`--${name} needs an absolute folder path. Run node aos.mjs upgrade without a path to discover installations first.`);
  const report = await inspectUpgrade({...options, install: flags.install, vault: flags.vault});
  if (flags.json) log(JSON.stringify(report, null, 2)); else printUpgradeReport(report, log);
  return 0;
}
