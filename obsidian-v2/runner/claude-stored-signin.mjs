// A Claude CLI started with CLAUDE_CODE_OAUTH_TOKEN in its environment (the long-lived token from
// `claude setup-token`) can answer, but gets none of the account's claude.ai connectors. Measured 2026-11-23 on
// CLI 2.1.330 with the worker's exact command: 14 connectors without the variable, 0 with it. Every workflow that
// reads the calendar or the inbox then ended "BLOCKED: no Google Calendar connector", with the connector connected.
// The bridge inherits the variable from the operating system when the member saved it for their user account.
//
// So a worker that may need connectors is started without the variable whenever the member also has a normal
// stored Claude sign-in (`claude auth status`, asked without the variable, reports a claude.ai login). When there
// is no such sign-in, or the CLI cannot say, the variable stays: that worker's only way to sign in.
// If a worker started without it then fails to sign in, the variable is trusted again for an hour and the work
// is run once more. The token itself is never read, logged or sent anywhere by this module.
import {spawn} from 'node:child_process';
import {findCli} from './cli-runtime.mjs';

export const SIGN_IN_TOKEN='CLAUDE_CODE_OAUTH_TOKEN';
export const STORED_SIGN_IN_MAX_AGE_MS=10*60*1000;
export const STORED_SIGN_IN_DISTRUST_MS=60*60*1000;
const SIGN_IN_FAILURE=/\/login|not logged in|log in again|authentication[_ ]error|oauth token|invalid api key|unauthori[sz]ed|\b401\b/i;
const isToken=name=>name.toUpperCase()===SIGN_IN_TOKEN;
export const hasSignInToken=(env=process.env)=>Object.keys(env).some(name=>isToken(name)&&String(env[name]??'').trim()!=='');

// stored: true = a normal claude.ai sign-in is stored, false = it is not, null = not asked yet or nothing to decide.
let state={stored:null,checkedAt:0},flight=null,distrustUntil=0;
export function resetStoredSignIn(){state={stored:null,checkedAt:0};flight=null;distrustUntil=0}
// The decision, without waiting: only true once the CLI has confirmed a stored sign-in and no worker has failed on it.
export const useStoredSignIn=(now=Date.now())=>state.stored===true&&now>=distrustUntil;
export function withoutSignInToken(env){
 const copy={...env};
 for(const name of Object.keys(copy))if(isToken(name))delete copy[name];
 return copy;
}
// For a full Claude worker or a Claude conversation: the environment it should start with.
export const workerSignInEnv=(env,{stored=useStoredSignIn()}={})=>stored?withoutSignInToken(env):env;

// Asks the CLI, with the variable left out, whether a claude.ai sign-in is stored. Any doubt is "no".
export function askStoredSignIn(env=process.env,{launch=spawn,cli=findCli('claude'),timeoutMs=8000}={}){
 return new Promise(resolve=>{
  if(!cli)return resolve(false);
  const clean=withoutSignInToken(env);
  for(const name of Object.keys(clean))if(['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CLAUDE_CODE_SIMPLE','CLAUDECODE'].includes(name.toUpperCase()))delete clean[name];
  let child,out='',done=false;
  const finish=value=>{if(done)return;done=true;clearTimeout(timer);try{child?.kill()}catch{}resolve(value)};
  const timer=setTimeout(()=>finish(false),timeoutMs);
  try{child=launch(cli.command,[...(cli.prefix||[]),'auth','status'],{env:clean,shell:false,windowsHide:true,stdio:['ignore','pipe','ignore']})}
  catch{return finish(false)}
  child.stdout.on('data',chunk=>{out=(out+chunk).slice(0,20000)});
  child.once('error',()=>finish(false));
  child.once('close',()=>{
   try{const status=JSON.parse(out);finish(status?.loggedIn===true&&status.authMethod==='claude.ai')}
   catch{finish(false)}
  });
 });
}
// Keeps the decision current. Cheap when nothing changed: without the variable there is nothing to decide, and
// an answer is reused for ten minutes. Never throws.
export async function refreshStoredSignIn({env=process.env,ask=askStoredSignIn,now=Date.now,force=false}={}){
 if(!hasSignInToken(env)){state={stored:null,checkedAt:now()};return null}
 if(!force&&state.checkedAt&&now()-state.checkedAt<STORED_SIGN_IN_MAX_AGE_MS)return state.stored;
 flight||=Promise.resolve().then(()=>ask(env)).then(value=>value===true,()=>false).then(stored=>{state={stored,checkedAt:now()};return stored}).finally(()=>{flight=null});
 return flight;
}
// What the doctor shows. No secrets: only whether the variable is set and what the CLI said.
export function signInReport({env=process.env,now=Date.now()}={}){
 return {token:hasSignInToken(env),stored:state.stored,fallback:now<distrustUntil};
}
// Runs a Claude worker. If it was started on the stored sign-in and could not sign in, the variable is trusted
// again for an hour and the work is run once more with it.
// The worker starts at once, on what is already known: the bridge asks the CLI when it starts and every ten
// minutes, and each run asks again in the background for the next one. Waiting here would delay every workflow.
export function withSignInFallback(job,run,{refresh=refreshStoredSignIn,now=Date.now}={}){
 if(job?.provider!=='claude')return run();
 try{Promise.resolve(refresh()).catch(()=>{})}catch{}
 const onStored=useStoredSignIn(now());
 let first;
 try{first=Promise.resolve(run())}catch(error){first=Promise.reject(error)}
 return first.catch(error=>{
  if(!onStored||!SIGN_IN_FAILURE.test(String(error?.message||error)))throw error;
  distrustUntil=now()+STORED_SIGN_IN_DISTRUST_MS;
  return run();
 });
}
