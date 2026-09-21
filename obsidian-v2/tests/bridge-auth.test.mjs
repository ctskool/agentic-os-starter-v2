import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createBridgeAuth,readBridgeToken,acceptsBridgeToken} from '../runner/bridge-auth.mjs';
import {allowsAuthBootstrap} from '../shared/auth-origin.mjs';

test('bridge writes require the current boot credential and old credentials cannot be replayed',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v2-bridge-auth-'));
 try{
  assert.throws(()=>readBridgeToken(dir),/authentication is unavailable/);
  assert.deepEqual(fs.readdirSync(dir),[], 'a client must never create a credential');
  const first=createBridgeAuth(dir),headers={'x-v2-token':first.token};
  assert.equal(readBridgeToken(dir),first.token);
  for(const method of ['POST','DELETE','PUT','PATCH']){
   assert.equal(first.accepts(method,{}),false);
   assert.equal(first.accepts(method,{'x-v2-token':'wrong'}),false);
   assert.equal(first.accepts(method,{'x-v2-token':[first.token,first.token]}),false);
   assert.equal(first.accepts(method,headers),true);
  }
  for(const method of ['GET','HEAD','OPTIONS'])assert.equal(first.accepts(method,{}),true);
  const second=createBridgeAuth(dir);
  assert.notEqual(second.token,first.token);
  assert.equal(second.accepts('POST',headers),false);
  assert.equal(second.accepts('POST',{'x-v2-token':second.token}),true);
  assert.equal(acceptsBridgeToken('POST',new Headers({'X-V2-Token':second.token}),second.token),true);
  fs.writeFileSync(second.file,'{}');
  assert.throws(()=>readBridgeToken(dir),/authentication is unavailable/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('browser credential bootstrap rejects hostile origin, forged host, cross-site and context-free requests',()=>{
 for(const port of [3217,3218]){
  const url=`http://127.0.0.1:${port}/bridge-auth`;
  const allowed=headers=>allowsAuthBootstrap(new Request(url,{headers}),port);
  assert.equal(allowed({'sec-fetch-site':'same-origin'}),true);
  assert.equal(allowed({origin:`http://127.0.0.1:${port}`}),true);
  assert.equal(allowed({}),false);
  assert.equal(allowed({origin:'https://evil.example'}),false);
  assert.equal(allowed({origin:'null'}),false);
  assert.equal(allowed({'sec-fetch-site':'cross-site'}),false);
  assert.equal(allowed({'sec-fetch-site':'same-site'}),false);
  assert.equal(allowed({'sec-fetch-site':'same-origin',host:`evil.example:${port}`}),false);
  assert.equal(allowed({'sec-fetch-site':'same-origin',origin:'https://evil.example'}),false);
  assert.equal(allowsAuthBootstrap(new Request(url,{method:'POST',headers:{origin:`http://127.0.0.1:${port}`}}),port),false);
 }
});
