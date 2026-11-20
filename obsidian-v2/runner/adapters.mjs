import {findCli} from './cli-runtime.mjs';
export {findCli} from './cli-runtime.mjs';
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {StringDecoder} from 'node:string_decoder';
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
 const args=job.provider==='codex'?['exec',...(restricted?['--ignore-user-config']:[]),'--ephemeral','--skip-git-repo-check','--sandbox',restricted?'read-only':'workspace-write','--model',job.model,'--json','--color','never','--output-last-message',final,'-']:['--print','--model',job.model,'--output-format',job.stream&&restricted?'stream-json':'json',...(job.stream&&restricted?['--verbose']:[]),'--no-session-persistence',...(restricted?['--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','']:[])];
 if(restricted&&job.provider==='codex')args.splice(1,0,
  '-c','skills.max_context_tokens=1','-c','project_doc_max_bytes=0',
  '-c','features.shell_tool=false','-c','features.multi_agent=false','-c','apps._default.enabled=false',
  '-c','web_search="disabled"','-c',`model_instructions_file=${JSON.stringify(path.join(projectRoot,'runner/voice-classifier-instructions.md'))}`,
  '-c',`model_reasoning_effort="${job.model==='gpt-5.6-luna'?'medium':'low'}"`);
 if(!restricted&&job.provider==='codex')args.splice(1,0,'-c','sandbox_workspace_write.network_access=true','-c','approval_policy="never"','-c','web_search="live"');
 // --effort low: MAX_THINKING_TOKENS=0 alone does not stop Haiku 5.5 from thinking (it thought on 28 of 36
 // replayed real voice requests, 2026-11-19). With low effort the median answer came 3.0 s -> 1.6 s, routing was
 // identical on all 12 questions and a blind judge scored the answers even. Full workers keep their own effort.
 if(restricted&&job.provider==='claude')args.push('--safe-mode','--disable-slash-commands','--effort','low','--system-prompt',classifierInstructions);
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
// Reads a classifier's event stream line by line and reports its answer once the turn has ended well.
// Claude prints a "result" line when the turn is over and only then starts closing; Codex prints the answer,
// then "turn.completed", then closes. On a busy or slow machine closing alone takes one to three seconds,
// which the person waiting for a spoken reply never needed. The answer is taken from that closing line and
// never from anything earlier: text the model wrote before a turn that then failed must not be acted on.
export function answerStream(provider){
 let buffer='',last='',result=null,events=0;
 return {
  push(chunk){
   buffer+=chunk;let found=null,at;
   while((at=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,at).trim();buffer=buffer.slice(at+1);
    if(!line)continue;
    let event;try{event=JSON.parse(line)}catch{continue}
    if(!event||typeof event!=='object')continue;
    events++;
    if(provider==='claude'){
     // The last word on the turn. An error result is kept for the ordinary failure path and is never an answer.
     if(event.type==='result'){result=event;found=!event.is_error&&typeof event.result==='string'?{text:event.result}:null}
    }else if(event.type==='item.completed'&&event.item?.type==='agent_message'&&typeof event.item.text==='string')last=event.item.text;
    else if(event.type==='turn.failed'||event.type==='error'){last='';found=null}
    else if(event.type==='turn.completed'&&last)found={text:last};
   }
   if(buffer.length>1000000)buffer=buffer.slice(-1000000);
   return found;
  },
  result:()=>result,
  // Whether the program ever printed an event: one that refused its arguments printed none.
  seen:()=>events>0
 };
}
// Starts a classifier's program before there is anything to ask it, so that its start-up (half a second on
// a fast computer, several on a slow or busy one) happens while the member's words are still being turned
// into text. The program is exactly the one executeCli would start for this job in streaming mode; it sits
// waiting for its input. Whoever holds the handle must either pass it to executeCli or call discard().
// Claude's --print gives up when nothing arrives on its input for three seconds; one space keeps it waiting
// and is harmless in front of the prompt.
export function prestartCli(root,job,{launch=spawn,resolveCommand=commandFor,stopTree=stopCliProcessTree}={}){
 const spec=resolveCommand(root,{...job,stream:true});
 const child=launch(spec.command,spec.args,{cwd:root,env:classifierEnv(job,{...process.env,...workerEnv(root)}),shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
 // gone: the program has ended. inputClosed: it can no longer be asked anything (it may still be running).
 const handle={child,signature:JSON.stringify([spec.command,spec.args]),out:[],err:[],gone:false,inputClosed:false,taken:false,
  closed:new Promise(resolve=>child.once('close',resolve)),
  // What it printed while waiting is kept: a healthy one prints nothing until it is asked.
  keepOut:chunk=>handle.out.push(chunk),keepErr:chunk=>handle.err.push(chunk),
  // Stops it whether or not a request has taken it (shutdown); discard is for a holder that will not use it.
  stop(){if(!handle.gone)try{stopTree(child)}catch{}},
  discard(){if(handle.taken)return;handle.taken=true;handle.stop()}};
 const gone=()=>{handle.gone=true};
 child.once('error',gone);child.once('exit',gone);child.stdin.on('error',()=>{handle.inputClosed=true});
 child.stdout.on('data',handle.keepOut);child.stderr.on('data',handle.keepErr);
 try{child.stdin.write(' ')}catch{handle.inputClosed=true}
 return handle;
}
// early: take a classifier's answer from its output stream and stop its program, instead of waiting for the
// program to close. Never for a workflow (its result is a file or a structured report). onDetached receives
// a promise that settles when the stopped program has really closed, and a controller whose abort() asks
// again for it to be stopped, so the caller can keep counting it and can retry at shutdown.
// prestarted: a handle from prestartCli. It is used only when it is still waiting and is exactly the program
// this call would start; otherwise it is discarded and a fresh program is started, as if it had not existed.
export function executeCli(root,job,prompt,{signal,timeoutMs=job.skill?1200000:60000,launch=spawn,resolveCommand=commandFor,stopTree=stopCliProcessTree,early=false,onDetached=()=>{},prestarted=null}={}){
 if(signal?.aborted){prestarted?.discard();return Promise.reject(new Error('Voice request cancelled'))}
 const streaming=early===true&&(!job.skill||job.restricted);
 const stream=streaming?answerStream(job.provider):null;
 const spec=resolveCommand(root,streaming?{...job,stream:true}:job);const log=vaultPath(root,`${ROOT}/logs/${job.artifactId||job.id}.log`);fs.mkdirSync(path.dirname(log),{recursive:true});
 return new Promise((resolve,reject)=>{
  const adopted=prestarted&&streaming&&!prestarted.taken&&!prestarted.gone&&!prestarted.inputClosed&&prestarted.out.length===0&&prestarted.signature===JSON.stringify([spec.command,spec.args])?prestarted:null;
  if(prestarted&&!adopted)prestarted.discard();
  if(adopted)adopted.taken=true;
  const child=adopted?adopted.child:launch(spec.command,spec.args,{cwd:root,env:classifierEnv(job,{...process.env,...workerEnv(root)}),shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
  const closed=adopted?adopted.closed:new Promise(resolve=>child.once('close',resolve));
  let stdout='',stderr='',failure='',settled=false,stopping=false,stopTimer;
  const stop=reason=>{if(settled||stopping)return;stopping=true;failure=reason;stopTree(child);stopTimer=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();const error=new Error(failure+'; process shutdown could not be confirmed.');error.cleanupUnconfirmed=true;error.closed=closed;finish(error)},10000);stopTimer.unref?.()};
  const timeout=setTimeout(()=>stop(`Worker timed out after ${timeoutMs/1000} seconds`),timeoutMs);
  const cancelled=()=>stop(job.skill?'Workflow cancelled':'Voice request cancelled');signal?.addEventListener('abort',cancelled,{once:true});
  const interrupted=()=>stop('Worker interrupted');process.once('SIGINT',interrupted);process.once('SIGTERM',interrupted);
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timeout);clearTimeout(stopTimer);signal?.removeEventListener('abort',cancelled);process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);try{fs.writeFileSync(log,stdout+'\n--- stderr ---\n'+stderr)}catch(logError){error=error||logError}error?reject(error):resolve(value)};
  let inputFailed=false;
  child.on('error',e=>{if(child.pid&&child.exitCode===null&&child.signalCode===null){e.cleanupUnconfirmed=true;e.closed=closed}finish(e)});child.stdin.on('error',()=>{inputFailed=true});
  // The answer is in hand and the program is no longer needed. It stays ours until the system confirms
  // it has closed; a reading problem of any kind falls through to the ordinary wait for the close.
  const answered=text=>{
   if(settled||stopping)return;
   finish(null,{text});
   const stopAgain=()=>{try{stopTree(child)}catch{}};
   stopAgain();
   // Still open after ten seconds: ask once more, then let go of its pipes. It stays counted until it closes.
   const giveUp=setTimeout(()=>{stopAgain();child.stdout.destroy();child.stderr.destroy()},10000);giveUp.unref?.();
   closed.then(()=>clearTimeout(giveUp));
   try{onDetached(closed,{abort:stopAgain})}catch{}
  };
  // One decoder for the whole stream: a letter split across two reads must not be damaged.
  const decoder=new StringDecoder('utf8');
  const onOut=b=>{const text=decoder.write(b);stdout+=text;if(stdout.length>4000000){stdout=stdout.slice(0,4000000);stop('Worker output exceeded limit');return}
   if(stream&&!settled){let found=null;try{found=stream.push(text)}catch{}if(found)answered(found.text)}};
  const onErr=b=>{stderr=(stderr+b.toString()).slice(-100000)};
  // From here on the adopted program's output comes straight to this request. It had printed nothing to its
  // output (checked above); anything on its error stream is kept for the run log. (One step, so nothing can
  // arrive in between.)
  if(adopted){child.stdout.off('data',adopted.keepOut);child.stderr.off('data',adopted.keepErr);for(const chunk of adopted.out.splice(0))onOut(chunk);for(const chunk of adopted.err.splice(0))onErr(chunk)}
  child.stdout.on('data',onOut);
  child.stderr.on('data',onErr);
  child.on('close',code=>{
   if(failure||code!==0){
    const error=new Error(failure||`${job.provider} exited ${code}. See this run’s local log; check sign-in, model access, or rate limits.`);
    // An older CLI that does not know the event-stream output refuses its arguments before any model runs.
    // The caller asks once more the old way (fast-voice.mjs).
    // It ended without printing a single byte (a partial line counts as output).
    if(stream&&!failure&&stdout==='')error.noOutput=true;
    // Only Claude gets different arguments for streaming, and only a refusal that names them counts, whichever
    // comes first on the line ("unknown option '--verbose'", "argument 'stream-json' is invalid").
    if(stream&&!failure&&stdout===''&&job.provider==='claude'&&/(?:unknown|unrecognized|unexpected|invalid|not (?:a )?valid|allowed)[^\n]*(?:--verbose|--output-format|stream-json)|(?:--verbose|--output-format|stream-json)[^\n]*(?:unknown|unrecognized|unexpected|invalid|not (?:a )?valid|allowed)/i.test(stderr))error.streamUnsupported=true;
    // Positive evidence that the request was never handed over: the program refused its arguments before
    // reading anything, or its input could not be written. Silence alone is not evidence: a program can
    // take the request, reach the model and then die without a word.
    if(error.noOutput&&(error.streamUnsupported||inputFailed))error.notSubmitted=true;
    return finish(error);
   }
   try{
    if(job.provider==='codex'){const text=fs.readFileSync(spec.final,'utf8');return finish(null,job.skill&&!job.restricted?parseWorkerResult(text):{text})}
    const result=stream?stream.result():JSON.parse(stdout);if(!result)throw Object.assign(new Error('Claude closed without a result.'),stream&&stdout===''?{noOutput:true}:{});if(result.is_error)throw new Error(String(result.result||'Claude run failed'));finish(null,job.skill&&!job.restricted?parseWorkerResult(result.structured_output||result.result):{text:result.result});
   }catch(e){finish(e)}
  });
  if(signal?.aborted)cancelled();
  child.stdin.end(prompt);
 });
}
