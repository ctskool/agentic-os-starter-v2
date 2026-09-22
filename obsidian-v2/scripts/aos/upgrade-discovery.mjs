// Read-only discovery: fixed metadata locations, never notes, credentials or source contents.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_BYTES = 64 * 1024, MAX_PATHS = 32, MAX_READS = 256;
const V2 = 'agentic-os-v2', V1 = 'chase-command-center';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unique = values => [...new Set(values)];
const labels = {'starter-v2': 'Agentic OS V2 starter', v2: 'Agentic OS V2', v1: 'First Agentic OS starter', unknown: 'Unconfirmed installation'};

/** No network is performed unless getMonitor is supplied. Explicit home isolates default env paths. */
export async function discoverInstallations(options = {}) {
  const {home = os.homedir(), platform = process.platform, env = options.home === undefined ? process.env : {}, root, install, vault, getMonitor} = options;
  const explicitSelection = install !== undefined || vault !== undefined;
  const warnings = [], searched = [], candidates = [], installs = new Map(), vaults = new Map(), cache = new Map();
  const key = value => platform === 'win32' ? value.toLowerCase() : value;
  const warn = message => { if (!warnings.includes(message)) warnings.push(message); };
  let reads = 0;

  function absolute(value) {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || !path.isAbsolute(value)) return null;
    if (value.split(/[\\/]/).some(part => part === '..') || /^(?:\\\\|\/\/)/.test(value)) return null;
    if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':') || value.slice(3).split(/[\\/]/).some(part => /[. ]$/.test(part)))) return null;
    // macOS exposes these system-owned aliases; canonicalize only these known prefixes.
    if (process.platform === 'darwin') {
      for (const alias of ['/var', '/tmp']) {
        if ((value === alias || value.startsWith(alias + '/')) && fs.realpathSync(alias) === '/private' + alias) value = '/private' + value;
      }
    }
    return path.resolve(value);
  }

  function inspect(value, type) {
    const target = absolute(value);
    if (!target) return {error: 'invalid path'};
    const parsed = path.parse(target), pieces = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
    if (pieces.length > 128) return {error: 'path is too deep'};
    let current = parsed.root, stat;
    try {
      for (let index = 0; index < pieces.length; index++) {
        current = path.join(current, pieces[index]);
        stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) return {error: 'linked path'};
        if (index < pieces.length - 1 && !stat.isDirectory()) return {error: 'invalid parent folder'};
      }
      stat ||= fs.lstatSync(target);
      if (type === 'directory' && !stat.isDirectory()) return {error: 'not a folder'};
      if (type === 'file' && (!stat.isFile() || stat.nlink !== 1)) return {error: 'not an ordinary unlinked file'};
      return {path: target, stat};
    } catch (error) { return {error: error.code === 'ENOENT' ? 'missing' : 'unreadable'}; }
  }

  function metadata(file, label) {
    const id = key(file);
    if (cache.has(id)) return cache.get(id);
    if (reads >= MAX_READS) { warn('Metadata read limit reached; discovery is incomplete.'); return null; }
    reads++;
    searched.push(file);
    const checked = inspect(file, 'file');
    if (checked.error) {
      if (checked.error !== 'missing') warn(`${label} was skipped: ${checked.error}.`);
      cache.set(id, null); return null;
    }
    let fd;
    try {
      if (checked.stat.size > MAX_BYTES) throw new Error('size');
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES || before.ino !== checked.stat.ino || before.dev !== checked.stat.dev) throw new Error('changed');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0, count;
      do { count = fs.readSync(fd, buffer, length, buffer.length - length, length); length += count; } while (count && length < buffer.length);
      const after = inspect(file, 'file');
      if (length > MAX_BYTES || after.error || after.stat.ino !== before.ino || after.stat.dev !== before.dev || after.stat.size !== length) throw new Error('changed');
      const data = JSON.parse(buffer.subarray(0, length).toString('utf8').replace(/^\uFEFF/, ''));
      if (!object(data)) throw new Error('shape');
      cache.set(id, data); return data;
    } catch { warn(`${label} was skipped: invalid, oversized or changing metadata.`); cache.set(id, null); return null; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  function queue(map, value, evidence, {explicit = false, installed = false, vaultPath} = {}) {
    const normalized = absolute(value);
    if (!normalized) { warn(`${evidence} supplied an invalid local path; it was ignored.`); return; }
    const id = key(normalized), prior = map.get(id);
    if (prior) {
      const changed = !prior.evidence.includes(evidence) || (explicit && !prior.explicit) || (installed && !prior.installed) || (vaultPath && !prior.vaultPaths.includes(vaultPath));
      prior.evidence = unique([...prior.evidence, evidence]); prior.explicit ||= explicit; prior.installed ||= installed;
      if (vaultPath && !prior.vaultPaths.includes(vaultPath)) prior.vaultPaths.push(vaultPath);
      if (changed) prior.done = false;
      return;
    }
    if (map.size >= MAX_PATHS) { warn('Installation or vault limit reached; discovery is incomplete.'); return; }
    map.set(id, {path: normalized, evidence: [evidence], explicit, installed, vaultPaths: vaultPath ? [vaultPath] : [], done: false});
  }

  function add(value) {
    value.label = labels[value.kind];
    value.evidence = unique(value.evidence); value.warnings = unique(value.warnings || []);
    const same = (a, b) => a && b && key(a) === key(b);
    const exact = candidates.find(item => (item.installPath ? same(item.installPath, value.installPath) : !value.installPath) && (item.vaultPath ? same(item.vaultPath, value.vaultPath) : !value.vaultPath));
    if (exact) {
      const rank = {unknown: 0, v1: 1, v2: 2, 'starter-v2': 3};
      if (rank[value.kind] > rank[exact.kind]) { exact.kind = value.kind; exact.label = value.label; }
      exact.evidence = unique([...exact.evidence, ...value.evidence]); exact.warnings = unique([...exact.warnings, ...value.warnings]); return;
    }
    if (value.installPath && value.vaultPath) {
      for (let index = candidates.length - 1; index >= 0; index--) {
        const item = candidates[index];
        if ((!item.vaultPath && same(item.installPath, value.installPath)) || (!item.installPath && same(item.vaultPath, value.vaultPath))) {
          value.evidence = unique([...value.evidence, ...item.evidence]); value.warnings = unique([...value.warnings, ...item.warnings]); candidates.splice(index, 1);
        }
      }
    } else {
      const associated = candidates.filter(item => item.installPath && item.vaultPath && (same(item.installPath, value.installPath) || same(item.vaultPath, value.vaultPath)));
      if (associated.length) { for (const item of associated) item.evidence = unique([...item.evidence, ...value.evidence]); return; }
    }
    candidates.push(value);
  }

  function runtimeOwner(value, evidence, vaultPath) {
    const runtime = absolute(value);
    if (!runtime || path.basename(runtime) !== '.runtime') { warn(`${evidence} has no valid runtime folder reference.`); return; }
    const checked = inspect(runtime, 'directory');
    if (checked.error && checked.error !== 'missing') { warn(`${evidence} runtime folder was skipped: ${checked.error}.`); return; }
    queue(installs, path.dirname(runtime), evidence, {installed: true, vaultPath});
  }

  if (install !== undefined) queue(installs, install, 'Explicit installation path', {explicit: true});
  if (vault !== undefined) queue(vaults, vault, 'Explicit vault path', {explicit: true});
  if (!explicitSelection && root !== undefined) queue(installs, root, 'Current clone');
  const homePath = absolute(home);
  if (!explicitSelection && homePath && !inspect(homePath, 'directory').error) {
    for (const parts of [['agentic-os'], ['agentic-os-starter-v2'], ['agentic-os-starter'], ['Documents', 'agentic-os'], ['Documents', 'agentic-os-starter-v2'], ['Desktop', 'agentic-os'], ['Projects', 'agentic-os']]) queue(installs, path.join(homePath, ...parts), 'Conventional installation folder');
    const config = platform === 'win32' ? absolute(env?.APPDATA) || path.join(homePath, 'AppData', 'Roaming')
      : platform === 'darwin' ? path.join(homePath, 'Library', 'Application Support') : absolute(env?.XDG_CONFIG_HOME) || path.join(homePath, '.config');
    const registry = metadata(path.join(config, 'obsidian', 'obsidian.json'), 'Obsidian vault registry');
    if (registry) {
      if (!object(registry.vaults)) warn('Obsidian vault registry has an invalid vault list.');
      else {
        const entries = Object.values(registry.vaults);
        if (entries.length > MAX_PATHS) warn('Obsidian vault registry limit reached; discovery is incomplete.');
        for (const item of entries.slice(0, MAX_PATHS)) {
          if (object(item)) queue(vaults, item.path, 'Obsidian vault registry');
          else warn('Obsidian vault registry contains an invalid entry.');
        }
      }
    }
  } else if (!explicitSelection) warn('Home folder was unavailable; conventional locations were not searched.');

  if (!explicitSelection && typeof getMonitor === 'function') {
    searched.push('http://127.0.0.1:3221/status');
    let timer;
    try {
      const monitor = await Promise.race([Promise.resolve().then(() => getMonitor('http://127.0.0.1:3221/status', {timeoutMs: 1200})), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 1500); })]);
      if (monitor !== null && monitor !== undefined) {
        if (object(monitor) && monitor.kind === 'agentic-os-service-supervisor') runtimeOwner(monitor.runtimeDir, 'Local service monitor');
        else warn('Local monitor did not return recognizable installation metadata.');
      }
    } catch { warn('Local monitor was unavailable; discovery continued without it.'); }
    finally { clearTimeout(timer); }
  }

  // Only metadata references extend these bounded queues; there is no directory traversal.
  while ([...vaults.values(), ...installs.values()].some(item => !item.done)) {
    for (const item of vaults.values()) {
      if (item.done) continue;
      item.done = true; searched.push(item.path);
      const checked = inspect(item.path, 'directory');
      if (checked.error) {
        if (item.explicit && checked.error === 'missing') add({vaultPath: item.path, kind: 'unknown', evidence: item.evidence, warnings: ['The supplied vault folder was not found.']});
        else if (checked.error !== 'missing' || item.explicit) warn(`Vault folder was skipped: ${checked.error}.`);
        continue;
      }
      const plugin = path.join(item.path, '.obsidian', 'plugins');
      const current = metadata(path.join(plugin, V2, 'manifest.json'), 'V2 vault plugin manifest');
      const legacy = metadata(path.join(plugin, V1, 'manifest.json'), 'V1 vault plugin manifest');
      const v2 = current?.id === V2, v1 = legacy?.id === V1;
      if (v2) {
        const evidence = [...item.evidence, 'V2 vault plugin manifest'];
        const marker = metadata(path.join(plugin, V2, 'terminal-runtime.json'), 'V2 terminal runtime reference');
        const notes = v1 ? ['The first starter cockpit is also installed in this vault.'] : [];
        add({vaultPath: item.path, kind: 'v2', evidence, warnings: notes});
        if (marker && (marker.vault === undefined || (absolute(marker.vault) && key(absolute(marker.vault)) === key(item.path)))) runtimeOwner(marker.runtimeDir, 'V2 terminal runtime reference', item.path);
        else if (marker) warn('V2 terminal runtime reference names a different vault; its installation reference was ignored.');
      } else if (v1) add({vaultPath: item.path, kind: 'v1', evidence: [...item.evidence, 'V1 vault plugin manifest'], warnings: []});
      else if (item.explicit) add({vaultPath: item.path, kind: 'unknown', evidence: item.evidence, warnings: ['No recognized Agentic OS plugin manifest was found.']});
    }
    for (const item of installs.values()) {
      if (item.done) continue;
      item.done = true; searched.push(item.path);
      const checked = inspect(item.path, 'directory');
      if (checked.error) {
        if (item.explicit && checked.error === 'missing') add({installPath: item.path, kind: 'unknown', evidence: item.evidence, warnings: ['The supplied installation folder was not found.']});
        else if (checked.error !== 'missing' || item.installed) warn(`Installation folder was skipped: ${checked.error}.`);
        continue;
      }
      let bridge = item.path, installPath = item.path;
      let manifest = metadata(path.join(bridge, 'manifest.json'), 'Installation manifest');
      if (manifest?.id !== V2 && manifest?.id !== V1) {
        const nested = metadata(path.join(bridge, 'obsidian-v2', 'manifest.json'), 'Starter bridge manifest');
        if (nested?.id === V2) { bridge = path.join(bridge, 'obsidian-v2'); manifest = nested; }
      }
      const packaged = manifest?.id === V2 && path.basename(bridge) === 'obsidian-v2' && !inspect(path.join(path.dirname(bridge), 'aos.mjs'), 'file').error;
      if (packaged) installPath = path.dirname(bridge);
      const state = metadata(path.join(bridge, '.runtime', 'aos-setup.json'), 'Installer setup record');
      const associationWarnings = [];
      let savedVault = state && absolute(state.vault);
      if (savedVault) {
        const checkedVault = inspect(savedVault, 'directory');
        if (checkedVault.error && checkedVault.error !== 'missing') {
          warn(`Installer vault reference was skipped: ${checkedVault.error}.`);
          associationWarnings.push('The saved vault reference could not be inspected safely; confirm its location.'); savedVault = null;
        }
      }
      if (state && !savedVault) { warn('Installer setup record has no valid vault path.'); associationWarnings.push('The installer setup record has no usable vault path.'); }
      if (savedVault) queue(vaults, savedVault, 'Installer setup record');
      const installed = item.installed || !!savedVault;
      if (!installed && !item.explicit) continue;
      const recognized = [V1, V2].includes(manifest?.id);
      const kind = installed && recognized ? packaged ? 'starter-v2' : manifest.id === V1 ? 'v1' : 'v2' : 'unknown';
      const evidence = [...item.evidence, ...(savedVault ? ['Installer setup record'] : []), ...(manifest?.id === V2 ? ['V2 installation manifest'] : manifest?.id === V1 ? ['V1 installation manifest'] : [])];
      const notes = [...associationWarnings, ...(!installed ? ['No installed-state evidence was found; this may be a reference checkout.'] : !recognized ? ['The installation reference could not be confirmed by a recognized source manifest.'] : [])];
      const paths = unique([...item.vaultPaths, ...(savedVault ? [savedVault] : [])]);
      if (paths.length > 1) notes.push('This installation has references to more than one vault; confirm the active vault.');
      if (install !== undefined && vault !== undefined && savedVault && absolute(vault) && key(savedVault) !== key(absolute(vault))) notes.push('The explicit vault differs from the saved installation vault; confirm which association is intended.');
      for (const vaultPath of paths.length ? paths : [undefined]) {
        const candidateWarnings = [...notes];
        if (vaultPath) {
          const associated = inspect(vaultPath, 'directory');
          if (associated.error === 'missing') candidateWarnings.push('The associated vault folder no longer exists; confirm its location before any update.');
          else if (associated.error) candidateWarnings.push('The associated vault folder could not be inspected safely.');
          else {
            const expected = manifest?.id === V1 ? V1 : V2;
            const plugin = metadata(path.join(vaultPath, '.obsidian', 'plugins', expected, 'manifest.json'), 'Associated vault plugin manifest');
            if (plugin?.id !== expected) candidateWarnings.push('The associated vault has no matching Agentic OS plugin manifest; confirm which installation it uses.');
          }
        } else candidateWarnings.push('No associated vault was identified; confirm the vault before any update.');
        add({installPath, ...(vaultPath ? {vaultPath} : {}), kind, evidence, warnings: candidateWarnings});
      }
    }
  }
  if (candidates.length > 1) warn('Multiple installation or vault candidates were found; choose explicitly after reviewing the evidence.');
  return {candidates, warnings, searched: unique(searched)};
}
