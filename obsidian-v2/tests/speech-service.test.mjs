import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveSpeechService} from '../runner/speech-service.mjs';
test('bridge restart reuses healthy local speech without creating another service',async()=>{
 const calls=[];
 assert.equal(await resolveSpeechService(null,async url=>{calls.push(url);return {ok:true,json:async()=>({ok:true,stt:{ok:true}})}}),'http://127.0.0.1:3108');
 assert.equal(calls.length,1);
 assert.equal(await resolveSpeechService(null,async url=>{if(url.includes('3108'))throw new Error('offline');return {ok:true,json:async()=>({ok:true,stt:{ok:true}})}}),'http://127.0.0.1:3220');
 await assert.rejects(resolveSpeechService('https://example.com',()=>assert.fail('Must not contact external speech')),/local/);
 assert.equal(await resolveSpeechService('http://127.0.0.1:3220',()=>assert.fail('Honor explicit local configuration')),'http://127.0.0.1:3220');
});
