// Creates or completes a vault from vault-template/. An existing note is never
// overwritten, and an existing vault's Obsidian settings are never written.
import fs from 'node:fs';
import path from 'node:path';

const NEW_VAULT_SETTINGS = '.obsidian-new-vault';

function copyMissing(from, to, report) {
  fs.mkdirSync(to, {recursive: true});
  for (const entry of fs.readdirSync(from, {withFileTypes: true})) {
    if (entry.name === NEW_VAULT_SETTINGS || entry.name === '.gitkeep') continue;
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    const present = fs.lstatSync(target, {throwIfNoEntry: false});
    // A linked folder or file may point outside the vault; whatever it is, it is the user's and stays as it is.
    if (present?.isSymbolicLink()) { report.kept++; continue; }
    if (entry.isDirectory()) { if (present && !present.isDirectory()) { report.kept++; continue; } copyMissing(source, target, report); continue; }
    if (present) { report.kept++; continue; }
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); report.created++;
  }
}

export function scaffoldVault(template, vault) {
  if (!path.isAbsolute(vault)) throw new Error('The vault path must be absolute.');
  const blocked = [template, path.dirname(template)].some(dir => { const relative = path.relative(dir, vault); return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative)); });
  if (blocked) throw new Error('Choose a vault folder outside this installation folder.');
  const report = {vault, created: 0, kept: 0, newVault: !fs.lstatSync(path.join(vault, '.obsidian'), {throwIfNoEntry: false})};
  copyMissing(template, vault, report);
  // Only a vault Obsidian has never opened gets starter settings (the plugin listed, so
  // Obsidian offers to trust it on first open). Existing settings belong to the user.
  if (report.newVault) copyMissing(path.join(template, NEW_VAULT_SETTINGS), path.join(vault, '.obsidian'), report);
  return report;
}

export function pluginEnabled(vault) {
  try { return JSON.parse(fs.readFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), 'utf8')).includes('agentic-os-v2'); } catch { return false; }
}
export const pluginInstalled = vault => ['main.js', 'manifest.json', 'styles.css'].every(name => fs.existsSync(path.join(vault, '.obsidian', 'plugins', 'agentic-os-v2', name)));
