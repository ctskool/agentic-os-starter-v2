import {configuredVault} from './runtime.mjs';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {MARKER,ROOT} from '../shared/contract.mjs';
import {assertVault,vaultPath,writeJson,processJob,atomicRename} from './core.mjs';
import {findCli,executeCli} from './adapters.mjs';
const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root=assertVault(configuredVault());
for(const dir of ['queue','processing','runs','logs','rejected'])fs.mkdirSync(vaultPath(root,`${ROOT}/${dir}`),{recursive:true});
const lock=vaultPath(root,`${ROOT}/runner.lock`);
if(fs.existsSync(lock)){
 const old=JSON.parse(fs.readFileSync(lock,'utf8'));let alive=false;try{process.kill(old.pid,0);alive=true}catch{}
 if(alive)throw new Error(`V2 runner already active (PID ${old.pid})`);
 fs.renameSync(lock,lock+'.stale.'+Date.now());
}
fs.writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:'wx'});
let busy=false,stopping=false;
const providers=Object.fromEntries(['codex','claude'].map(p=>[p,{installed:!!findCli(p),detail:findCli(p)?'CLI found; model access checked on execution':'Not installed'}]));
function heartbeat(){writeJson(root,`${ROOT}/runner-status.json`,{ts:new Date().toISOString(),pid:process.pid,version:'2.0.0',busy,active:busy?1:0,max_concurrent:1,pending:fs.readdirSync(vaultPath(root,`${ROOT}/queue`)).filter(f=>f.endsWith('.json')).length,providers})}
function cleanup(){clearInterval(timer);try{writeJson(root,`${ROOT}/runner-status.json`,{ts:'1970-01-01T00:00:00Z',pid:0,busy:false,providers});fs.unlinkSync(lock)}catch{}}
// Never silently replay work after a crash. Leave an explicit failed run.
for(const file of fs.readdirSync(vaultPath(root,`${ROOT}/runs`)).filter(f=>f.endsWith('.json'))){const p=vaultPath(root,`${ROOT}/runs/${file}`);const r=JSON.parse(fs.readFileSync(p,'utf8'));if(r.status==='running'){Object.assign(r,{status:'error',summary:'Previous worker stopped before completion. Review before retrying.',exit_code:1,ts_completed:new Date().toISOString()});writeJson(root,`${ROOT}/runs/${file}`,r)}}
heartbeat();const timer=setInterval(()=>{try{heartbeat()}catch(e){console.error('Heartbeat update deferred:',e.message)}},3000);
process.on('SIGINT',()=>{stopping=true});process.on('SIGTERM',()=>{stopping=true});process.on('exit',cleanup);
console.log(`Agentic OS V2 worker · ${root} · serial queue · no fallback`);
try{
 do{
  const name=fs.readdirSync(vaultPath(root,`${ROOT}/queue`)).filter(n=>n.endsWith('.json')).sort()[0];
  if(name){
   const incoming=vaultPath(root,`${ROOT}/queue/${name}`), claimed=vaultPath(root,`${ROOT}/processing/${name}`);
   try{atomicRename(incoming,claimed)}catch(e){if(['EPERM','EACCES','EBUSY'].includes(e.code)){console.error('Queue claim deferred:',e.message);await new Promise(r=>setTimeout(r,1000));continue}throw e}busy=true;heartbeat();
   try{const job=JSON.parse(fs.readFileSync(claimed,'utf8'));if(name!==`${job.id}.json`)throw new Error('Filename does not match job ID');const record=await processJob(root,job,(j,p)=>executeCli(root,j,p));console.log(`${record.id} ${record.provider} ${record.status}`)}
   catch(e){fs.renameSync(claimed,vaultPath(root,`${ROOT}/rejected/${Date.now()}-${name}`));console.error('Rejected job:',e.message)}
   busy=false;heartbeat();
  }
  if(process.argv.includes('--once'))break;
  await new Promise(r=>setTimeout(r,1000));
 }while(!stopping);
}finally{cleanup()}
