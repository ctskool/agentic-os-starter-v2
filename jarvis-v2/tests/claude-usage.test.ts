import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {getClaudeUsage} from '../lib/claudeUsage';

test('Claude quota shares requests, preserves freshness on failure, and clears a changed or missing sign-in',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'jarvis-usage-test-'));
 const oldConfig=process.env.CLAUDE_CONFIG_DIR;
 process.env.CLAUDE_CONFIG_DIR=dir;
 let now=Date.now(),calls=0,mode:'ok'|'offline'|'denied'='ok';
 t.mock.method(Date,'now',()=>now);
 t.mock.method(globalThis,'fetch',async(url:unknown,options:any)=>{
  calls++;assert.equal(url,'https://api.anthropic.com/api/oauth/usage');assert.equal(options.redirect,'error');
  if(mode==='offline')throw new Error('Network down');
  if(mode==='denied')return new Response('{}',{status:401});
  return Response.json({five_hour:{utilization:2,resets_at:'2026-09-11T18:00:00Z'},seven_day:{utilization:0,resets_at:null}});
 });
 try{
  await writeFile(path.join(dir,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'fake-test-account-a'}}));
  const [first,second]=await Promise.all([getClaudeUsage(),getClaudeUsage()]);
  assert.equal(calls,1);assert.deepEqual(first,second);assert.equal(first.status,'ok');
  assert.equal(JSON.stringify(first).includes('fake-test-account'),false);
  await getClaudeUsage();assert.equal(calls,1);
  mode='offline';now+=120001;
  const stale=await getClaudeUsage();assert.equal(stale.status,'stale');assert.equal(stale.checkedAt,first.checkedAt);assert.deepEqual(stale.windows,first.windows);
  await writeFile(path.join(dir,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'fake-test-account-b'}}));
  mode='denied';
  const denied=await getClaudeUsage();assert.equal(denied.status,'unavailable');assert.deepEqual(denied.windows,[]);
  await rm(path.join(dir,'.credentials.json'));
  const absent=await getClaudeUsage();assert.equal(absent.status,'unavailable');assert.equal(absent.checkedAt,null);assert.deepEqual(absent.windows,[]);
 }finally{
  if(oldConfig===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=oldConfig;
  await rm(dir,{recursive:true,force:true});
 }
});
