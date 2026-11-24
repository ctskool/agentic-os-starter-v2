// A saved CLAUDE_CODE_OAUTH_TOKEN signs the Claude CLI in without the account's connectors (measured 2026-11-23:
// 14 connectors without it, 0 with it), which ended every calendar and mail workflow "blocked". These pin the rule:
// a full Claude worker drops the variable only once the CLI has confirmed a normal stored sign-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {classifierEnv} from '../runner/adapters.mjs';
import {askStoredSignIn,hasSignInToken,refreshStoredSignIn,resetStoredSignIn,signInReport,useStoredSignIn,withSignInFallback,withoutSignInToken,workerSignInEnv,STORED_SIGN_IN_MAX_AGE_MS,STORED_SIGN_IN_DISTRUST_MS} from '../runner/claude-stored-signin.mjs';

const TOKEN='fake-saved-token';
const inherited=()=>({PATH:'path',USERPROFILE:'user',CLAUDE_CODE_OAUTH_TOKEN:TOKEN});
// A stand-in for the CLI: prints what `claude auth status` would and closes.
function cli(output,{error=false,hang=false}={}){
 const seen=[];
 const launch=(command,args,options)=>{
  seen.push({command,args,env:options.env});
  const child=new EventEmitter();child.stdout=new EventEmitter();child.kill=()=>{child.killed=true};
  if(!hang)setImmediate(()=>{if(error)return child.emit('error',new Error('not found'));child.stdout.emit('data',output);child.emit('close',0)});
  return child;
 };
 return {launch,seen};
}

test('the worker keeps the saved token until a stored sign-in is confirmed, then starts without it; the classifier always keeps it',()=>{
 resetStoredSignIn();
 const worker={provider:'claude',skill:'plan-today'};
 assert.equal(classifierEnv(worker,inherited()).CLAUDE_CODE_OAUTH_TOKEN,TOKEN,'nothing confirmed yet');
 assert.equal(classifierEnv(worker,inherited(),{storedSignIn:false}).CLAUDE_CODE_OAUTH_TOKEN,TOKEN);
 const env=classifierEnv(worker,{...inherited(),claude_code_oauth_token:'second-spelling'},{storedSignIn:true});
 assert.equal(Object.keys(env).some(name=>name.toUpperCase()==='CLAUDE_CODE_OAUTH_TOKEN'),false,'every spelling is removed');
 assert.equal(env.PATH,'path');
 for(const job of [{provider:'claude'},{provider:'claude',skill:'review',restricted:true}])assert.equal(classifierEnv(job,inherited(),{storedSignIn:true}).CLAUDE_CODE_OAUTH_TOKEN,TOKEN,'the classifier needs no connectors');
 assert.equal(classifierEnv({provider:'codex',skill:'plan-today'},inherited(),{storedSignIn:true}).CLAUDE_CODE_OAUTH_TOKEN,TOKEN,'Codex is untouched');
 const source=inherited();workerSignInEnv(source,{stored:true});assert.equal(source.CLAUDE_CODE_OAUTH_TOKEN,TOKEN,'the inherited environment is never changed');
 assert.equal(workerSignInEnv(source,{stored:false}),source);
 assert.equal(hasSignInToken({CLAUDE_CODE_OAUTH_TOKEN:'  '}),false);assert.equal(hasSignInToken({Claude_Code_OAuth_Token:'x'}),true);
 assert.deepEqual(withoutSignInToken({A:'1',claude_code_oauth_token:'x'}),{A:'1'});
});

test('the CLI is asked without the token, and only a claude.ai sign-in counts; any doubt is no',async()=>{
 const good=cli(JSON.stringify({loggedIn:true,authMethod:'claude.ai',storedClaudeAiLogin:true}));
 assert.equal(await askStoredSignIn({...inherited(),ANTHROPIC_API_KEY:'k',CLAUDECODE:'1'},{launch:good.launch,cli:{command:'claude',prefix:['--x']}}),true);
 assert.deepEqual(good.seen[0].args,['--x','auth','status']);
 assert.deepEqual(Object.keys(good.seen[0].env).sort(),['PATH','USERPROFILE'],'asked without the token, an API key or a parent-session marker');
 const ask=(output,options)=>askStoredSignIn(inherited(),{launch:cli(output,options).launch,cli:{command:'claude',prefix:[]},timeoutMs:60});
 assert.equal(await ask(JSON.stringify({loggedIn:true,authMethod:'oauth_token'})),false,'signed in by the token only');
 assert.equal(await ask(JSON.stringify({loggedIn:false,authMethod:'claude.ai'})),false);
 assert.equal(await ask('Unknown command: auth'),false,'an older CLI');
 assert.equal(await ask('',{error:true}),false);
 assert.equal(await ask('',{hang:true}),false,'a CLI that never answers');
 assert.equal(await askStoredSignIn(inherited(),{cli:null}),false,'Claude Code not installed');
});

test('the answer is reused for ten minutes, never asked when no token is set, and a failed ask keeps the token',async()=>{
 resetStoredSignIn();
 let clock=1000000,asked=0,answer=true;
 const options={env:inherited(),now:()=>clock,ask:async()=>{asked++;if(answer==='throw')throw new Error('boom');return answer}};
 assert.equal(useStoredSignIn(clock),false);
 assert.equal(await refreshStoredSignIn(options),true);assert.equal(useStoredSignIn(clock),true);
 assert.deepEqual(signInReport({env:inherited(),now:clock}),{token:true,stored:true,fallback:false});
 clock+=STORED_SIGN_IN_MAX_AGE_MS-1;assert.equal(await refreshStoredSignIn(options),true);assert.equal(asked,1,'still fresh');
 clock+=2;answer=false;assert.equal(await refreshStoredSignIn(options),false);assert.equal(asked,2);assert.equal(useStoredSignIn(clock),false);
 answer='throw';assert.equal(await refreshStoredSignIn({...options,force:true}),false);assert.equal(useStoredSignIn(clock),false,'a failed ask keeps the token');
 assert.equal(await refreshStoredSignIn({...options,env:{PATH:'p'}}),null);assert.equal(asked,3,'no token, nothing to ask');
 assert.deepEqual(signInReport({env:{PATH:'p'},now:clock}),{token:false,stored:null,fallback:false});
 assert.equal(JSON.stringify(signInReport({env:inherited(),now:clock})).includes(TOKEN),false,'the report never carries the token');
});

test('a worker that cannot sign in on the stored sign-in is run once more with the token, and the token is trusted for an hour',async()=>{
 resetStoredSignIn();
 let clock=5000000;const now=()=>clock,refresh=()=>refreshStoredSignIn({env:inherited(),now,ask:async()=>true});
 const job={provider:'claude',skill:'plan-today'},runs=[];
 await refresh();   // what the bridge does when it starts
 let started=false;withSignInFallback(job,async()=>{started=true;return 'x'},{refresh,now});
 assert.equal(started,true,'the worker starts at once; nothing waits for the CLI');
 const failing=async()=>{runs.push(useStoredSignIn(clock));if(runs.length===1)throw new Error('Invalid API key · Please run /login');return 'done'};
 assert.equal(await withSignInFallback(job,failing,{refresh,now}),'done');
 assert.deepEqual(runs,[true,false],'first on the stored sign-in, then with the token');
 assert.equal(signInReport({env:inherited(),now:clock}).fallback,true);
 clock+=STORED_SIGN_IN_DISTRUST_MS+1;assert.equal(useStoredSignIn(clock),true,'the stored sign-in is tried again after an hour');
 // Any other failure is the worker's own and is not retried.
 let attempts=0;
 await assert.rejects(withSignInFallback(job,async()=>{attempts++;throw new Error('Worker timed out after 1200 seconds')},{refresh,now}),/timed out/);
 assert.equal(attempts,1);
 // With the token in use from the start there is nothing to fall back to.
 resetStoredSignIn();attempts=0;
 await assert.rejects(withSignInFallback(job,async()=>{attempts++;throw new Error('Please run /login')},{refresh:async()=>false,now}),/login/);
 assert.equal(attempts,1);
 // Codex never asks the Claude CLI anything.
 let asked=false;assert.equal(await withSignInFallback({provider:'codex'},async()=>'ok',{refresh:async()=>{asked=true}}),'ok');assert.equal(asked,false);
});
