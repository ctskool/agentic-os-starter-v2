// The skill pack: optional skills a member installs as their own. These pin that installing copies and never
// overwrites a copy the member changed, and that nothing personal to the starter's author ships in the pack.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {installSkillPack, listSkillPack, readSkillPack, skillsCommand, skillsFolder} from '../scripts/aos/skills.mjs';
import {projectRoot} from '../runner/runtime.mjs';

const realPack = path.join(projectRoot, 'skill-pack');
function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-skills-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const packDir = path.join(root, 'pack');
  fs.cpSync(realPack, packDir, {recursive: true});
  return {home: path.join(root, 'home'), runtimeDir: path.join(root, 'runtime'), packDir};
}
const status = (result, id) => result.results.find(item => item.id === id)?.status;
// The author's names, home folders and community, spelled in pieces so this file does not itself trip the leak scan.
const PERSONAL = new RegExp([['cha', 'se'], ['hanne', 'gan'], ['cts', 'kool'], ['sk', 'ool']].map(parts => parts.join('')).join('|') + '|C:[\\\\/]+Users|~/projects', 'i');

test('the pack holds the five skills, each a real skill file, and nothing personal to the author', () => {
  const pack = readSkillPack(realPack);
  assert.deepEqual(pack.skills.map(skill => skill.id).sort(), ['claudex-loop', 'claudex-route', 'close-day', 'codex-build', 'yt-search']);
  for (const skill of pack.skills) {
    assert.ok(skill.label && skill.description.length > 30 && Array.isArray(skill.needs) && skill.since, skill.id);
    const text = fs.readFileSync(path.join(realPack, skill.id, 'SKILL.md'), 'utf8'), front = text.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(front, `${skill.id} has frontmatter`);
    assert.match(front[1], new RegExp(`^name: ${skill.id}$`, 'm'), `${skill.id} is named for its folder`);
    assert.match(front[1], /^description: /m);
    for (const file of skill.files) {
      const body = fs.readFileSync(path.join(realPack, skill.id, file), 'utf8');
      assert.doesNotMatch(body, PERSONAL, `${skill.id}/${file}`);
    }
  }
  // Only the listed files ship: no review logs or other leftovers.
  for (const skill of pack.skills) {
    const walk = dir => fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.relative(path.join(realPack, skill.id), path.join(dir, entry.name)).replace(/\\/g, '/')]);
    assert.deepEqual(walk(path.join(realPack, skill.id)).sort(), [...skill.files].sort(), skill.id);
  }
});

test('list shows what is installed per coding tool, and only the skills that work with the tool asked for', t => {
  const at = scratch(t);
  const all = listSkillPack(at);
  assert.equal(all.skills.length, 5);
  assert.deepEqual(all.skills.find(skill => skill.id === 'close-day').installed, {claude: 'missing', codex: 'missing'});
  assert.deepEqual(all.skills.find(skill => skill.id === 'claudex-loop').installed, {claude: 'missing'});
  assert.deepEqual(all.skills.find(skill => skill.id === 'claudex-loop').installsWith, ['codex-build']);
  assert.equal(all.folders.claude, path.join(at.home, '.claude', 'skills'));
  assert.equal(all.folders.codex, path.join(at.home, '.agents', 'skills'));
  const codex = listSkillPack({...at, provider: 'codex'});
  assert.equal(codex.skills.some(skill => skill.id === 'claudex-loop'), false);
  for (const skill of all.skills) assert.ok(skill.description && skill.needs.length, skill.id);
});

test('install copies the chosen skills, is safe to repeat, and never overwrites a copy the member changed', t => {
  const at = scratch(t), folder = path.join(skillsFolder('claude', at.home), 'close-day'), file = path.join(folder, 'SKILL.md');
  const first = installSkillPack({...at, ids: ['close-day'], provider: 'claude'});
  assert.equal(status(first, 'close-day'), 'installed');
  assert.equal(first.results[0].path, file);
  assert.ok(fs.existsSync(path.join(folder, 'scripts', 'close_day.py')));
  assert.match(first.next, /dashboard add --path/);
  assert.equal(listSkillPack(at).skills.find(skill => skill.id === 'close-day').installed.claude, 'installed');
  assert.equal(status(installSkillPack({...at, ids: ['close-day'], provider: 'claude'}), 'close-day'), 'already-installed');
  // The pack moves on while the member's copy is untouched: the next install updates it.
  fs.appendFileSync(path.join(at.packDir, 'close-day', 'SKILL.md'), '\nA later improvement.\n');
  assert.equal(listSkillPack(at).skills.find(skill => skill.id === 'close-day').installed.claude, 'update');
  assert.equal(status(installSkillPack({...at, ids: ['close-day'], provider: 'claude'}), 'close-day'), 'updated');
  assert.match(fs.readFileSync(file, 'utf8'), /A later improvement\./);
  // The member edits it: it is theirs from now on.
  fs.appendFileSync(file, '\nMy own change.\n');
  assert.equal(listSkillPack(at).skills.find(skill => skill.id === 'close-day').installed.claude, 'edited');
  const kept = installSkillPack({...at, ids: ['close-day'], provider: 'claude'});
  assert.equal(status(kept, 'close-day'), 'kept-yours');
  assert.match(fs.readFileSync(file, 'utf8'), /My own change\./);
  // A folder of that name that was never ours is theirs too.
  const mine = path.join(skillsFolder('claude', at.home), 'yt-search');
  fs.mkdirSync(mine, {recursive: true}); fs.writeFileSync(path.join(mine, 'SKILL.md'), 'my own skill');
  assert.equal(status(installSkillPack({...at, ids: ['yt-search'], provider: 'claude'}), 'yt-search'), 'kept-yours');
  assert.equal(fs.readFileSync(path.join(mine, 'SKILL.md'), 'utf8'), 'my own skill');
});

test('a skill that leans on another brings it along; a skill that does not work with the tool is not installed', t => {
  const at = scratch(t);
  const loop = installSkillPack({...at, ids: ['claudex-loop'], provider: 'claude'});
  assert.deepEqual(loop.results.map(item => [item.id, item.status]), [['claudex-loop', 'installed'], ['codex-build', 'installed']]);
  assert.match(loop.results[1].note, /another chosen skill uses it/);
  assert.ok(fs.existsSync(path.join(skillsFolder('claude', at.home), 'codex-build', 'TANDEM-MODE.md')));
  const codex = installSkillPack({...at, ids: ['claudex-loop', 'close-day'], provider: 'codex'});
  assert.equal(status(codex, 'claudex-loop'), 'not-for-this-tool');
  assert.equal(status(codex, 'close-day'), 'installed');
  assert.ok(fs.existsSync(path.join(at.home, '.agents', 'skills', 'close-day', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(at.home, '.agents', 'skills', 'claudex-loop')), false);
  const everything = installSkillPack({...at, all: true, provider: 'codex'});
  assert.deepEqual(everything.results.map(item => item.id).sort(), ['claudex-route', 'close-day', 'codex-build', 'yt-search']);
});

test('the command refuses what it cannot do and says how to use it', t => {
  const at = scratch(t), lines = [], run = (words, flags) => skillsCommand({words, flags, log: line => lines.push(line), at: {runtime: at.runtimeDir}, options: {home: at.home, packDir: at.packDir}});
  assert.equal(run(['list'], {}), 0); assert.equal(JSON.parse(lines.pop()).skills.length, 5);
  assert.equal(run(['help'], {}), 0); assert.match(lines.pop(), /skills <action>/);
  assert.throws(() => run(['install'], {skills: 'close-day'}), /--provider takes claude or codex/);
  assert.throws(() => run(['install'], {provider: 'claude'}), /Name the skills/);
  assert.throws(() => run(['install'], {provider: 'claude', skills: 'not-a-skill'}), /is not in the skill pack/);
  assert.throws(() => run(['install'], {provider: 'gemini', all: true}), /--provider takes claude or codex/);
  assert.throws(() => run(['list'], {skills: 'x'}), /Unknown skills flag/);
  assert.throws(() => run(['remove'], {}), /Use: skills list/);
  assert.throws(() => readSkillPack(path.join(at.home, 'nowhere')), /no skill pack/);
  assert.equal(run(['install'], {provider: 'claude', skills: 'close-day, yt-search'}), 0);
  assert.deepEqual(JSON.parse(lines.pop()).results.map(item => item.status), ['installed', 'installed']);
});

test('what the member was shown is remembered, whatever they answered, so a later update offers each skill once', t => {
  const at = scratch(t), lines = [], run = (words, flags) => skillsCommand({words, flags, log: line => lines.push(line), at: {runtime: at.runtimeDir}, options: {home: at.home, packDir: at.packDir}});
  const offered = () => Object.fromEntries(listSkillPack(at).skills.map(skill => [skill.id, skill.offered]));
  // Nothing shown yet: every skill is still to be offered, including ones from an older version
  // (a member whose earlier update nobody walked through never saw them).
  assert.ok(Object.values(offered()).every(value => value === false));
  assert.equal(run(['offered'], {skills: 'close-day, yt-search'}), 0);
  assert.deepEqual(JSON.parse(lines.pop()).offered, ['close-day', 'yt-search']);
  assert.equal(offered()['close-day'], true); assert.equal(offered()['claudex-loop'], false);
  // Recording again adds without forgetting; the member saying no is still "offered".
  run(['offered'], {skills: 'claudex-loop,close-day'});
  assert.deepEqual(JSON.parse(lines.pop()).offered, ['close-day', 'yt-search', 'claudex-loop']);
  // Installing does not need it and does not change it.
  run(['install'], {provider: 'claude', skills: 'codex-build'});
  assert.equal(offered()['codex-build'], false);
  assert.throws(() => run(['offered'], {}), /Name the skills that were shown/);
  assert.throws(() => run(['offered'], {skills: 'not-a-skill'}), /Not in the skill pack: not-a-skill/);
  assert.throws(() => run(['offered'], {skills: 'close-day', provider: 'claude'}), /Unknown skills flag/);
  // A damaged record reads as nothing shown, never as an error.
  fs.writeFileSync(path.join(at.runtimeDir, 'skill-pack-offered.json'), '{broken');
  assert.ok(Object.values(offered()).every(value => value === false));
});
