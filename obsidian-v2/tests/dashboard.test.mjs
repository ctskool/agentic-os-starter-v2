import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readDashboard,saveDashboard,registerDashboardSkill,discoverDashboardSkills,prepareDashboardSkill,assertDashboardReplay} from '../runner/dashboard.mjs';
import {DEFAULT_COCKPIT_SKILLS,DEFAULT_HUD_SKILLS,MAX_DASHBOARD_SKILLS,dashboardSelected,validateDashboardSelection,isInstalledSkill} from '../shared/dashboard.mjs';

// Every filesystem operation is confined to a generated temporary directory.
// Every catalog/launch call injects CLI availability, never reading provider pins.
const online = {cliAvailable:() => true},offline = {cliAvailable:() => false};
const selection = {provider:'codex',model:'gpt-6-astra'};
function fixture(t) {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'aos-dashboard-test-')));
  t.after(() => fs.rmSync(folder,{recursive:true,force:true}));
  const root = path.join(folder,'vault'),home = path.join(folder,'home');
  fs.mkdirSync(root);fs.mkdirSync(home);
  return {folder,root,home,config:path.join(root,'system','v2','dashboard.json')};
}
function skillAt(folder,name = 'Research helper',description = 'Research a topic and explain the sources.') {
  fs.mkdirSync(folder,{recursive:true});
  const file = path.join(folder,'SKILL.md');
  fs.writeFileSync(file,`---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\nFollow the user request.\n`);
  return file;
}
const view = root => readDashboard(root,online);
const register = (root,file,providers = ['codex']) => registerDashboardSkill(root,{revision:view(root).revision,path:file,providers},online);

test('unconfigured dashboards retain surface defaults; empty selection is intentional',t => {
  const {root} = fixture(t),initial = view(root);
  assert.equal(initial.revision,'missing');assert.equal(initial.configured,false);assert.equal(initial.selected,null);
  assert.deepEqual(dashboardSelected(initial.selected),DEFAULT_COCKPIT_SKILLS);
  assert.deepEqual(dashboardSelected(initial.selected,'hud'),DEFAULT_HUD_SKILLS);
  assert.equal(MAX_DASHBOARD_SKILLS,10);
  const empty = saveDashboard(root,{revision:initial.revision,selected:[]},online);
  assert.equal(empty.configured,true);assert.deepEqual(empty.selected,[]);assert.deepEqual(dashboardSelected([]),[]);
  const reset = saveDashboard(root,{revision:empty.revision,selected:null},online);
  assert.equal(reset.configured,false);assert.equal(reset.selected,null);
});

test('selection validates IDs, order, uniqueness and the limit',t => {
  const {root} = fixture(t),initial = view(root);
  const selected = ['weekly-review','plan-today'];
  const saved = saveDashboard(root,{revision:initial.revision,selected},online);
  assert.deepEqual(saved.selected,selected);assert.deepEqual(view(root).selected,selected);
  for (const invalid of [undefined,{},['plan-today','plan-today'],['not-real'],Array.from({length:11},(_,i) => 'id'+i)]) {
    assert.throws(() => saveDashboard(root,{revision:saved.revision,selected:invalid},online));
    assert.deepEqual(view(root).selected,selected);
  }
  assert.throws(() => validateDashboardSelection(['a','a']),/different/);
});

test('optimistic concurrency preserves the newer order',t => {
  const {root} = fixture(t),old = view(root);
  const current = saveDashboard(root,{revision:old.revision,selected:['plan-today']},online);
  assert.throws(() => saveDashboard(root,{revision:old.revision,selected:['weekly-review']},online),/another window/);
  assert.equal(view(root).revision,current.revision);assert.deepEqual(view(root).selected,['plan-today']);
});

test('malformed config is visible and cannot be silently replaced',t => {
  const {root,config,folder} = fixture(t);
  fs.mkdirSync(path.dirname(config),{recursive:true});fs.writeFileSync(config,'{"selected":');
  const before = fs.readFileSync(config,'utf8'),state = view(root);
  assert.match(state.error,/not valid JSON/);assert.equal(state.revision,'invalid');
  assert.throws(() => saveDashboard(root,{revision:state.revision,selected:[]},online),/not valid JSON/);
  assert.throws(() => registerDashboardSkill(root,{revision:'invalid',path:skillAt(path.join(folder,'skill')),providers:['codex']},online),/not valid JSON/);
  assert.equal(fs.readFileSync(config,'utf8'),before);assert.equal(fs.existsSync(config+'.lock'),false);
});

test('unsupported schemas and invalid registered metadata are preserved',t => {
  const {root,config} = fixture(t);fs.mkdirSync(path.dirname(config),{recursive:true});
  for (const data of [{version:2,selected:null,skills:[]},{version:1,selected:['missing'],skills:[]},{version:1,selected:null,skills:[{id:'installed:fake'}]}]) {
    const text = JSON.stringify(data);fs.writeFileSync(config,text);
    assert.ok(view(root).error);
    assert.throws(() => saveDashboard(root,{revision:'invalid',selected:[]},online));
    assert.equal(fs.readFileSync(config,'utf8'),text);
  }
});

test('explicit registration exposes metadata, supports selection, and prepares an interactive request',t => {
  const {root,folder,config} = fixture(t),file = skillAt(path.join(folder,'custom skill'));
  const result = register(root,file),id = result.registeredId;
  assert.ok(isInstalledSkill(id));assert.equal(result.selected,null);
  const item = result.catalog.find(item => item.id === id);
  assert.equal(item.kind,'installed');assert.equal(item.available,true);assert.deepEqual(item.providers,['codex']);
  assert.equal(item.path,undefined);assert.equal(item.hash,undefined);
  const persisted = JSON.parse(fs.readFileSync(config,'utf8'));
  assert.equal(persisted.skills[0].path,fs.realpathSync(file));assert.match(persisted.skills[0].hash,/^[a-f0-9]{64}$/);
  assert.equal(persisted.skills[0].body,undefined);
  const saved = saveDashboard(root,{revision:result.revision,selected:[id,'plan-today']},online);
  assert.deepEqual(saved.selected,[id,'plan-today']);
  const request = prepareDashboardSkill(root,{skill:id,request:'Research apples',selection},online);
  assert.equal(request.title,'Research helper');assert.deepEqual(request.selection,selection);
  assert.ok(request.prompt.includes(JSON.stringify(fs.realpathSync(file))));assert.match(request.prompt,/interactive task/);assert.match(request.prompt,/Research apples/);
  assert.equal(request.workflow,undefined);assert.equal(request.execution,undefined);
});

test('changed or missing skill is disabled until re-registration; ID and selection survive refresh',t => {
  const {root,folder} = fixture(t),file = skillAt(path.join(folder,'skill'));
  const result = register(root,file),id = result.registeredId;
  saveDashboard(root,{revision:result.revision,selected:[id]},online);
  fs.appendFileSync(file,'New instructions.\n');
  assert.match(view(root).catalog.find(item => item.id === id).reason,/changed/);
  assert.throws(() => prepareDashboardSkill(root,{skill:id,request:'Go',selection},online),/changed/);
  const refreshed = register(root,file);
  assert.equal(refreshed.registeredId,id);assert.deepEqual(refreshed.selected,[id]);assert.equal(refreshed.catalog.find(item => item.id === id).available,true);
  fs.unlinkSync(file);
  assert.match(view(root).catalog.find(item => item.id === id).reason,/missing/);
  assert.throws(() => prepareDashboardSkill(root,{skill:id,request:'Go',selection},online));
});

test('registration checks revision and validates metadata and provider declarations',t => {
  const {root,folder} = fixture(t),file = skillAt(path.join(folder,'skill'));
  const old = view(root).revision;
  saveDashboard(root,{revision:old,selected:[]},online);
  assert.throws(() => registerDashboardSkill(root,{revision:old,path:file,providers:['codex']},online),/another window/);
  for (const invalid of [[],['other'],['codex','codex'],null]) assert.throws(() => register(root,file,invalid),/supported providers/);
  fs.writeFileSync(file,'# Not a skill\n');assert.throws(() => register(root,file),/frontmatter/);
  fs.writeFileSync(file,'---\nname: A\nname: B\ndescription: valid\n---\n');assert.throws(() => register(root,file),/invalid or duplicate/);
  fs.writeFileSync(file,'---\nname: A\n---\n');assert.throws(() => register(root,file),/description/);
  assert.throws(() => register(root,path.join(folder,'README.md')),/SKILL.md/);
  assert.throws(() => register(root,'relative/SKILL.md'),/absolute/);
});

test('provider compatibility and CLI installation are checked again at launch',t => {
  const {root,folder} = fixture(t),result = register(root,skillAt(path.join(folder,'skill')),['claude']);
  const input = {skill:result.registeredId,request:'Go',selection};
  assert.throws(() => prepareDashboardSkill(root,input,online),/not registered for codex/);
  const claudeInput = {...input,selection:{provider:'claude',model:'sonnet'}};
  assert.throws(() => prepareDashboardSkill(root,claudeInput,offline),/CLI is not installed/);
  assert.equal(readDashboard(root,offline).catalog.find(item => item.id === result.registeredId).available,false);
  assert.equal(readDashboard(root,offline).catalog.find(item => item.id === 'metrics-pull').available,true);
  assert.equal(readDashboard(root,offline).catalog.find(item => item.id === 'plan-today').available,false);
  assert.deepEqual(readDashboard(root,offline).installedProviders,[]);
  assert.deepEqual(readDashboard(root,{cliAvailable:provider => provider === 'claude'}).installedProviders,['claude']);
  assert.ok(prepareDashboardSkill(root,claudeInput,online).prompt);
});

test('requests stay text and reject control sequences, unknown IDs and unsupported models',t => {
  const {root,folder} = fixture(t),result = register(root,skillAt(path.join(folder,'skill')));
  const input = {skill:result.registeredId,request:'',selection};
  assert.match(prepareDashboardSkill(root,input,online).prompt,/Ask me what you need/);
  assert.throws(() => prepareDashboardSkill(root,{...input,skill:'plan-today'},online),/registered installed/);
  assert.throws(() => prepareDashboardSkill(root,{...input,request:'x'.repeat(6001)},online),/6000/);
  assert.throws(() => prepareDashboardSkill(root,{...input,request:'escape\x1b[1m'},online),/6000/);
  assert.throws(() => prepareDashboardSkill(root,{...input,selection:{provider:'codex',model:'fake'}},online),/Unsupported/);
  const text = 'Literal `command` and $(command); never shell-interpolate this';
  assert.ok(prepareDashboardSkill(root,{...input,request:text},online).prompt.includes(text));
});

test('discovery reads only SKILL.md in the requested provider conventional roots',t => {
  const {root,home} = fixture(t);
  skillAt(path.join(home,'.claude','skills','claude-helper'),'Claude helper');
  skillAt(path.join(home,'.agents','skills','codex-helper'),'Codex helper');
  skillAt(path.join(root,'.agents','skills','local-helper'),'Local helper');
  fs.writeFileSync(path.join(home,'.agents','skills','do-not-read.txt'),'unrelated data');
  const claude = discoverDashboardSkills(root,{provider:'claude',home});
  assert.deepEqual(claude.skills.map(skill => skill.label),['Claude helper']);
  const codex = discoverDashboardSkills(root,{provider:'codex',home});
  assert.deepEqual(codex.skills.map(skill => skill.label),['Codex helper','Local helper']);
  assert.ok(codex.skills.every(skill => skill.providers.join(',') === 'codex'));
  assert.equal(view(root).revision,'missing');assert.throws(() => discoverDashboardSkills(root,{provider:'fake',home}),/supported providers/);
});

test('discovery stops at a skill root and reports invalid files and bounded traversal',t => {
  const {root,folder} = fixture(t),base = path.join(folder,'installed');
  skillAt(path.join(base,'one'),'One');skillAt(path.join(base,'one','helpers','nested'),'Do not discover');
  fs.mkdirSync(path.join(base,'invalid'));fs.writeFileSync(path.join(base,'invalid','SKILL.md'),'invalid');
  skillAt(path.join(base,'a','b','c','d','e','deep'),'Too deep');
  const result = discoverDashboardSkills(root,{provider:'codex',skillRoots:[base]});
  assert.deepEqual(result.skills.map(skill => skill.label),['One']);assert.equal(result.skipped,1);assert.equal(result.truncated,true);
});

test('symlinked configuration directories cannot redirect writes outside the vault',t => {
  const {root,folder} = fixture(t),outside = path.join(folder,'outside');fs.mkdirSync(outside);
  try {fs.symlinkSync(outside,path.join(root,'system'),process.platform === 'win32' ? 'junction' : 'dir');} catch (error) {if (['EPERM','EACCES'].includes(error.code)) {t.skip('This environment cannot create directory links.');return;}throw error;}
  assert.match(view(root).error,/Linked/);
  assert.throws(() => saveDashboard(root,{revision:'missing',selected:[]},online),/Linked/);
  assert.deepEqual(fs.readdirSync(outside),[]);
});

test('linked skill folders are never registered or traversed',t => {
  const {root,folder} = fixture(t),target = path.join(folder,'target');skillAt(target);
  const base = path.join(folder,'skills');fs.mkdirSync(base);
  const link = path.join(base,'linked');
  try {fs.symlinkSync(target,link,process.platform === 'win32' ? 'junction' : 'dir');} catch (error) {if (['EPERM','EACCES'].includes(error.code)) {t.skip('This environment cannot create directory links.');return;}throw error;}
  assert.throws(() => register(root,path.join(link,'SKILL.md')),/Linked/);
  const result = discoverDashboardSkills(root,{provider:'codex',skillRoots:[base]});
  assert.equal(result.skills.length,0);assert.equal(result.skipped,1);
});

test('oversize files and hardlinks cannot enter the registry',t => {
  const {root,folder} = fixture(t),file = skillAt(path.join(folder,'skill'));
  fs.appendFileSync(file,'x'.repeat(129*1024));assert.throws(() => register(root,file),/size/);
  const original = skillAt(path.join(folder,'original')),linkedFolder = path.join(folder,'hardlinked');fs.mkdirSync(linkedFolder);
  fs.linkSync(original,path.join(linkedFolder,'SKILL.md'));
  assert.throws(() => register(root,path.join(linkedFolder,'SKILL.md')),/regular file/);
});

test('save lock refuses concurrent writers without deleting their lock',t => {
  const {root,config} = fixture(t);fs.mkdirSync(path.dirname(config),{recursive:true});fs.writeFileSync(config+'.lock','another writer');
  assert.throws(() => saveDashboard(root,{revision:'missing',selected:[]},online),/being saved/);
  assert.equal(fs.readFileSync(config+'.lock','utf8'),'another writer');assert.equal(fs.existsSync(config),false);
});

test('installed-skill retries require the same model, provider, prompt and app scope',() => {
  const prepared = {prompt:'Use the registered skill.',selection},existing = {provider:selection.provider,model:selection.model,prompt:prepared.prompt};
  assert.doesNotThrow(() => assertDashboardReplay(undefined,prepared,'web'));
  assert.doesNotThrow(() => assertDashboardReplay(existing,prepared,'web'));
  assert.throws(() => assertDashboardReplay(existing,{...prepared,selection:{...selection,model:'gpt-5.6-luna'}},'web'),/different model/);
  assert.throws(() => assertDashboardReplay({...existing,provider:'claude'},prepared,'web'),/different request/);
  assert.throws(() => assertDashboardReplay(existing,{...prepared,prompt:'Different task'},'web'),/different request/);
  assert.throws(() => assertDashboardReplay(existing,prepared,'native'),/different request or app/);
  const native = {...existing,execution:'native'};
  assert.doesNotThrow(() => assertDashboardReplay(native,prepared,'native'));
  assert.throws(() => assertDashboardReplay(native,prepared,'web'),/different request or app/);
  for (const execution of ['headless','script']) assert.throws(() => assertDashboardReplay({...existing,execution},prepared,'web'),/different request/);
});
