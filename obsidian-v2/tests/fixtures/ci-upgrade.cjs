// CI only: the upgrade job in .github/workflows/ci.yml.
// Run from the root of a checkout that sits at an OLD release. It calls that old release's own
// `update` (the code a member's `node aos.mjs update` runs), so the old source guard, the stop of
// the running services and the hand-over to the new setup are all the real thing.
// Two steps are swapped, both because the commit under test is not on main yet:
//   - the download takes NEW_SHA instead of pulling main, then records it as origin/main the way a pull does;
//   - the re-run of setup gets --ci, because no coding CLI is signed in on a runner.
const {execFileSync, spawnSync} = require('node:child_process');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const target = process.env.NEW_SHA || '';
if (!/^[0-9a-f]{40}$/.test(target)) { console.error('NEW_SHA must be a full commit id.'); process.exit(2); }
const git = args => execFileSync('git', args, {stdio: 'inherit'});

import(pathToFileURL(path.resolve('obsidian-v2', 'scripts', 'aos', 'setup.mjs')).href).then(async installed => {
  const result = await installed.update({
    pull: () => {
      console.log(`-> Taking ${target.slice(0, 7)} in place of main`);
      git(['merge', '--ff-only', target]);
      git(['update-ref', 'refs/remotes/origin/main', target]);
    },
    install: ({root, vault}) => {
      console.log('-> Running setup from the updated files (--ci)');
      const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'aos.mjs'), 'setup', '--vault', vault, '--rebuild', '--ci'], {cwd: root, stdio: 'inherit', windowsHide: true});
      if (run.error) throw run.error;
      return {ok: run.status === 0, exitCode: run.status};
    },
  });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}).catch(error => { console.error(error); process.exit(1); });
