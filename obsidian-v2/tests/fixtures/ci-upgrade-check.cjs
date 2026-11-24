// CI only: what a member must still have, and must now have, after an update.
// Run from the root of the updated checkout. VAULT is the vault the old release was installed into.
// `before` writes what the member did with the old release; `after` proves it survived the update.
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const vault = process.env.VAULT || '';
if (!vault || !fs.existsSync(vault)) { console.error('VAULT must be the installed vault.'); process.exit(2); }
const NOTE = '# Mine\n\nA note the update must not touch.\n';
const DRIVERS = ['Write', 'Train', 'Ship'];
const BUTTONS = ['plan-today', 'deep-research-chase', 'weekly-review'];
const noteFile = path.join(vault, 'my-own-note.md'), profileFile = path.join(vault, 'system', 'v2', 'profile.json');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const aos = (...args) => {
  const run = spawnSync(process.execPath, ['aos.mjs', ...args], {encoding: 'utf8', windowsHide: true});
  if (run.status !== 0) throw new Error(`aos ${args.join(' ')} failed:\n${run.stdout}\n${run.stderr}`);
  return run.stdout;
};
const dashboard = () => JSON.parse(aos('dashboard', 'list'));

if (process.argv[2] === 'before') {
  fs.writeFileSync(noteFile, NOTE);
  const profile = fs.existsSync(profileFile) ? json(profileFile) : {};
  fs.mkdirSync(path.dirname(profileFile), {recursive: true});
  fs.writeFileSync(profileFile, JSON.stringify({...profile, dailyDrivers: DRIVERS}, null, 1));
  aos('dashboard', 'select', '--skills', BUTTONS.join(','), '--revision', dashboard().revision);
  console.log('member state written:', JSON.stringify({note: path.basename(noteFile), dailyDrivers: DRIVERS, buttons: dashboard().selected}));
  process.exit(0);
}

const problems = [], same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const expect = (ok, text) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`); if (!ok) problems.push(text); };
const release = json('VERSION.json').plugin, built = json(path.join('obsidian-v2', 'manifest.json')).version;
const installed = json(path.join(vault, '.obsidian', 'plugins', 'agentic-os-v2', 'manifest.json')).version;
expect(release === built, `the checkout is one release (${release} / ${built})`);
expect(installed === built, `the plugin in the vault is the new one (${installed})`);
expect(fs.readFileSync(noteFile, 'utf8') === NOTE, 'their own note is untouched');
expect(same(json(profileFile).dailyDrivers, DRIVERS), 'their Daily Drivers are kept');
expect(same(dashboard().selected, BUTTONS), `their dashboard buttons are kept (${JSON.stringify(dashboard().selected)})`);
const live = JSON.parse(aos('openai-key', '--check'));
expect(live.ready === false, 'Live voice is installed but not switched on');
if (problems.length) { console.error(`\n${problems.length} thing(s) did not survive the update.`); process.exit(1); }
console.log('\nThe update kept what the member had.');
