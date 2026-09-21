import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

test('the one-paste launcher still loads before npm dependencies exist', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-bootstrap-'));
  t.after(() => fs.rmSync(scratch, {recursive: true, force: true}));
  const loader = path.join(scratch, 'no-packages.mjs');
  fs.writeFileSync(loader, 'export async function resolve(specifier, context, next) { if (!specifier.startsWith("node:") && !specifier.startsWith(".") && !specifier.startsWith("file:") && !specifier.startsWith("/") && !/^[A-Za-z]:/.test(specifier)) throw new Error("Cold install cannot import package: " + specifier); return next(specifier, context); }');
  const launcher = fileURLToPath(new URL('../scripts/aos.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--no-warnings', '--loader', pathToFileURL(loader).href, launcher, 'help'], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /setup --vault/);
  assert.match(result.stdout, /dashboard/);
});
