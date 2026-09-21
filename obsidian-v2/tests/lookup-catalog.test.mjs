import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {inspectLocalLookup,answerLocalLookup,getLookupContext,getLocalCatalog,clearLookupCache} from '../runner/lookup-catalog.mjs';

const now=new Date('2026-09-12T18:00:00Z');
const daily='## Top 3 Priorities\n1. [ ] Prepare the talk\n2. [x] Review the diagrams\n3. [ ] Record the walkthrough\n## Schedule\n- 14:30 — Talk rehearsal\n## Current Focus\nFinish the dashboard\n';
const csv=(value=42,status='ok',date=now.toISOString())=>`timestamp,source,metric,value,status,error\n${date},youtube,subscribers,${value},${status},\n${date},youtube,views_28d,123456,ok,\n${date},instagram,followers,0,ok,\n`;
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'v2-lookup-catalog-')));
 t.after(()=>{clearLookupCache(root);fs.rmSync(root,{recursive:true,force:true})});
 const write=(relative,text)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof text==='string'?text:JSON.stringify(text));return file};
 return {root,write,answer:text=>answerLocalLookup(root,inspectLocalLookup(text),{now})};
}

test('ordinary conversational source and field variations are direct lookups',()=>{
 const cases=[
  ["Hey, could you quickly tell me what my priorities are for today?",'daily','priorities'],
  ["Remind me what is on the calendar for today.",'daily','schedule'],
  ["What am I focusing on today?",'daily','focus'],
  ["What is still on my plate today?",'daily',null],
  ["How many people are subscribed to my YouTube channel?",'metrics',null],
  ["What is my Instagram follower count?",'metrics',null],
  ["What's my YouTube view count for the past 28 days?",'metrics',null],
  ["What are the views on my latest video?",'latest-upload','views'],
  ["How is my latest upload doing?",'latest-upload','overview'],
  ["Which recent reports are available?",'reports','list'],
 ];
 for(const [text,source,field] of cases){const r=inspectLocalLookup(text);assert.equal(r.kind,'lookup',text);assert.equal(r.source,source,text);if(field)assert.equal(r.field,field,text)}
});

test('every unknown detail, time window, negation and extra action is preserved',()=>{
 for(const text of [
  'How much did my subscribers grow this week?',
  'How many total lifetime YouTube views do I have?',
  'How are my Instagram likes doing?',
  'What is the revenue for my latest upload?',
  'What was in the saved report?',
  'Read the report about navigation',
  'What are my high risk priorities?',
  'How is my latest upload compared with the previous one?',
 ])assert.equal(inspectLocalLookup(text).kind,'ambiguous',text);
 for(const text of [
  "Don't show my priorities",'Show my priorities excluding the launch',
  'What were my priorities yesterday?', 'Show my subscribers and make a chart',
  'How many subscribers do I have and how is the news?',
  'Tell me my focus then write a report',
 ]){const r=inspectLocalLookup(text);assert.equal(r.kind,'outside',text);assert.equal(r.guarded,true,text)}
 assert.equal(inspectLocalLookup('What is Codex weekly usage?').kind,'outside');
 for(const text of ['Check off priority two','Uncheck priority two','Open my daily note','Open my calendar on the right','Pull metrics']){
  const r=inspectLocalLookup(text);assert.equal(r.kind,'outside',text);assert.notEqual(r.guarded,true,text);
 }
});

test('daily lookup uses only the relevant note, answers flags, and observes edits and date rollover',t=>{
 const f=fixture(t),file=f.write('daily-notes/2026-09-12.md',daily);
 f.write('daily-notes/2026-09-13.md',daily.replace('Prepare the talk','Plan the next recording'));
 f.write('system/metrics/metrics.csv','private unrelated source');
 const read=fs.readFileSync,reads=[];fs.readFileSync=function(file,...args){reads.push(String(file));return read.call(this,file,...args)};
 try{
  const first=f.answer('What are my priorities for today?');assert.match(first.reply,/Prepare the talk/);assert.equal(first.deliverable,'daily-notes/2026-09-12.md');
  const cachedCount=reads.length;f.answer('What am I focusing on today?');assert.equal(reads.length,cachedCount);
  assert.match(f.answer('Did I finish priority two?').reply,/checked off/);
  assert.match(f.answer('Did I finish priority one?').reply,/not checked off/);
  fs.writeFileSync(file,daily.replace('1. [ ]','1. [x]'));const stamp=new Date(Date.now()+2000);fs.utimesSync(file,stamp,stamp);
  assert.doesNotMatch(f.answer('What are my remaining priorities today?').reply,/Prepare the talk/);
  const next=answerLocalLookup(f.root,inspectLocalLookup('What are my priorities today?'),{now:new Date('2026-09-13T18:00:00Z')});assert.match(next.reply,/Plan the next recording/);
  assert.ok(reads.every(file=>file.includes(`${path.sep}daily-notes${path.sep}`)),reads.join('\n'));
 }finally{fs.readFileSync=read}
});

test('missing current note never becomes a historical current plan; generic history is explicitly dated',t=>{
 const f=fixture(t);f.write('daily-notes/2020-01-01.md',daily);f.write('daily-notes/2099-01-01.md',daily.replace('Prepare the talk','Future private plan'));
 assert.match(f.answer('What are my priorities today?').reply,/daily note for today/);
 assert.doesNotMatch(f.answer('What are my priorities today?').reply,/Prepare the talk|Future/);
 const historical=f.answer('What are my priorities?');assert.match(historical.reply,/2020-01-01/);assert.match(historical.reply,/saved priorities were/);assert.doesNotMatch(historical.reply,/Future/);
 f.write('daily-notes/2026-09-12.md',daily.replace('Prepare the talk','Current actual plan'));
 assert.match(f.answer('What are my priorities?').reply,/Current actual plan/);
});

test('metrics reuse the shared parser, cache by file state, preserve zero and never infer a requested window',t=>{
 const f=fixture(t),file=f.write('system/metrics/metrics.csv',csv());
 const read=fs.readFileSync,reads=[];fs.readFileSync=function(file,...args){reads.push(String(file));return read.call(this,file,...args)};
 try{
  assert.match(f.answer('How many subscribers do I have?').reply,/42 YouTube|YouTube has 42/);
  const count=reads.length;assert.match(f.answer('How many Instagram followers do I have?').reply,/0 followers/);assert.equal(reads.length,count);
  assert.match(f.answer('What is my YouTube view count for 28 days?').reply,/123,456 views over 28 days/);
  fs.writeFileSync(file,csv(99));const stamp=new Date(Date.now()+2000);fs.utimesSync(file,stamp,stamp);
  assert.match(f.answer('How many subscribers do I have?').reply,/99/);
  fs.unlinkSync(file);assert.match(f.answer('How many subscribers do I have?').reply,/don't have/);
  assert.ok(reads.every(file=>file.endsWith(`${path.sep}system${path.sep}metrics${path.sep}metrics.csv`)),reads.join('\n'));
 }finally{fs.readFileSync=read}
});

test('stale, mock, malformed and missing metrics are distinguished from live values and zero',t=>{
 const f=fixture(t);
 f.write('system/metrics/metrics.csv',csv(123,'stale'));assert.match(f.answer('How many subscribers do I have?').reply,/123.*last saved reading/);
 f.write('system/metrics/metrics.csv',csv(42,'ok','2020-01-01T12:00:00Z'));assert.match(f.answer('How many subscribers do I have?').reply,/last saved reading/);
 f.write('system/metrics/metrics.csv',csv(123,'mock'));assert.match(f.answer('How many subscribers do I have?').reply,/don't have a usable/);
 f.write('system/metrics/metrics.csv','garbage');assert.match(f.answer('How many subscribers do I have?').reply,/don't have/);
});

test('latest video preserves absent counts as unavailable instead of synthetic zero',t=>{
 const f=fixture(t);f.write('system/metrics/latest-video.json',{title:'The dashboard tour',views:0,comments:10,status:'ok',published_at:'2026-09-11T18:00:00Z'});
 assert.match(f.answer('What are the views on my latest video?').reply,/0 views/);
 assert.match(f.answer('What are the likes on my latest video?').reply,/isn't available/);
 assert.doesNotMatch(f.answer('What are the likes on my latest video?').reply,/0 likes/);
 assert.match(f.answer('When was my latest video published?').reply,/2026-09-11/);
 const context=getLookupContext(f.root,inspectLocalLookup('How is my latest video revenue doing?'),{now});assert.equal(context.video.likes,null);assert.equal(context.video.views,0);
});

test('compact contexts exclude unrelated sources and are isolated by vault',t=>{
 const first=fixture(t),second=fixture(t);first.write('system/metrics/metrics.csv',csv(42));second.write('system/metrics/metrics.csv',csv(900));
 first.write('daily-notes/2026-09-12.md',daily.replace('Prepare the talk','PRIVATE_DAILY'));
 const intent=inspectLocalLookup('How much has my YouTube channel grown?');assert.equal(intent.kind,'ambiguous');
 const a=getLookupContext(first.root,intent,{now}),b=getLookupContext(second.root,intent,{now});
 assert.equal(a.metrics[0].value,42);assert.equal(b.metrics[0].value,900);assert.doesNotMatch(JSON.stringify(a),/PRIVATE_DAILY/);
 assert.ok(JSON.stringify(a).length<1800);
 const catalog=getLocalCatalog(first.root,{now});assert.equal(catalog.sources.length,4);assert.deepEqual(catalog.available,[]);
});

test('report discovery exposes only existing recorded safe outputs and invalidates record mutations',t=>{
 const f=fixture(t);f.write('inbox/research/first.md','PRIVATE_REPORT_BODY');f.write('inbox/research/second.md','OTHER_PRIVATE_BODY');
 const record=f.write('system/v2/runs/first.json',{status:'ok',skill:'research',summary:'The first summary',ts_completed:'2026-09-10T12:00:00Z',deliverable_path:'inbox/research/first.md'});
 f.write('system/runs/second.json',{status:'ok',skill:'analysis',summary:'The second summary',ts_completed:'2026-09-12T12:00:00Z',deliverable_path:'inbox/research/second.md'});
 f.write('system/runs/unsafe.json',{status:'ok',summary:'UNSAFE_SUMMARY',deliverable_path:'../outside.md'});
 f.write('system/runs/missing.json',{status:'ok',summary:'MISSING_SUMMARY',deliverable_path:'inbox/missing.md'});
 const read=fs.readFileSync,reads=[];fs.readFileSync=function(file,...args){reads.push(String(file));return read.call(this,file,...args)};
 try{
  const reply=f.answer('What is my latest report?');assert.equal(reply.deliverable,'inbox/research/second.md');assert.match(reply.reply,/second summary/);
  const context=getLookupContext(f.root,{source:'reports'},{now});assert.equal(context.reports.length,2);assert.doesNotMatch(JSON.stringify(context),/PRIVATE_REPORT|UNSAFE|MISSING/);
  assert.ok(reads.every(file=>file.endsWith('.json')),reads.join('\n'));
  fs.writeFileSync(record,JSON.stringify({status:'error',summary:'failed'}));assert.equal(getLookupContext(f.root,{source:'reports'},{now}).reports.length,1);
  fs.unlinkSync(path.join(f.root,'inbox/research/second.md'));assert.match(f.answer('What recent reports are available?').reply,/don't have/);
 }finally{fs.readFileSync=read}
});

test('linked source directories cannot expose files outside the vault',t=>{
 const f=fixture(t),other=fixture(t);other.write('metrics.csv',csv(999));
 fs.mkdirSync(path.join(f.root,'system'),{recursive:true});fs.symlinkSync(other.root,path.join(f.root,'system/metrics'),process.platform==='win32'?'junction':'dir');
 const reply=f.answer('How many subscribers do I have?');assert.match(reply.reply,/don't have/);assert.doesNotMatch(reply.reply,/999/);
});
