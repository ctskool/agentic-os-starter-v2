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

test('a Mac capture request selects one background native surface without retaining a remote transcript owner',()=>{
 const emitted=[],saved=[],hub=new VoiceHub({emit:e=>emitted.push(e),save:v=>saved.push(v)});
 hub.presence({id:'native',kind:'native',visible:false,mode:'idle'});
 hub.presence({id:'web',kind:'web',visible:true,mode:'idle'});
 hub.capture({type:'wake'});assert.equal(hub.captureOwner,'native');emitted.length=0;
 hub.capture({type:'capture-request',client:'foreign',text:'Private request',extra:{secret:true}});
 assert.deepEqual(emitted,[{type:'owner',id:'native'},{type:'capture-request',client:'native'}]);
 assert.equal(hub.owner,'native');assert.equal(hub.captureOwner,null);
 assert.deepEqual(hub.captureDiagnostics().at(-1),{at:hub.captureDiagnostics().at(-1).at,type:'capture-request',client:'native',kind:'native'});
 const count=emitted.length;hub.capture({type:'transcript',text:'Stale remote transcript'});assert.equal(emitted.length,count);
 assert.doesNotMatch(JSON.stringify(hub.captureDiagnostics()),/Private|foreign|secret|Stale/);assert.equal(saved.length,0);
});

test('a Mac capture request respects the selected visible HUD and never targets hidden or disconnected web surfaces',()=>{
 const events=[],hub=new VoiceHub({emit:e=>events.push(e)});
 hub.presence({id:'native',kind:'native',visible:false,mode:'idle'});
 hub.presence({id:'web',kind:'web',visible:true,mode:'idle',focus:true});events.length=0;
 hub.capture({type:'capture-request'});assert.equal(events.at(-1).client,'web');
 hub.leave('web');hub.capture({type:'capture-request'});assert.equal(events.at(-1).client,'native');
 hub.leave('native');hub.presence({id:'hidden',kind:'web',visible:false,mode:'idle'});const count=events.length;
 hub.capture({type:'capture-request'});assert.equal(events.length,count);assert.equal(hub.captureDiagnostics().at(-1).client,null);
 for(const event of [null,undefined,'capture-request',{}, {type:'unknown'}])hub.capture(event);
 assert.equal(events.length,count);assert.equal(hub.captureOwner,null);
});
