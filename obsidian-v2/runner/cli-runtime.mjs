import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {projectRoot} from './runtime.mjs';

const pinFile=path.join(projectRoot,'.runtime','providers.json');
export function assertCliRuntime(provider,cli,{exists=fs.existsSync}={}){
 if(!cli)return cli;
 // Desktop updates can retire companion binaries while a pinned codex.exe
 // survives. That executable still passes --version but every code-mode tool
 // then fails. Keep each desktop CLI with the host from its own bundle.
 const desktop=provider==='codex'&&/[\\/]OpenAI[\\/]Codex[\\/]bin[\\/][^\\/]+[\\/]codex\.exe$/i.test(cli.command);
 if(desktop){
  const host=path.join(path.dirname(cli.command),'codex-code-mode-host.exe');
  if(!exists(host))throw new Error(`The pinned Codex desktop runtime is incomplete: ${host} is missing. Pin a complete Codex desktop bundle and restart V2. No task was started.`);
 }
 return cli;
}
export function resolveCli(provider,{env=process.env,pins={},exists=fs.existsSync}={}){
 if(!['codex','claude'].includes(provider))throw new Error('Unknown CLI provider');
 const explicit=env[`AOS_${provider.toUpperCase()}_BIN`]||pins[provider]?.command;
 if(explicit){
  if(!path.isAbsolute(explicit)||!exists(explicit))throw new Error(`${provider} executable is unavailable at its configured path. Update .runtime/providers.json or AOS_${provider.toUpperCase()}_BIN and restart V2.`);
  return assertCliRuntime(provider,{command:explicit,prefix:[],source:env[`AOS_${provider.toUpperCase()}_BIN`]?'environment':'pinned'},{exists});
 }
 const dirs=(env.PATH||env.Path||'').split(path.delimiter).filter(Boolean);
 for(const dir of dirs){const candidate=path.join(dir,process.platform==='win32'?`${provider}.exe`:provider);if(exists(candidate))return assertCliRuntime(provider,{command:candidate,prefix:[],source:'PATH'},{exists})}
 if(provider==='codex')for(const dir of dirs){
  const packageRoot=path.join(dir,'node_modules/@openai/codex');
  if(process.platform==='win32'){
   const target=process.arch==='arm64'?'aarch64':'x86_64';
   const native=path.join(packageRoot,`node_modules/@openai/codex-win32-${process.arch}/vendor/${target}-pc-windows-msvc/bin/codex.exe`);
   if(exists(native))return {command:native,prefix:[],source:'npm'};
  }
  const entry=path.join(packageRoot,'bin/codex.js');if(exists(entry))return {command:process.execPath,prefix:[entry],source:'npm'};
 }
 return null;
}
export function createCliRuntime({env=process.env,readPins=()=>fs.existsSync(pinFile)?JSON.parse(fs.readFileSync(pinFile,'utf8')):{},exists=fs.existsSync,stat=fs.statSync,run=spawnSync,now=Date.now}={}){
 const status=new Map();
 // Pin files and desktop bundles can change while the bridge is running.
 // Resolution is cheap; cache only the subprocess version check, never a pin,
 // a missing installation, or a resolution error.
 function findCli(provider){return resolveCli(provider,{env,pins:readPins(),exists})}
 function identity(cli){
  const files=[cli.command,...cli.prefix.filter(path.isAbsolute)];
  if(/[\\/]OpenAI[\\/]Codex[\\/]bin[\\/][^\\/]+[\\/]codex\.exe$/i.test(cli.command))files.push(path.join(path.dirname(cli.command),'codex-code-mode-host.exe'));
  return JSON.stringify([cli.command,cli.prefix,cli.source,...files.map(file=>{const value=stat(file);return [file,value.size,value.mtimeMs,value.ctimeMs,value.ino]})]);
 }
 function cliStatus(provider){
  try{
   const cli=findCli(provider);
   if(!cli){status.delete(provider);return {installed:false,detail:`${provider} CLI is not installed`}}
   const key=identity(cli),cached=status.get(provider);
   if(cached?.key===key&&(cached.info.installed||now()-cached.checkedAt<5000))return cached.info;
   const result=run(cli.command,[...cli.prefix,'--version'],{encoding:'utf8',timeout:5000,windowsHide:true,shell:false});
   const version=result.status===0?(result.stdout||'').trim().slice(0,120):null;
   const info={installed:!!version,command:cli.command,source:cli.source,version,detail:version?'':`${provider} version check failed. Check its configured executable.`};
   status.set(provider,{key,info,checkedAt:now()});return info;
  }catch(error){status.delete(provider);return {installed:false,detail:error.message}}
 }
 return {findCli,cliStatus};
}
const runtime=createCliRuntime();
export const findCli=runtime.findCli;
export const cliStatus=runtime.cliStatus;
