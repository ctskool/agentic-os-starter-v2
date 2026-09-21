import {findCli} from './cli-runtime.mjs';
export {findCli} from './cli-runtime.mjs';
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
import {ROOT} from '../shared/contract.mjs';
import {vaultPath} from './core.mjs';
import {workerEnv} from './workflows.mjs';
import {projectRoot} from './runtime.mjs';
import {stopCliProcessTree} from './cli-process-tree.mjs';
const resultSchema=fs.readFileSync(path.join(projectRoot,'runner/result-schema.json'),'utf8');
const classifierInstructions=fs.readFileSync(path.join(projectRoot,'runner/voice-classifier-instructions.md'),'utf8');
// A background Claude worker runs with --print: nobody is there to approve a tool, so a tool that is not pre-approved
// (here, or by the user's own Claude permission settings) is refused. The claude.ai Google connectors were not, which
// blocked every workflow that must read the calendar or the inbox (Plan Today ended BLOCKED on 2026-09-21).
// Owner's decision (2026-09-21): a background Claude worker gets everything the signed-in Google connectors offer,
// the same as a background Codex worker already has (approval_policy="never", connectors on). --allowedTools only
// pre-approves; the workflow prompt still forbids sending, deleting and changing accounts unless a workflow says so.
export const CLAUDE_WORKER_GOOGLE=Object.freeze(['mcp__claude_ai_Google_Calendar__*','mcp__claude_ai_Gmail__*','mcp__claude_ai_Google_Drive__*']);
export function classifierEnv(job,inherited=process.env){
 const env={...inherited};
 if(job.provider==='claude'){
  // Use Claude Code's sign-in without inheriting an API-billed gateway or
  // nested-session/bare-mode behavior from the bridge's launching shell.
  // OAuth credentials and the user's config directory remain available.
  const overrides=new Set(['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CLAUDE_CODE_SIMPLE','CLAUDECODE']);
  for(const name of Object.keys(env))if(overrides.has(name.toUpperCase()))delete env[name];
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';
  env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE='1';
  if(!job.skill||job.restricted){
  // Match the former fast Haiku call: one short answer without extended
  // thinking. Full workers and Luna keep their own reasoning settings.
  env.MAX_THINKING_TOKENS='0';
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS='1200';
  }
 }
 return env;
}
export function parseWorkerResult(value){
 const data=typeof value==='string'?JSON.parse(value):value;
 if(!data||!['ok','blocked'].includes(data.status)||typeof data.summary!=='string'||!data.summary.trim()||typeof data.markdown!=='string'||data.markdown.length>250000)throw new Error('Worker returned invalid completion status');
 if(data.status==='ok'&&!data.markdown.trim())throw new Error('Worker returned a summary without the report.');
 return {status:data.status,summary:data.summary.slice(0,500),text:data.markdown||data.summary};
}
export function commandFor(root,job,cli=findCli(job.provider)){
 if(!cli)throw new Error(`${job.provider} CLI not installed`);
 // A classifier attempt may close after the worker that reuses its request ID
 // has started; its artifacts must never share that worker's paths.
 const final=vaultPath(root,`${ROOT}/logs/${job.artifactId||job.id}.final.md`);
 const restricted=!job.skill||job.restricted;
 const args=job.provider==='codex'?['exec',...(restricted?['--ignore-user-config']:[]),'--ephemeral','--skip-git-repo-check','--sandbox',restricted?'read-only':'workspace-write','--model',job.model,'--json','--color','never','--output-last-message',final,'-']:['--print','--model',job.model,'--output-format','json','--no-session-persistence',...(restricted?['--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','']:[])];
 if(restricted&&job.provider==='codex')args.splice(1,0,
  '-c','skills.max_context_tokens=1','-c','project_doc_max_bytes=0',
  '-c','features.shell_tool=false','-c','features.multi_agent=false','-c','apps._default.enabled=false',
  '-c','web_search="disabled"','-c',`model_instructions_file=${JSON.stringify(path.join(projectRoot,'runner/voice-classifier-instructions.md'))}`,
  '-c',`model_reasoning_effort="${job.model==='gpt-5.6-luna'?'medium':'low'}"`);
 if(!restricted&&job.provider==='codex')args.splice(1,0,'-c','sandbox_workspace_write.network_access=true','-c','approval_policy="never"','-c','web_search="live"');
 if(restricted&&job.provider==='claude')args.push('--safe-mode','--disable-slash-commands','--system-prompt',classifierInstructions);
 const mcp={command:process.execPath,args:[path.join(projectRoot,'runner/vault-mcp.mjs')],env:{AOS_V2_VAULT:root}};
 if(!restricted&&job.provider==='codex')args.splice(1,0,'--output-schema',path.join(projectRoot,'runner/result-schema.json'),'-c',`mcp_servers.agentic_vault.command=${JSON.stringify(mcp.command)}`,'-c',`mcp_servers.agentic_vault.args=${JSON.stringify(mcp.args)}`,'-c',`mcp_servers.agentic_vault.env.AOS_V2_VAULT=${JSON.stringify(root)}`);
 if(!restricted&&job.provider==='codex')args.splice(1,0,'-c','mcp_servers.agentic_vault.default_tools_approval_mode="writes"');
 if(!restricted&&job.provider==='claude'){
  // Add our vault tools to the user's authenticated connectors. Only the
  // classifier strips custom configuration; a full workflow needs those tools.
  args.push('--mcp-config',JSON.stringify({mcpServers:{agentic_vault:mcp}}),'--json-schema',resultSchema,'--permission-mode','acceptEdits','--allowedTools',['Read,Glob,Grep,WebSearch,WebFetch,mcp__agentic_vault__*,Bash(python:*),Bash(notebooklm:*),Bash(yt-dlp:*),Bash(gh:*),Bash(firecrawl:*)',...CLAUDE_WORKER_GOOGLE].join(','));
 }
 if(job.provider==='codex'&&job.model==='gpt-6-astra')args.splice(1,0,'-c','model_reasoning_effort="medium"');
 return {command:cli.command,args:[...cli.prefix,...args],final};
}
export function executeCli(root,job,prompt,{signal,timeoutMs=job.skill?1200000:60000,launch=spawn,resolveCommand=commandFor,stopTree=stopCliProcessTree}={}){
 if(signal?.aborted)return Promise.reject(new Error('Voice request cancelled'));
 const spec=resolveCommand(root,job);const log=vaultPath(root,`${ROOT}/logs/${job.artifactId||job.id}.log`);fs.mkdirSync(path.dirname(log),{recursive:true});
 return new Promise((resolve,reject)=>{
  const child=launch(spec.command,spec.args,{cwd:root,env:classifierEnv(job,{...process.env,...workerEnv(root)}),shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
  const closed=new Promise(resolve=>child.once('close',resolve));
  let stdout='',stderr='',failure='',settled=false,stopping=false,stopTimer;
  const stop=reason=>{if(settled||stopping)return;stopping=true;failure=reason;stopTree(child);stopTimer=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();const error=new Error(failure+'; process shutdown could not be confirmed.');error.cleanupUnconfirmed=true;error.closed=closed;finish(error)},10000);stopTimer.unref?.()};
  const timeout=setTimeout(()=>stop(`Worker timed out after ${timeoutMs/1000} seconds`),timeoutMs);
  const cancelled=()=>stop(job.skill?'Workflow cancelled':'Voice request cancelled');signal?.addEventListener('abort',cancelled,{once:true});
  const interrupted=()=>stop('Worker interrupted');process.once('SIGINT',interrupted);process.once('SIGTERM',interrupted);
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timeout);clearTimeout(stopTimer);signal?.removeEventListener('abort',cancelled);process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);try{fs.writeFileSync(log,stdout+'\n--- stderr ---\n'+stderr)}catch(logError){error=error||logError}error?reject(error):resolve(value)};
  child.on('error',e=>{if(child.pid&&child.exitCode===null&&child.signalCode===null){e.cleanupUnconfirmed=true;e.closed=closed}finish(e)});child.stdin.on('error',()=>{});
  child.stdout.on('data',b=>{stdout+=b.toString();if(stdout.length>4000000){stdout=stdout.slice(0,4000000);stop('Worker output exceeded limit')}});
  child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-100000)});
  child.on('close',code=>{
   if(failure||code!==0)return finish(new Error(failure||`${job.provider} exited ${code}. See this run’s local log; check sign-in, model access, or rate limits.`));
   try{
    if(job.provider==='codex'){const text=fs.readFileSync(spec.final,'utf8');return finish(null,job.skill&&!job.restricted?parseWorkerResult(text):{text})}
    const result=JSON.parse(stdout);if(result.is_error)throw new Error(String(result.result||'Claude run failed'));finish(null,job.skill&&!job.restricted?parseWorkerResult(result.structured_output||result.result):{text:result.result});
   }catch(e){finish(e)}
  });
  if(signal?.aborted)cancelled();
  child.stdin.end(prompt);
 });
}
