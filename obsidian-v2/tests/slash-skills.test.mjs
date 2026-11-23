import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {routeVoice} from '../runner/bridge-core.mjs';
import {skillExists,spokenSlashSkill} from '../runner/slash-skills.mjs';
import {terminalSpec} from '../runner/terminals.mjs';

test('spoken slash forms resolve their installed spelling and preserve arguments',()=>{
 const parse=(text,...names)=>spokenSlashSkill(text,{hasSkill:name=>names.includes(name)});
 for(const phrase of ['slash today','/today','run the today slash command',"can't you run the daily note, the slash today thing"])
  assert.deepEqual(parse(phrase,'today'),{name:'today',args:'',found:true});
 assert.deepEqual(parse('run slash plan-tomorrow for next week','plan-tomorrow'),{name:'plan-tomorrow',args:'for next week',found:true});
 assert.deepEqual(parse('slash plan tomorrow for next week','plan-tomorrow','plantomorrow'),{name:'plan-tomorrow',args:'for next week',found:true});
 assert.deepEqual(parse('slash plan tomorrow for next week','plantomorrow'),{name:'plantomorrow',args:'for next week',found:true});
 assert.deepEqual(parse('/today use Sonnet'),{name:'today',args:'use Sonnet',found:false});
 assert.equal(parse('Can you slash the prices by ten percent?','today'),null);
 assert.equal(parse('Slash prices by ten percent','today'),null);
});

test('natural speech resolves slash skills without passing asides or politeness as arguments',()=>{
 const installed=['today','morning-intel','close-day','yt-package'];
 const parse=text=>spokenSlashSkill(text,{hasSkill:name=>installed.includes(name)});
 for(const [phrase,name,args] of [
  ["Um, can't you run the uh, the daily note, the slash today thing",'today',''],
  ['uh run slash today please','today',''],
  ['okay, jarvis, run the slash morning intel','morning-intel',''],
  ['Can you run slash close day for me','close-day',''],
  ['run slash yt package for the new video','yt-package','for the new video'],
  ['Please run the note, the morning one, the slash today thing','today',''],
  ['umm, uhh erm hmm like, you know, so, ok, hey, slash today real quick now','today',''],
  ['run slash yt package for me and my team, please','yt-package','for me and my team']
 ])assert.deepEqual(parse(phrase),{name,args,found:true},phrase);
 assert.deepEqual(parse('slash absent please'),{name:'absent',args:'',found:false});
 for(const phrase of [
  'What does a forward slash mean in a URL?',
  'I cut the price by a slash today',
  "Um, what's on my schedule today",
  'Run the note. Later, the slash today thing'
 ])assert.equal(parse(phrase),null,phrase);
});

test('provider-specific existence checks and route hand the exact command to a new terminal',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'slash-route-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const home=path.join(root,'home'),codexHome=path.join(root,'override');
 for(const file of ['.claude/commands/today.md','home/.claude/skills/plan-tomorrow/SKILL.md','override/skills/today/SKILL.md',
  'home/.agents/skills/another/SKILL.md','override/prompts/legacy.md']){
  const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'Fixture skill; contents must stay out of the bridge prompt.');
 }
 const hasSkill=(provider,vault,name)=>skillExists(provider,vault,name,{home,codexHome});
 assert.ok(hasSkill('claude',root,'plan-tomorrow'));
 assert.ok(hasSkill('codex',root,'another'));
 assert.ok(hasSkill('codex',root,'legacy'));
 assert.equal(hasSkill('codex',root,'plan-tomorrow'),false);
 assert.equal(hasSkill('claude',root,'../home'),false);
 for(const selection of [{provider:'claude',model:'sonnet'},{provider:'codex',model:'astra'}]){
  const starts=[],selected={id:randomUUID(),...selection,title:'Existing work',state:'ready',turns:[]};
  const terminals={get:id=>id===selected.id?selected:null,list:()=>[selected],start:job=>(starts.push(job),job),send:()=>assert.fail('must start a fresh task')};
  const execute=()=>assert.fail('no classifier');
  const request=transcript=>({id:randomUUID(),transcript,selection,terminalMode:true,workTarget:selected.id});
  const options={hasSkill,resolveCli:()=>true};
  const result=await routeVoice(root,request('/today use Sonnet'),null,execute,terminals,options);
  assert.equal(result.workTarget,null);
  assert.deepEqual(result.workIds,[starts[0].id]);
  assert.equal(starts[0].prompt,'/today use Sonnet');
  const spec=terminalSpec(root,{...starts[0],...starts[0].selection,sessionId:null},{command:'fixture',prefix:[]});
  assert.equal(spec.args.at(-1),'/today use Sonnet');
  const missing=await routeVoice(root,request('slash absent'),null,execute,terminals,options);
  assert.equal(missing.reply,"I don't see a /absent skill in "+(selection.provider==='claude'?'Claude Code':'Codex')+'.');
  assert.equal(starts.length,1);
 }
});
