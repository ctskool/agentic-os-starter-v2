import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {classifyVoice} from '../runner/voice-router.mjs';
import {localDate} from '../runner/brief-voice.mjs';

test('a known brief question reads only the brief, without voice memory or dashboard scanning',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-brief-fast-'));
 const directory=path.join(root,'inbox/research/morning-intel');fs.mkdirSync(directory,{recursive:true});
 fs.writeFileSync(path.join(directory,`${localDate()}-intel.md`),'## Top Story\nA verified fixture headline.');
 const originals=Object.fromEntries(['readFileSync','readdirSync','statSync','existsSync'].map(name=>[name,fs[name]]));
 t.after(()=>{Object.assign(fs,originals);fs.rmSync(root,{recursive:true,force:true})});
 const reads=[];
 for(const [name,fn] of Object.entries(originals))fs[name]=function(file,...args){
  const relative=typeof file==='string'?path.relative(root,file).replaceAll('\\','/'):'';
  reads.push(relative);
  assert.doesNotMatch(relative,/^(?:system|daily-notes)(?:\/|$)/,'saved news must not load unrelated vault state');
  return fn.call(this,file,...args);
 };
 for(const provider of ['codex','claude']){
  const result=await classifyVoice(root,{id:'isolated-fast-read',transcript:'What is the biggest AI story today?',chosen:{provider,model:provider==='codex'?'gpt-6-astra':'sonnet'},workTarget:'a-stopped-conversation',terminals:{list(){assert.fail('No terminal snapshot')},get(){assert.fail('No selected-terminal read')}},execute:()=>assert.fail('No model')});
  assert.equal(result.engine,'rules');assert.match(result.reply,/verified fixture headline/);
 }
 assert.ok(reads.some(file=>file.endsWith('-intel.md')));
 assert.ok(reads.every(file=>!/^(?:system|daily-notes)(?:\/|$)/.test(file)),'even swallowed read errors must not hide unrelated scanning');
});
