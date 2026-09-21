import test from 'node:test';
import assert from 'node:assert/strict';
import {createDashboardSkillsStore,dashboardDiscoveryNotice,dashboardEntries,dashboardIds,initialDashboard,launchInstalledSkill,moveDashboardSkill,skillUnavailable,toggleDashboardSkill,type DashboardSnapshot,type DashboardSkill} from '../lib/dashboard-skills';

const installed:DashboardSkill={id:'installed:abc',label:'Proposals',description:'Write a proposal',kind:'installed',providers:['claude'],available:true};
const data:DashboardSnapshot={...initialDashboard,revision:'one',configured:true,selected:['inbox-brief',installed.id,'plan-today'],catalog:[...initialDashboard.catalog,installed]};

test('saved dashboard order is shared, empty is deliberate, defaults remain available, and missing skills stay visible',()=>{
  assert.deepEqual(dashboardEntries(data).map(skill=>skill.id),data.selected);
  assert.deepEqual(dashboardIds({...data,selected:[]}),[]);
  assert.deepEqual(dashboardIds(initialDashboard),['plan-today','inbox-brief','deep-research-chase','content-cascade']);
  const missing=dashboardEntries({...data,catalog:initialDashboard.catalog})[1];assert.equal(missing.id,installed.id);assert.equal(missing.available,false);
  assert.match(skillUnavailable(missing,'claude'),/unavailable/);
  assert.match(skillUnavailable(installed,'claude',['codex']),/Claude Code is not installed/);
  assert.equal(skillUnavailable(initialDashboard.catalog.find(skill=>skill.id==='metrics-pull')!,'codex',[]),'','direct workflow does not require a coding CLI');
});

test('choosing and reordering shortcuts preserves all other choices and enforces ten',()=>{
  assert.deepEqual(moveDashboardSkill(['a','b','c'],'b',-1),['b','a','c']);
  assert.deepEqual(moveDashboardSkill(['a','b','c'],'a',-1),['a','b','c']);
  const ten=Array.from({length:10},(_,i)=>String(i));assert.throws(()=>toggleDashboardSkill(ten,'extra'),/up to 10/);
  assert.equal(toggleDashboardSkill(ten,'4').length,9);assert.equal(ten.length,10);
});

test('installed skill launches go only to the interactive launch route with the captured provider and request',async()=>{
  const calls:{path:string;body:any}[]=[];
  const send=async(path:string,body?:unknown)=>{calls.push({path,body});return {id:'task'}};
  await assert.rejects(launchInstalledSkill(installed,'write this',{provider:'codex',model:'gpt-6-astra'},send),/Claude Code/);
  await assert.rejects(launchInstalledSkill(installed,' ',{provider:'claude',model:'sonnet'},send),/Describe/);
  await assert.rejects(launchInstalledSkill({...installed,available:false,reason:'File missing'},'write this',{provider:'claude',model:'sonnet'},send),/File missing/);
  await assert.rejects(launchInstalledSkill(installed,'write this',{provider:'claude',model:'sonnet'},send,['codex']),/Claude Code is not installed/);
  assert.equal(calls.length,0);
  assert.deepEqual(await launchInstalledSkill(installed,'  write this  ',{provider:'claude',model:'sonnet',targetId:null},send),{id:'task'});
  assert.equal(calls[0].path,'/dashboard/launch');assert.equal(calls[0].body.request,'write this');assert.equal(calls[0].body.skill,installed.id);assert.equal(calls[0].body.selection.provider,'claude');assert.match(calls[0].body.id,/^[a-f0-9-]{36}$/);
});

test('a slow preference poll cannot undo a saved choice; unavailable bridge keeps saved buttons with an explicit error',async()=>{
  let resolve!:(value:DashboardSnapshot)=>void,fail=false;
  const saved={...data,revision:'two',selected:[]};
  const store=createDashboardSkillsStore(async(_path,body)=>{if(body)return saved;if(fail)throw new Error('Bridge unavailable');return new Promise(r=>{resolve=r})},()=>false);
  const poll=store.refresh();await Promise.resolve();await store.save('one',[]);resolve(data);await poll;
  assert.deepEqual(store.getSnapshot().data.selected,[]);assert.equal(store.getSnapshot().data.revision,'two');
  fail=true;await store.refresh();assert.equal(store.getSnapshot().error,'Bridge unavailable');assert.equal(store.getSnapshot().loaded,true);assert.deepEqual(store.getSnapshot().data.selected,[]);
});

test('save and registration keep optimistic revisions and never publish rejected writes',async()=>{
  const calls:{path:string;body:any}[]=[];
  const store=createDashboardSkillsStore(async(path,body)=>{calls.push({path,body});if(body)throw new Error('Dashboard changed elsewhere');return data},()=>false);
  await store.refresh();await assert.rejects(store.save('old',['plan-today']),/changed elsewhere/);
  await assert.rejects(store.register('old',{path:'C:\\skills\\proposal\\SKILL.md',providers:['claude']}),/changed elsewhere/);
  assert.equal(calls[1].body.revision,'old');assert.equal(calls[2].body.revision,'old');assert.equal(store.getSnapshot().data.revision,'one');
  assert.equal(calls[2].path,'/dashboard/register');
});

test('discovery is explicit and provider scoped; hidden pages skip polling',async()=>{
  const calls:string[]=[];
  const store=createDashboardSkillsStore(async path=>{calls.push(path);return {skills:[]}},()=>true);
  await store.refresh();assert.equal(calls.length,0);await store.discover('claude');assert.deepEqual(calls,['/dashboard/discover?provider=claude']);
  const notice=dashboardDiscoveryNotice({skills:[],skipped:3,truncated:true});assert.match(notice,/0 installed skills/);assert.match(notice,/3 unreadable, linked, or invalid locations skipped/);assert.match(notice,/search reached its limit/);
});
