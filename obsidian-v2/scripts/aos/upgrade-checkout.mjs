// Read-only, offline assessment of the stock starter checkout. The saved origin
// refs are evidence, not a fresh verification of GitHub or a proof that every
// possible customization is absent. Uncertain checkouts require an upgrade review.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const protectedNames = new Set(['jev.json', 'bridge-auth.json', 'providers.json', '.credentials.json']);
const protectedDirectories = new Set(['.runtime', '.credentials', 'credentials', '.secrets', 'secrets']);
const officialHttps = 'https://github.com/ctskool/agentic-os-starter-v2.git';
// Git for Windows rejects Node's \\.\nul spelling; its native NUL device works.
const gitNull = process.platform === 'win32' ? 'NUL' : os.devNull;
// Assemble the public SSH address so the export's private-email scan remains strict.
const officialSsh = ['git', 'github.com:ctskool/agentic-os-starter-v2.git'].join('@');
const officialOrigins = new Set(['https://github.com/ctskool/agentic-os-starter-v2', officialHttps, officialSsh]);
const controls = /[\x00-\x1f\x7f-\x9f]/;
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const safeRelative = name => typeof name === 'string' && name.length < 4096 && !controls.test(name) && !path.isAbsolute(name) && !name.includes('\\') && name.split('/').every(part => part && part !== '.' && part !== '..');
const protectedPath = name => name.split('/').some(part => { const lower = part.toLowerCase(); return protectedNames.has(lower) || protectedDirectories.has(lower) || lower === '.env' || lower.startsWith('.env.'); });
const inspect = file => { try { return fs.lstatSync(file); } catch { return null; } };
const assessmentContexts = new WeakMap();
const inside = (folder, candidate) => { const relative = path.relative(folder, candidate); return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)); };

function noLinks(file, checked = new Set()) {
  let current = path.resolve(file);
  while (!checked.has(current)) {
    const stat = inspect(current);
    if (stat?.isSymbolicLink() || (stat?.isFile() && stat.nlink !== 1)) throw new Error('Linked files or folders require an upgrade review.');
    checked.add(current);
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function smallFile(file, maxBytes, checked) {
  noLinks(file, checked);
  const stat = inspect(file);
  if (!stat?.isFile() || stat.size > maxBytes) throw new Error('Checkout metadata is missing, unreadable, or too large to assess safely.');
  return fs.readFileSync(file, 'utf8');
}
function trustedGitContext(repositoryPath, sourceEnv) {
  // Windows searches cwd before PATH for an unqualified executable. Resolve the
  // real binary ourselves and never consider a relative or checkout-owned PATH.
  const suppliedPath = Object.entries(sourceEnv).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  const directories = [];
  for (let directory of suppliedPath.split(path.delimiter)) {
    if (directory.startsWith('"') && directory.endsWith('"')) directory = directory.slice(1, -1);
    if (!path.isAbsolute(directory) || controls.test(directory) || inside(repositoryPath, directory) || (process.platform === 'win32' && directory.startsWith('\\\\'))) continue;
    try {
      directory = fs.realpathSync.native(directory);
      if (!inside(repositoryPath, directory) && fs.statSync(directory).isDirectory()) directories.push(directory);
    } catch { /* Missing PATH entries are not searched. */ }
  }
  let executable;
  for (const directory of directories) {
    try {
      const candidate = fs.realpathSync.native(path.join(directory, process.platform === 'win32' ? 'git.exe' : 'git'));
      if (inside(repositoryPath, candidate) || !fs.statSync(candidate).isFile()) continue;
      if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
      executable = candidate; break;
    } catch { /* No trusted Git executable in this PATH entry. */ }
  }
  if (!executable) throw new Error('An installed Git executable outside this checkout could not be found.');
  const inherited = Object.fromEntries(Object.entries(sourceEnv).filter(([key]) => !/^GIT_/i.test(key) && key.toUpperCase() !== 'PATH'));
  const env = Object.freeze({...inherited, PATH: directories.join(path.delimiter), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitNull, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1'});
  const args = Object.freeze(['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + gitNull, '-c', 'core.untrackedCache=false', '-c', 'core.preloadIndex=false', '-c', 'credential.helper=', '-c', 'core.askPass=']);
  return Object.freeze({repositoryPath, executable, env, args});
}
function gitReader(context, run) {
  return args => {
    let result;
    try {
      result = run(context.executable, [...context.args, ...args],
        {cwd: context.repositoryPath, env: {...context.env}, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
    } catch { return {ok: false, status: null, text: ''}; }
    if (result?.error || result?.signal || !Number.isInteger(result?.status) || typeof result.stdout !== 'string' || result.stdout.length > 2 * 1024 * 1024) return {ok: false, status: null, text: ''};
    return {ok: result.status === 0, status: result.status, text: result.stdout};
  };
}
function nulRecords(text) {
  if (!text) return [];
  if (!text.endsWith('\0')) throw new Error('Git returned an incomplete file listing.');
  return text.slice(0, -1).split('\0');
}
function changedFiles(text) {
  const records = nulRecords(text), changes = new Set(); let privateChanges = false, unusualNames = false;
  const add = name => { if (!safeRelative(name)) unusualNames = true; else if (protectedPath(name)) privateChanges = true; else changes.add(name); };
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.length < 4 || record[2] !== ' ' || !/^[ MADRCUT?!]{2}$/.test(record.slice(0, 2))) throw new Error('Git returned an unrecognized change listing.');
    add(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2))) {
      if (++index >= records.length) throw new Error('Git returned an incomplete rename listing.');
      add(records[index]);
    }
  }
  return {changes: [...changes].sort().slice(0, 200), privateChanges, unusualNames, count: records.length};
}

export function assessCheckout(installPath, {run = spawnSync, env = process.env} = {}) {
  const result = {repositoryPath: '', kind: 'unknown', updateAllowed: false, issues: [], changes: []};
  const issue = message => { result.issues.push(message); return result; };
  try {
    if (typeof installPath !== 'string' || !installPath || controls.test(installPath)) return issue('Choose an installation folder with a normal absolute path.');
    const supplied = path.resolve(installPath), checked = new Set();
    noLinks(supplied, checked);
    if (!inspect(supplied)?.isDirectory()) return issue('The installation folder does not exist or is not a directory.');
    const repositoryPath = fs.realpathSync.native(path.basename(supplied).toLowerCase() === 'obsidian-v2' ? path.dirname(supplied) : supplied);
    result.repositoryPath = repositoryPath;
    for (const [name, directory] of [['aos.mjs', false], ['obsidian-v2', true], ['jarvis-v2', true], ['VERSION.json', false]]) {
      const file = path.join(repositoryPath, name); noLinks(file, checked);
      const stat = inspect(file);
      if (!stat || (directory ? !stat.isDirectory() : !stat.isFile())) return issue('This folder does not have the complete exported starter layout.');
    }
    let version;
    try { version = JSON.parse(smallFile(path.join(repositoryPath, 'VERSION.json'), 8192, checked)); } catch { return issue('The starter version metadata is missing or invalid.'); }
    if (!version || typeof version.plugin !== 'string' || !version.plugin || typeof version.hud !== 'string' || !version.hud || !/^[a-f0-9]{7,64}$/.test(version.bridgeCommit) || !/^[a-f0-9]{7,64}$/.test(version.hudCommit)) return issue('The starter version metadata is missing or invalid.');
    const gitDir = path.join(repositoryPath, '.git'); noLinks(gitDir, checked);
    if (!inspect(gitDir)?.isDirectory()) return issue('A normal Git clone is required; missing Git metadata and linked worktrees need an upgrade review.');
    for (const name of ['HEAD', 'index', 'packed-refs', 'objects', 'refs', 'refs/heads/main', 'refs/remotes/origin/main', 'info/exclude']) noLinks(path.join(gitDir, name), checked);
    for (const name of ['commondir', 'objects/info/alternates']) {
      noLinks(path.join(gitDir, name), checked);
      if (inspect(path.join(gitDir, name))) return issue('Redirected Git metadata requires an upgrade review.');
    }
    for (const name of ['config', 'config.worktree']) {
      const file = path.join(gitDir, name); noLinks(file, checked);
      if (name === 'config' || inspect(file)) {
        const config = smallFile(file, 256 * 1024, checked);
        // Reject includes before Git can follow a local include to another file.
        if (/\[\s*include(?:if)?\b/i.test(config)) return issue('Git configuration includes other files; review this checkout before updating.');
      }
    }
    const excludeFile = path.join(gitDir, 'info', 'exclude');
    if (inspect(excludeFile) && smallFile(excludeFile, 64 * 1024, checked).split(/\r?\n/).some(line => line.trim() && !line.trim().startsWith('#'))) return issue('Local Git exclude rules could hide member files; review this checkout before updating.');
    let context;
    try { context = trustedGitContext(repositoryPath, env); } catch { return issue('An installed Git executable outside this checkout could not be found safely.'); }
    const git = gitReader(context, run);
    const top = git(['rev-parse', '--show-toplevel']);
    if (!top.ok) return issue('Git is unavailable or could not read this checkout safely.');
    const topPath = top.text.trim();
    if (controls.test(topPath) || !path.isAbsolute(topPath) || !samePath(path.resolve(topPath), repositoryPath)) return issue('The Git repository root does not match the starter installation folder.');
    const configuration = git(['config', '--local', '--no-includes', '--name-only', '--get-regexp', '^(filter\\.|core\\.(worktree|attributesfile|excludesfile)|extensions\\.(worktreeconfig|partialclone)|remote\\..*\\.(promisor|partialclonefilter)|url\\.)']);
    if (configuration.status !== 1 && !configuration.ok) return issue('Git configuration could not be checked safely.');
    if (configuration.ok && configuration.text.trim()) return issue('Git filters, file redirects, URL rewrites, or partial/promisor clones require an upgrade review; no configured helper or network request was run.');
    const origin = git(['config', '--local', '--no-includes', '--get-all', 'remote.origin.url']);
    if (!origin.ok || !origin.text.trim()) return issue('No origin remote could be verified for this checkout.');
    if (!officialOrigins.has(origin.text.trim())) { result.kind = 'customized'; return issue('The origin remote is not the exact official starter repository.'); }
    const head = git(['rev-parse', '--verify', 'HEAD']);
    if (!head.ok || !/^[a-f0-9]{40,64}$/.test(head.text.trim())) return issue('The current Git commit could not be verified.');
    result.head = head.text.trim();
    const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branch.ok || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(branch.text.trim())) return issue('The checkout is detached or its branch could not be verified.');
    result.branch = branch.text.trim();
    if (result.branch !== 'main') { result.kind = 'customized'; return issue('This checkout uses a branch other than main.'); }
    const upstream = git(['rev-parse', '--symbolic-full-name', '@{upstream}']);
    const branchRemote = git(['config', '--local', '--no-includes', '--get-all', 'branch.main.remote']);
    const branchMerge = git(['config', '--local', '--no-includes', '--get-all', 'branch.main.merge']);
    if (!upstream.ok || upstream.text.trim() !== 'refs/remotes/origin/main' || !branchRemote.ok || branchRemote.text.trim() !== 'origin' || !branchMerge.ok || branchMerge.text.trim() !== 'refs/heads/main') return issue('The main branch is not tracking origin/main in the expected way.');
    const index = git(['ls-files', '--stage', '-v', '-z']);
    if (!index.ok) return issue('Tracked files could not be listed safely.');
    const tracked = new Set();
    for (const record of nulRecords(index.text)) {
      const match = /^([A-Za-z?]) ([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t(.+)$/.exec(record);
      if (!match || !safeRelative(match[5])) return issue('Tracked file metadata contains unsupported entries or filenames.');
      const [, flag, mode, , stage, name] = match;
      if (protectedPath(name)) return issue('Protected configuration files are tracked; review this checkout without reading their contents.');
      if (flag !== 'H' || stage !== '0' || !['100644', '100755'].includes(mode)) return issue('Linked files, submodules, merge conflicts, or hidden tracked changes require an upgrade review.');
      noLinks(path.join(repositoryPath, name), checked); tracked.add(name);
    }
    if (!tracked.has('aos.mjs') || !tracked.has('VERSION.json')) return issue('The starter launcher or version metadata is not tracked by Git.');
    const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all']);
    if (!status.ok) return issue('Git could not finish checking for changed and untracked files safely.');
    const changed = changedFiles(status.text); result.changes = changed.changes;
    if (changed.count) {
      result.kind = 'customized';
      issue('There are changed, staged, or untracked files in this checkout.');
      if (changed.privateChanges) issue('Protected configuration filenames were omitted from the change list.');
      if (changed.unusualNames) issue('Filenames with unsupported characters were omitted from the change list.');
      if (changed.count > 200) issue('The change list is limited to the first 200 paths.');
      return result;
    }
    const divergence = git(['rev-list', '--left-right', '--count', 'HEAD...refs/remotes/origin/main']);
    const counts = divergence.ok && /^(\d+)\s+(\d+)\s*$/.exec(divergence.text);
    if (!counts) return issue('Local commits could not be compared with the saved origin/main reference.');
    if (Number(counts[1]) !== 0) { result.kind = 'customized'; return issue('Local commits are ahead of or diverge from the saved origin/main reference.'); }
    result.kind = 'stock-starter'; result.updateAllowed = true; assessmentContexts.set(result, context); return result;
  } catch {
    // Filesystem and Git errors can contain private paths or configuration values.
    return issue('The checkout could not be assessed safely. Review it before updating.');
  }
}

// Preparing the updater requires an assessment made by this module, not a JSON
// object claiming success. It binds the same trusted executable and environment
// before services are touched. Only invoking this returned function uses network.
export function prepareStockUpdate(assessment, {run = spawnSync, log = console.log} = {}) {
  const context = assessmentContexts.get(assessment);
  if (!context || assessment.updateAllowed !== true) throw new Error('A fresh trusted checkout assessment is required before updating. Run `node aos.mjs upgrade`.');
  return () => {
    log('-> Getting the latest official starter (fast-forward only)');
    let result;
    try {
      result = run(context.executable, [...context.args,
        '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false', '-c', 'http.extraHeader=', '-c', 'http.cookieFile=',
        'pull', '--ff-only', '--no-rebase', '--no-autostash', '--no-recurse-submodules', officialHttps, 'refs/heads/main:refs/remotes/origin/main'],
        {cwd: context.repositoryPath, env: {...context.env}, encoding: 'utf8', windowsHide: true, timeout: 5 * 60 * 1000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
    } catch { throw new Error('The official starter could not be updated. Services remain stopped; run `node aos.mjs start` to restore the current installation, then review `node aos.mjs upgrade`.'); }
    if (result?.status !== 0 || result.error || result.signal) throw new Error('The official starter could not be updated. Services remain stopped; run `node aos.mjs start` to restore the current installation, then review `node aos.mjs upgrade`.');
  };
}
