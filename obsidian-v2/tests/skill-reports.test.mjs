import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundled=await build({entryPoints:['src/lib/skill-reports.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {SkillReportTracker,checkedReportPath}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const id='11111111-1111-4111-8111-111111111111';
function fixture(){
 const records=new Map(),opens=[],notices=[],changes=[],reads=[];let time=0,ready=true;
 const options={read:async id=>{reads.push(id);return records.get(id)||null},ready:async()=>ready,open:async path=>{opens.push(path)},notice:message=>notices.push(message),changed:pending=>changes.push(pending),now:()=>time};
 const tracker=new SkillReportTracker(options);
 const record=(extra={})=>records.set(id,{id,skill:'morning-intel',status:'ok',deliverable_path:'inbox/reports/morning.md',...extra});
 return {tracker,options,records,opens,notices,changes,reads,record,track:()=>tracker.track(id,'morning-intel','Intel Brief'),advance:ms=>time+=ms,setReady:value=>ready=value};
}
test('a started skill opens only its referenced successful report once across duplicate events',async()=>{
 const f=fixture();f.records.set('historical',{id:'historical',skill:'morning-intel',status:'ok',deliverable_path:'inbox/old.md'});
 await f.tracker.check();assert.equal(f.reads.length,0);
 await f.track();f.record();await Promise.all([f.tracker.check(),f.tracker.check(),f.tracker.check()]);await f.tracker.check();await f.track();
 assert.deepEqual(f.opens,['inbox/reports/morning.md']);assert.ok(!f.reads.includes('historical'));assert.equal(f.changes.at(-1),false);assert.deepEqual(f.notices,[]);
});
test('a job completed before the queue response is observed still opens immediately when enrolled',async()=>{
 const f=fixture();f.record();await f.track();assert.equal(f.opens.length,1);
});
test('a failed or cancelled skill never opens a report and shows its failure only once',async()=>{
 for(const status of ['error','cancelled','stopped']){const f=fixture();f.record({status,summary:'Provider login expired'});await f.track();await f.tracker.check();assert.equal(f.opens.length,0);assert.deepEqual(f.notices,['Intel Brief did not finish: Provider login expired'])}
});
test('partial or failed status reads are retried without a false completion',async()=>{
 const f=fixture();f.options.read=async()=>{throw new Error('partial write')};await f.track();assert.deepEqual(f.notices,[]);assert.deepEqual(f.opens,[]);
 f.record();f.options.read=async id=>f.records.get(id);await f.tracker.check();assert.equal(f.opens.length,1);
});
test('report readiness waits for indexing and missing output is never announced done',async()=>{
 const f=fixture();f.record();f.setReady(false);await f.track();assert.equal(f.opens.length,0);assert.equal(f.notices.length,0);f.setReady(true);await f.tracker.check();assert.equal(f.opens.length,1);
 const g=fixture();g.record();g.setReady(false);await g.track();g.advance(15_001);await g.tracker.check();assert.match(g.notices[0],/not available to open/);assert.doesNotMatch(g.notices[0],/finished|ready/);
 const h=fixture();h.record({deliverable_path:null});await h.track();assert.match(h.notices[0],/no readable report/);
});
test('only safe vault-relative markdown paths can be auto-opened',async()=>{
 for(const path of ['../outside.md','C:/outside.md','/outside.md','inbox/../outside.md','inbox\\outside.md','https://example.com/a.md','.obsidian/report.md','inbox//a.md','inbox/a.md#heading','inbox/file.png','inbox/a.md\0']){
  assert.equal(checkedReportPath(path),null,path);const f=fixture();f.record({deliverable_path:path});await f.track();assert.equal(f.opens.length,0,path);assert.equal(f.notices.length,1,path);
 }
 assert.equal(checkedReportPath('inbox/research/a report.md'),'inbox/research/a report.md');
});
test('mismatched request results cannot open a different job report',async()=>{
 for(const extra of [{id:'other'},{skill:'another'}]){const f=fixture();f.record(extra);await f.track();assert.equal(f.opens.length,0);assert.match(f.notices[0],/did not match/)}
});
test('a direct refresh without a report can finish without opening a terminal or tab',async()=>{
 const f=fixture();f.record({skill:'metrics-pull',deliverable_path:null});await f.tracker.track(id,'metrics-pull','Pull Metrics',false);assert.deepEqual(f.opens,[]);assert.deepEqual(f.notices,['Pull Metrics finished.']);
});
test('unload while a status read is pending prevents any later tab or notice',async()=>{
 const f=fixture();let release;f.options.read=()=>new Promise(resolve=>release=resolve);const read=f.track();f.tracker.dispose();release({id,skill:'morning-intel',status:'ok',deliverable_path:'inbox/report.md'});await read;assert.deepEqual(f.opens,[]);assert.deepEqual(f.notices,[]);assert.equal(f.changes.at(-1),false);
 const replacement=fixture();replacement.record();await replacement.tracker.check();assert.equal(replacement.opens.length,0);
});
test('slow tab opening and reentrant events cannot open duplicate tabs',async()=>{
 const f=fixture();f.record();let release;f.options.open=async path=>{f.opens.push(path);await new Promise(resolve=>release=resolve)};const check=f.track();await new Promise(resolve=>setImmediate(resolve));await f.tracker.check();release();await check;assert.equal(f.opens.length,1);
});
test('unconfirmed old jobs stop polling with an honest status instead of a false success',async()=>{
 const f=fixture();await f.track();f.advance(2*60*60_000+1);await f.tracker.check();assert.match(f.notices[0],/completion could not be confirmed/);assert.equal(f.changes.at(-1),false);
});
test('an open failure does not retry into duplicate tabs and keeps saved report discoverable',async()=>{
 const f=fixture();f.record();f.options.open=async path=>{f.opens.push(path);throw new Error('workspace closed')};await f.track();await f.tracker.check();assert.equal(f.opens.length,1);assert.match(f.notices[0],/saved, but could not be opened/);
});
