import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

let now=0;
globalThis.dashboardCacheNow=()=>now;
const built=await build({
 entryPoints:['src/lib/queue.ts','src/lib/metrics.ts'],bundle:true,platform:'node',format:'esm',write:false,outdir:'unused',
 define:{'Date.now':'globalThis.dashboardCacheNow'},
 plugins:[{name:'dashboard-cache-fixtures',setup(builder){
  builder.onResolve({filter:/^(obsidian|\.\/provider|\.\/work|\.\/v2-voice)$/},args=>({path:args.path,namespace:'fixture'}));
  builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:{
   obsidian:'export class Notice{}',
   './provider':'export async function assertTestVault(){};export async function readSelection(){}',
   './work':'export async function workRequest(){}',
   './v2-voice':'export async function assertVoiceVault(){}',
  }[args.path]}));
 }}],
});
const modules=await Promise.all(built.outputFiles.map(file=>import('data:text/javascript;base64,'+Buffer.from(file.text).toString('base64'))));
const {listRecentRuns,invalidateRecentRuns,RUNS_DIR}=modules.find(module=>module.listRecentRuns);
const {readMetricsCsv,invalidateMetrics,snapshotByKey,METRICS_CSV_PATH}=modules.find(module=>module.snapshotByKey);
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve}};
const run=(id,day,summary=id)=>({id,ts_started:`2026-09-${day}T12:00:00Z`,ts_completed:null,summary});
function vault(records=[]){
 const files=new Map(records.map(record=>[`${RUNS_DIR}/${record.id}.json`,JSON.stringify(record)]));
 const reads=[];let listings=0,present=true;
 const adapter={
  exists:async path=>path===RUNS_DIR?present:files.has(path),
  list:async()=>{listings++;return {files:[...files.keys()],folders:[]}},
  read:async path=>{reads.push(path);if(!files.has(path))throw new Error('Missing file');return files.get(path)},
 };
 const app={vault:{adapter}};
 return {app,adapter,files,reads,get listings(){return listings},set present(value){present=value}};
}

test('unchanged metric polls reuse their snapshot; a fresh CSV produces updated deltas without changing the source order',async()=>{
 const f=vault();
 const csv=value=>`timestamp,source,metric,value,status,error\n2026-09-15T12:00:00Z,youtube,subscribers,${value},ok,\n2026-09-14T12:00:00Z,youtube,subscribers,100,ok,\n`;
 f.files.set(METRICS_CSV_PATH,csv(120));
 const rows=await readMetricsCsv(f.app),first=snapshotByKey(rows);
 assert.equal(first.get('youtube:subscribers').delta,20);
 assert.equal(snapshotByKey(await readMetricsCsv(f.app)),first);
 assert.equal(f.reads.length,1);
 assert.equal(rows[0].value,120,'group sorting must not reorder the shared source rows');
 f.files.set(METRICS_CSV_PATH,csv(130));invalidateMetrics(f.app);
 const next=snapshotByKey(await readMetricsCsv(f.app));
 assert.notEqual(next,first);assert.equal(next.get('youtube:subscribers').delta,30);
 assert.equal(first.get('youtube:subscribers').delta,20);
});

test('concurrent dashboards with different limits share one full run scan and preserve ordering',async()=>{
 const f=vault([run('old','10'),run('new','15'),run('middle','12')]);
 const [short,long]=await Promise.all([listRecentRuns(f.app,1),listRecentRuns(f.app,32)]);
 assert.deepEqual(short.map(record=>record.id),['new']);
 assert.deepEqual(long.map(record=>record.id),['new','middle','old']);
 assert.equal(f.listings,1);assert.equal(f.reads.length,3);
 await listRecentRuns(f.app);assert.equal(f.listings,1);assert.equal(f.reads.length,3);
 short.pop();assert.equal((await listRecentRuns(f.app,1)).length,1,'a caller cannot truncate another dashboard’s cached list');
});

test('run snapshots are isolated by App even when the relative paths are identical',async()=>{
 const a=vault([run('same','15','vault a')]),b=vault([run('same','15','vault b')]);
 assert.equal((await listRecentRuns(a.app))[0].summary,'vault a');
 assert.equal((await listRecentRuns(b.app))[0].summary,'vault b');
 invalidateRecentRuns(a.app);await listRecentRuns(a.app);await listRecentRuns(b.app);
 assert.equal(a.listings,2);assert.equal(b.listings,1);
});

test('invalidation exposes newly created, modified and deleted run files without waiting for the TTL',async()=>{
 const f=vault();f.present=false;assert.deepEqual(await listRecentRuns(f.app),[]);
 f.present=true;f.files.set(`${RUNS_DIR}/new.json`,JSON.stringify(run('new','15')));invalidateRecentRuns(f.app);
 assert.equal((await listRecentRuns(f.app))[0].summary,'new');
 f.files.set(`${RUNS_DIR}/new.json`,JSON.stringify(run('new','15','completed')));invalidateRecentRuns(f.app);
 assert.equal((await listRecentRuns(f.app))[0].summary,'completed');
 f.files.delete(`${RUNS_DIR}/new.json`);invalidateRecentRuns(f.app);
 assert.deepEqual(await listRecentRuns(f.app),[]);
});

test('a scan invalidated while reading cannot replace the newer cached run snapshot',async()=>{
 const f=vault([run('same','15','old')]),pending=deferred(),entered=deferred();let first=true;
 const read=f.adapter.read;
 f.adapter.read=async path=>{const content=await read(path);if(first){first=false;entered.resolve();await pending.promise}return content};
 const old=listRecentRuns(f.app);await entered.promise;
 f.files.set(`${RUNS_DIR}/same.json`,JSON.stringify(run('same','15','new')));invalidateRecentRuns(f.app);
 assert.equal((await listRecentRuns(f.app))[0].summary,'new');
 pending.resolve();assert.equal((await old)[0].summary,'old');
 assert.equal((await listRecentRuns(f.app))[0].summary,'new');assert.equal(f.listings,2);
});

test('run scans expire after ten seconds and retain no more than eight App snapshots',async()=>{
 const f=vault([run('one','15')]);await listRecentRuns(f.app);
 now+=9999;await listRecentRuns(f.app);assert.equal(f.listings,1);
 now+=2;await listRecentRuns(f.app);assert.equal(f.listings,2);
 for(let i=0;i<8;i++)await listRecentRuns(vault([run(String(i),'15')]).app);
 await listRecentRuns(f.app);assert.equal(f.listings,3,'old App snapshots must be evicted');
});

test('a failed run directory scan is retried, while malformed run records remain skipped',async()=>{
 const f=vault([run('good','15')]),list=f.adapter.list;
 f.adapter.list=async()=>{throw new Error('Temporarily unavailable')};
 await assert.rejects(listRecentRuns(f.app),/Temporarily unavailable/);
 f.adapter.list=list;f.files.set(`${RUNS_DIR}/broken.json`,'invalid JSON');
 assert.deepEqual((await listRecentRuns(f.app)).map(record=>record.id),['good']);
});
