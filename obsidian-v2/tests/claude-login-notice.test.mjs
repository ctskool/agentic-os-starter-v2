import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readLoginDeadline,claudeLoginNotice,claudeUsageReading,credentialsFile,LOGIN_NOTICE_MS} from '../runner/claude-login.mjs';

const SECRET='sentinel-token-text-must-never-appear';
const HOUR=3600000;

async function tempFile(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aos-login-notice-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 return path.join(dir,'.credentials.json');
}
const save=(file,value)=>fs.writeFile(file,typeof value==='string'?value:JSON.stringify(value));

test('the login deadline is read only from a usable saved login',async t=>{
 const file=await tempFile(t);
 assert.equal(await readLoginDeadline(file),null,'missing file');
 await save(file,`{"claudeAiOauth":{"accessToken":"${SECRET}",`);
 assert.equal(await readLoginDeadline(file),null,'malformed file');
 await save(file,{claudeAiOauth:{refreshTokenExpiresAt:Date.now()+HOUR}});
 assert.equal(await readLoginDeadline(file),null,'no access token');
 for(const deadline of [undefined,null,'1790000000000',Number.NaN,-5,0]){
  await save(file,{claudeAiOauth:{accessToken:SECRET,refreshTokenExpiresAt:deadline}});
  assert.equal(await readLoginDeadline(file),null,`deadline ${String(deadline)}`);
 }
 await save(file,{claudeAiOauth:{accessToken:SECRET,refreshToken:SECRET,expiresAt:1790000000000,refreshTokenExpiresAt:1789999000000}});
 assert.equal(await readLoginDeadline(file),1789999000000);
 await save(file,JSON.stringify({claudeAiOauth:{accessToken:SECRET,refreshTokenExpiresAt:1789999000000},padding:'x'.repeat(70*1024)}));
 assert.equal(await readLoginDeadline(file),null,'oversized file is not parsed');
});

test('the notice appears a day ahead and names the fix',async t=>{
 const now=1790000000000,at=deadline=>claudeLoginNotice({now:()=>now,read:async()=>deadline});
 assert.equal(await at(now+LOGIN_NOTICE_MS+1),undefined);
 assert.deepEqual(await at(now+LOGIN_NOTICE_MS),{level:'soon',text:'Claude Code login expires in 24 hours. Open a terminal, run claude, then type /login.'});
 assert.match((await at(now+5.5*HOUR)).text,/expires in 6 hours/);
 assert.match((await at(now+HOUR)).text,/expires within the hour/);
 assert.match((await at(now+1)).text,/expires within the hour/);
 assert.deepEqual(await at(now),{level:'expired',text:'Claude Code login has expired. Open a terminal, run claude, then type /login.'});
 assert.equal((await at(now-3*24*HOUR)).level,'expired');
 assert.equal(await at(null),undefined);
});

test('the 2026-09-23 login shape reports an expired login without exposing the token',async t=>{
 const file=await tempFile(t);
 const expiresAt=Date.parse('2026-09-23T07:52:03.740Z'),renewalEnds=Date.parse('2026-09-23T02:27:32.740Z');
 await save(file,{claudeAiOauth:{accessToken:SECRET,refreshToken:SECRET,expiresAt,refreshTokenExpiresAt:renewalEnds,subscriptionType:'max'}});
 const notice=await claudeLoginNotice({env:{CLAUDE_CONFIG_DIR:path.dirname(file)},now:()=>Date.parse('2026-09-23T14:48:11Z')});
 assert.equal(notice.level,'expired');
 assert.equal(JSON.stringify(notice).includes(SECRET),false);
 await save(file,`{"claudeAiOauth":{"accessToken":"${SECRET}"`);
 assert.equal(await claudeLoginNotice({env:{CLAUDE_CONFIG_DIR:path.dirname(file)}}),undefined,'a malformed file gives no notice and no error text');
});

test('a slow or failing read never delays or breaks the meter',async()=>{
 const started=Date.now();
 assert.equal(await claudeLoginNotice({read:()=>new Promise(()=>{}),timeoutMs:50}),undefined);
 assert.ok(Date.now()-started<1000);
 assert.equal(await claudeLoginNotice({read:async()=>{throw new Error(SECRET)}}),undefined);
 assert.equal(await claudeLoginNotice({read:()=>{throw new Error(SECRET)}}),undefined);
});

test('the credentials file follows CLAUDE_CONFIG_DIR, resolved on every call',()=>{
 assert.equal(credentialsFile({}),path.join(os.homedir(),'.claude','.credentials.json'));
 assert.equal(credentialsFile({CLAUDE_CONFIG_DIR:'relative-config'}),path.join(path.resolve('relative-config'),'.credentials.json'));
 const absolute=path.join(os.tmpdir(),'some-config');
 assert.equal(credentialsFile({CLAUDE_CONFIG_DIR:absolute}),path.join(absolute,'.credentials.json'));
});

test('the usage reading carries the notice in every state, looked up after the reading',async()=>{
 const order=[],notice={level:'soon',text:'Claude Code login expires in 3 hours. Open a terminal, run claude, then type /login.'};
 for(const status of ['ok','stale','unavailable']){
  const reading={status,checkedAt:null,windows:[],message:status==='ok'?undefined:'x'};
  const signal=new AbortController().signal;
  const result=await claudeUsageReading({signal,getUsage:async options=>{order.push('usage');assert.equal(options.signal,signal);return reading},notice:async()=>{order.push('notice');return notice}});
  assert.deepEqual(result,{...reading,notice});
 }
 assert.deepEqual(order,['usage','notice','usage','notice','usage','notice']);
 const plain={status:'ok',checkedAt:'t',windows:[]};
 assert.equal(await claudeUsageReading({getUsage:async()=>plain,notice:async()=>undefined}),plain);
});
