import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceHub} from '../runner/voice-hub.mjs';

test('capture diagnostics distinguish speech timeout, delivery and a disconnected owner without saving content',()=>{
 let now=1;const emitted=[],saved=[],hub=new VoiceHub({now:()=>now,emit:e=>emitted.push(e),save:v=>saved.push(v)});
 hub.presence({id:'native',kind:'native',visible:true,mode:'idle'});
 hub.capture({type:'wake'});now=5;hub.capture({type:'wake_timeout'});
 hub.capture({type:'wake'});hub.capture({type:'transcript',text:'Private spoken request'});
 assert.deepEqual(hub.captureDiagnostics().map(e=>e.type),['wake','wake_timeout','wake','transcript']);
 assert.equal(hub.captureDiagnostics().at(-1).characters,22);assert.equal(emitted.at(-1).text,'Private spoken request');
 hub.capture({type:'wake'});hub.leave('native');const count=emitted.length;
 hub.capture({type:'transcript',text:'Never deliver this after disconnection'});
 assert.equal(emitted.length,count);assert.deepEqual(hub.captureDiagnostics().slice(-2).map(e=>[e.type,e.client]),[['surface-left','native'],['transcript',null]]);
 assert.doesNotMatch(JSON.stringify(hub.captureDiagnostics()),/Private|Never deliver/);assert.equal(saved.length,0);
});

test('capture metadata is bounded, detached and ignores arbitrary event fields',()=>{
 const hub=new VoiceHub();
 for(let i=0;i<30;i++)hub.capture({type:'wake_error',error:'Sensitive error path',transcript:'private',extra:{secret:true}});
 const records=hub.captureDiagnostics();assert.equal(records.length,12);records[0].type='tampered';records.length=0;
 assert.equal(hub.captureDiagnostics().length,12);assert.equal(hub.captureDiagnostics()[0].type,'wake_error');
 assert.doesNotMatch(JSON.stringify(hub.captureDiagnostics()),/Sensitive|private|secret|tampered/);
 hub.capture({type:'hello',text:'ignore'});assert.equal(hub.captureDiagnostics().at(-1).type,'wake_error');
});
