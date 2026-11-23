// Only End call ends a Live call (Chase, 2026-11-22). These pin the window-side paths that used to hang up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=path=>fs.readFileSync(new URL(path,import.meta.url),'utf8');

test('Escape never ends a Live call in either app; it still stops Local voice',()=>{
 const hud=read('../../jarvis-v2/components/HUD.tsx'),orb=read('../src/components/OrbFloat.tsx');
 for(const source of [hud,orb])assert.doesNotMatch(source,/escapeLive|escapeHangsUp/);
 assert.match(hud,/if \(voice\.stop\('local-only'\)\) pushLine\("sys", "voice — stopped"\);/);
});

test('choosing a terminal tab in the web app keeps a Live call up; only Local voice stops',()=>{
 assert.match(read('../../jarvis-v2/lib/useAgentWork.ts'),/const select=async\(id:string\|null\)=>\{\s*const request=\+\+selecting\.current;voice\.stop\('target-change'\)/);
 const client=read('../../jarvis-v2/lib/voiceClient.ts');
 assert.match(client,/const keepLive=reason==='provider-change'\|\|reason==='target-change'\|\|reason==='local-only';/);
 assert.match(client,/const stoppedLive=keepLive\?false:live\?\.stop\(\)/);
});

test('both apps label the only hang-up control End call',()=>{
 for(const path of ['../../jarvis-v2/components/LiveVoiceControls.tsx','../src/components/LiveVoiceControls.tsx']){
  const source=read(path);assert.match(source,/>End call<\/button>/,path);assert.doesNotMatch(source,/Hang up/,path);
 }
});
