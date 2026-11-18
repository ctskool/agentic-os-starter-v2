import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

test('Claude usage distinguishes refreshable expiry, rejected auth, denied access and absent login without credential writes',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aos-usage-auth-')),file=path.join(dir,'.credentials.json'),old=process.env.CLAUDE_CONFIG_DIR;
 process.env.CLAUDE_CONFIG_DIR=dir;t.after(async()=>{if(old===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=old;await fs.rm(dir,{recursive:true,force:true})});
 let now=Date.now(),calls=0,status=200;t.mock.method(Date,'now',()=>now);
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls++;assert.equal(url,'https://api.anthropic.com/api/oauth/usage');assert.equal(options.redirect,'error');assert.equal(options.method,undefined);return status===200?Response.json({seven_day:{utilization:23,resets_at:null}}):new Response('{}',{status})});
 const {getClaudeUsage}=await import('../runner/claudeUsage.mjs?auth-test='+crypto.randomUUID());
 const write=async auth=>{const bytes=JSON.stringify({claudeAiOauth:auth});await fs.writeFile(file,bytes);return bytes};
 const expired={accessToken:'fake-expired-access',expiresAt:now-1,refreshToken:'fake-refresh'};
 let before=await write(expired),result=await getClaudeUsage();assert.equal(result.status,'unavailable');assert.deepEqual(result.windows,[]);assert.match(result.message,/refresh its sign-in/);assert.doesNotMatch(result.message,/sign in again/);assert.equal(calls,0);assert.equal(await fs.readFile(file,'utf8'),before);
 before=await write({...expired,accessToken:'fake-renewed-access',expiresAt:now+100000});result=await getClaudeUsage();assert.equal(result.status,'ok');assert.equal(result.windows[0].usedPercent,23);assert.equal(calls,1);assert.equal(await fs.readFile(file,'utf8'),before);
 now+=100001;result=await getClaudeUsage();assert.equal(result.status,'unavailable');assert.match(result.message,/refresh its sign-in/);assert.equal(calls,1,'expired cached token must not call usage or refresh endpoints');
 await write({...expired,refreshTokenExpiresAt:now-1});result=await getClaudeUsage();assert.match(result.message,/sign in again/);assert.equal(calls,1);
 status=401;await write({accessToken:'fake-rejected-access',refreshToken:'fake-refresh'});result=await getClaudeUsage();assert.match(result.message,/refresh its sign-in/);
 await write({accessToken:'fake-rejected-without-refresh'});result=await getClaudeUsage();assert.match(result.message,/sign in again/);
 status=403;await write({accessToken:'fake-forbidden',refreshToken:'fake-refresh'});result=await getClaudeUsage();assert.match(result.message,/denied access/);assert.doesNotMatch(result.message,/expired|sign in again/);
 await fs.unlink(file);const count=calls;result=await getClaudeUsage({platform:'win32'});assert.match(result.message,/Sign in to Claude Code/);assert.equal(calls,count);assert.equal(JSON.stringify(result).includes('fake-'),false);
});

// Member report: on a Mac the meter said only 'Unavailable'. The sign-in is in the Keychain, which this reader never opens.
test('a Mac with no credentials file is told the sign-in is in the Keychain; a present-but-unusable file is not',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aos-usage-keychain-')),file=path.join(dir,'.credentials.json'),old=process.env.CLAUDE_CONFIG_DIR;
 process.env.CLAUDE_CONFIG_DIR=dir;t.after(async()=>{if(old===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=old;await fs.rm(dir,{recursive:true,force:true})});
 t.mock.method(globalThis,'fetch',async()=>assert.fail('no sign-in means no request'));
 const {getClaudeUsage,KEYCHAIN_MESSAGE}=await import('../runner/claudeUsage.mjs?keychain-test='+crypto.randomUUID());
 let result=await getClaudeUsage({platform:'darwin'});assert.equal(result.status,'unavailable');assert.equal(result.message,KEYCHAIN_MESSAGE);assert.match(result.message,/Keychain/);assert.ok(result.message.includes(String.fromCharCode(47)+'usage'));
 result=await getClaudeUsage({platform:'win32'});assert.match(result.message,/Sign in to Claude Code/);
 result=await getClaudeUsage({platform:'linux'});assert.match(result.message,/Sign in to Claude Code/);
 await fs.writeFile(file,'{}');result=await getClaudeUsage({platform:'darwin'});assert.match(result.message,/Sign in to Claude Code/,'a file that exists but holds no sign-in is a signed-out Mac, not a Keychain one');
});
