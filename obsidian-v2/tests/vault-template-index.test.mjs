import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Member report: a fresh vault opened with a dead link and folder lists that did not match the template,
// so the first thing Plan Today told a new member to do was repair the starter.
const template = fileURLToPath(new URL('../vault-template/', import.meta.url));
const notes = [];
(function walk(dir) { for (const entry of fs.readdirSync(dir, {withFileTypes: true})) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (entry.name.endsWith('.md')) notes.push(full); } })(template);
const slashes = file => file.split(path.sep).join('/');
const withoutExtension = file => file.slice(0, -'.md'.length);
const names = new Set(notes.map(file => withoutExtension(path.basename(file))));
const relative = new Set(notes.map(file => withoutExtension(slashes(path.relative(template, file)))));
const read = file => fs.readFileSync(path.join(template, file), 'utf8');
const bullets = file => read(file).split('\n').map(line => line.trimEnd()).filter(line => line.startsWith('- '));

test('every wiki-link in the template index notes points at a note the template ships', () => {
  for (const file of notes.filter(file => path.basename(file) === '_index.md')) {
    const text = fs.readFileSync(file, 'utf8').replace(/`[^`\n]*`/g, '');
    for (const [, target] of text.matchAll(/\[\[([^\]|#]+)/g)) assert.ok(names.has(target.trim()) || relative.has(target.trim()), `${slashes(path.relative(template, file))} links [[${target}]], which the template does not ship`);
  }
});

test('the system and inbox index notes only list folders the template ships', () => {
  for (const line of bullets('system/_index.md')) for (const [, folder] of line.matchAll(/[*][*]([a-z0-9-]+)[/][*][*]/g)) assert.ok(fs.existsSync(path.join(template, 'system', folder)), `system/${folder}/ is listed but not shipped`);
  for (const line of bullets('inbox/_index.md')) {
    const [parent, ...children] = [...line.matchAll(/`([a-z0-9-]+)[/]`/g)].map(match => match[1]);
    assert.ok(fs.existsSync(path.join(template, 'inbox', parent)), `inbox/${parent}/ is listed but not shipped`);
    for (const child of children) assert.ok(fs.existsSync(path.join(template, 'inbox', parent, child)), `inbox/${parent}/${child}/ is listed but not shipped`);
  }
  for (const folder of ['bases', 'v2']) assert.ok(read('system/_index.md').includes(`**${folder}/**`), `system/${folder}/ ships but is not listed`);
  assert.ok(read('inbox/_index.md').includes('`voice/`'), 'inbox/voice/ ships but is not listed');
});
