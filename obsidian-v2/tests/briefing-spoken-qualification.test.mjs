import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createJiti} from 'jiti';
import {withVoiceContext} from '../runner/voice-context.mjs';
const jiti=createJiti(import.meta.url);
const {readMorningReport}=await jiti.import('../runner/voice-vault.ts');
const {rulesRoute}=await jiti.import('../runner/voice-rules.ts');
const {speechText}=await jiti.import('../shared/speech-text.ts');
const state={metrics:[],runner:null,daily:null,morning:null,latestVideo:null,outliers:null,trendingRepos:[],queue:[],runs:[],etas:{}};

function fixture(t,headlines){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'briefing-qualification-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago'}).format(new Date());
 const directory=path.join(root,'inbox/research/morning-intel');fs.mkdirSync(directory,{recursive:true});
 const file=path.join(directory,`${date}-intel.md`),raw='## TL;DR\n'+headlines.map(head=>'- '+head).join('\n')+'\n\n## Details\nFull report stays intact.\n';
 fs.writeFileSync(file,raw);
 return {root,file,raw};
}

for(const [name,headline,caveat] of [
 ['comma','Researchers announced that the historical cipher was solved, but independent verification is still missing.','but independent verification is still missing'],
 ['parenthetical','Researchers announced a proposed cipher solution (not independently verified).','not independently verified'],
 ['long headline','Researchers announced a detailed solution covering the original historical cipher and its references to the source book, the sequence of indexed words, the chosen letters and their resulting message, but the claimed attribution remains disputed.','but the claimed attribution remains disputed'],
 ['em dash','Researchers announced a solution to the historic cipher — however, the original evidence is still unverified.','however, the original evidence is still unverified'],
])test(`morning briefing retains its ${name} qualification before and after speech formatting`,t=>{
 const f=fixture(t,[headline]);
 withVoiceContext({root:f.root,exchanges:[]},()=>{
  const report=readMorningReport();assert.equal(report.heads[0],headline);
  const reply=rulesRoute('Brief me',state);assert.equal(reply.engine,'rules');assert.ok(reply.reply.includes(caveat),reply.reply);
  const spoken=speechText(reply.reply);assert.ok(spoken.includes(caveat)||spoken==='The full answer is in the written reply.',spoken);
 });
 assert.equal(fs.readFileSync(f.file,'utf8'),f.raw);
});

test('headlines remain item-bounded and an oversized source gets a whole neutral pointer instead of an unqualified prefix',t=>{
 const head='Researchers announced a confirmed result '+ 'with detailed source references '.repeat(100)+', but it is not independently verified.';
 const f=fixture(t,[head,'A second story.','A third story.']);
 withVoiceContext({root:f.root,exchanges:[]},()=>{
  const report=readMorningReport(2);assert.equal(report.heads.length,2);assert.equal(report.links.length,2);
  assert.match(report.heads[0],/cannot.*reliably/);assert.doesNotMatch(report.heads[0],/confirmed result/);assert.ok(report.heads[0].length<200);
  const reply=rulesRoute('Brief me',state),spoken=speechText(reply.reply);
  assert.doesNotMatch(reply.reply,/confirmed result/);assert.doesNotMatch(spoken,/confirmed result/);assert.match(spoken,/morning report|written reply/);
 });
 assert.equal(fs.readFileSync(f.file,'utf8'),f.raw);
});
