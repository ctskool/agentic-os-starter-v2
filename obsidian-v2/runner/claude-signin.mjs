import {spawn} from 'node:child_process';
import os from 'node:os';
import {findCli} from './cli-runtime.mjs';
import {classifierEnv} from './adapters.mjs';
import {stopCliProcessTree} from './cli-process-tree.mjs';
import {trackOwnedWork,ownedWorkDraining} from './jev.mjs';
import {VOICE_MODELS} from '../shared/contract.mjs';

// Claude Code's access pass lasts eight hours and only the Claude CLI renews it, when it makes a real request. The
// usage meter only reads that pass, so after an idle night it stayed blank until some request happened to reach the
// CLI. The bridge still never renews, sends or writes a token: it runs the real CLI once, locked down like the voice
// classifier (no tools, no MCP, no settings, no hooks, no saved session), and the CLI renews its own sign-in under
// its own locking. A renewal done here instead could race a Claude terminal for the single-use renewal pass and
// sign the user out.
export const RENEW_DEADLINE_MS=12000;
// After a renewal that changed nothing: 10 min, 30 min, 2 h, then every 8 h. Worst case 4 calls in the first 3 hours.
export const RENEW_BACKOFF_MS=Object.freeze([10*60*1000,30*60*1000,2*60*60*1000,8*60*60*1000]);
export const renewalArgs=model=>['--print','--model',model,'--output-format','json','--no-session-persistence','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--safe-mode','--disable-slash-commands','--system-prompt','Reply with the single word OK.'];
// The classifier's environment, minus the one variable it keeps that would let the CLI skip the credentials file it
// is here to renew. The config directory is absolute because the child does not run in the bridge's directory.
export function renewalEnv(inherited=process.env,configDir=null){
 const env=classifierEnv({provider:'claude',restricted:true},inherited);
 for(const name of Object.keys(env))if(['CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CONFIG_DIR'].includes(name.toUpperCase()))delete env[name];
 if(configDir)env.CLAUDE_CONFIG_DIR=configDir;
 return env;
}

let flight=null,closed=false,failures=0,nextAttempt=0,lastIdentity=null;
// Permanent: set once shutdown is really under way (after /shutdown's own guard, or on a signal). Never reset.
export function closeClaudeSignIn(){closed=true;try{flight?.controller.abort()}catch{}}
export const claudeSignInState=()=>({renewing:!!flight,closed,failures,nextAttempt});

// Starts the renewal, or joins the one that is running. Returns a promise of {ok} that never rejects, or null when
// nothing was started. `verify` re-reads the credentials: success is a renewed pass, never an exit status.
export function renewClaudeSignIn({identity=null,configDir=null,verify=async()=>false,clock=Date.now,env=process.env,launch=spawn,find=findCli,stopTree=stopCliProcessTree,track=trackOwnedWork,draining=ownedWorkDraining,deadlineMs=RENEW_DEADLINE_MS,closeGraceMs=2000,model=VOICE_MODELS.claude}={}){
 if(flight)return flight.done;
 if(closed||draining())return null;
 if(String(env.AOS_CLAUDE_SIGNIN_RENEWAL||'').toLowerCase()==='off')return null;
 if(env.NODE_TEST_CONTEXT&&launch===spawn)return null;
 // A new or newly expired sign-in starts a fresh ladder; the same stale one keeps climbing it.
 if(identity!==lastIdentity){lastIdentity=identity;failures=0;nextAttempt=0}
 if(clock()<nextAttempt)return null;
 // An attempt that cannot even start counts: a missing CLI is not retried on every meter read.
 const failed=()=>{failures++;return null};
 nextAttempt=clock()+RENEW_BACKOFF_MS[Math.min(failures,RENEW_BACKOFF_MS.length-1)];
 let cli;try{cli=find('claude')}catch{return failed()}
 if(!cli?.command)return failed();
 const controller=new AbortController();
 let child;
 // Nothing is awaited between this admission check and the launch.
 if(closed||draining())return null;
 try{child=launch(cli.command,[...(cli.prefix||[]),...renewalArgs(model)],{cwd:os.tmpdir(),env:renewalEnv(env,configDir),shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']})}catch{return failed()}
 // The process is ours until the operating system says it closed; a launch that never produced one closes at once.
 const exited=new Promise(resolve=>{child.once('close',resolve);child.once('error',()=>{if(!Number.isInteger(child.pid))resolve()})});
 // A root that has exited while something it started still holds its pipes never reports 'close', and the tree
 // helper no longer acts on an exited root. Letting go of our ends of the pipes is what lets 'close' arrive.
 child.once('exit',()=>{const grace=setTimeout(()=>{for(const stream of [child.stdin,child.stdout,child.stderr])try{stream?.destroy?.()}catch{}},closeGraceMs);exited.then(()=>clearTimeout(grace))});
 const stop=()=>{try{stopTree(child)}catch{}};
 const timer=setTimeout(stop,deadlineMs);
 controller.signal.addEventListener('abort',stop,{once:true});
 try{child.stdout?.resume();child.stderr?.resume();child.stdin?.on('error',()=>{});child.stdin?.end('OK?')}catch{}
 track(exited,controller);
 const entry={controller,done:null};
 entry.done=exited.then(async()=>{
  clearTimeout(timer);
  let ok=false;try{ok=await verify()===true}catch{}
  if(ok){failures=0;nextAttempt=0}else failures++;
  if(flight===entry)flight=null;
  return {ok};
 });
 flight=entry;return entry.done;
}
