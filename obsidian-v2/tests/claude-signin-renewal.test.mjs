import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {classifierProcesses,trackOwnedWork} from '../runner/jev.mjs';

const tick=(ms=5)=>new Promise(resolve=>setTimeout(resolve,ms));
const HOUR=3600000,MIN=60000;
const stale=()=>({accessToken:'fake-stale-access',expiresAt:Date.now()-1000,refreshToken:'fake-refresh'});
const fresh=(name='fake-renewed-access')=>({accessToken:name,expiresAt:Date.now()+8*HOUR,refreshToken:'fake-refresh-2'});

// A private credentials folder, fresh module instances, a fake usage endpoint and a fake CLI.
async function bench(t,{status=()=>200,delay=()=>0}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aos-signin-')),file=path.join(dir,'.credentials.json'),old=process.env.CLAUDE_CONFIG_DIR;
 process.env.CLAUDE_CONFIG_DIR=dir;
 t.after(()=>{if(old===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=old;fs.rmSync(dir,{recursive:true,force:true})});
 const fetches=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  const token=options.headers.Authorization;fetches.push(token);const n=fetches.length;
  if(delay(n))await tick(delay(n));
  const code=status(n,token);if(code==='network')throw new Error('offline');
  return code===200?Response.json({seven_day:{utilization:23,resets_at:null}}):new Response('{}',{status:code});
 });
 const stamp=crypto.randomUUID();
 const signin=await import('../runner/claude-signin.mjs?t='+stamp),{getClaudeUsage}=await import('../runner/claudeUsage.mjs?t='+stamp);
 const write=auth=>fs.writeFileSync(file,typeof auth==='string'?auth:JSON.stringify({claudeAiOauth:auth}));
 const launches=[],stops=[],tracked=[];
 // onLaunch decides what the fake CLI does; by default it renews the file and closes cleanly.
 const cli={onLaunch:child=>{write(fresh());child.finish(0)}};
 const launch=(command,args,options)=>{
  const child=new EventEmitter();Object.assign(child,{pid:4321,exitCode:null,signalCode:null,stdin:{on(){},end(text){child.prompt=text}},stdout:{resume(){}},stderr:{resume(){}}});
  child.finish=(code=0)=>{child.exitCode=code;child.emit('close',code)};
  launches.push({command,args,options,child});queueMicrotask(()=>cli.onLaunch(child));return child;
 };
 const options={launch,find:()=>({command:'C:\\fake\\claude.exe',prefix:[]}),stopTree:child=>stops.push(child),track:(promise,controller)=>tracked.push({promise,controller}),draining:()=>false};
 const renew=extra=>given=>signin.renewClaudeSignIn({...given,...options,...extra});
 return {dir,file,write,fetches,launches,stops,tracked,cli,signin,getClaudeUsage,options,renew,usage:(extra={},renewExtra={})=>getClaudeUsage({renew:renew(renewExtra),...extra})};
}

test('a stale but renewable sign-in: one locked-down CLI launch, and the same call returns the reading',async t=>{
 const b=await bench(t);b.write(stale());
 const env={...process.env,CLAUDE_CODE_OAUTH_TOKEN:'fake-env-token',claude_code_oauth_token:'fake-env-token-2',ANTHROPIC_API_KEY:'fake-api-key',ANTHROPIC_BASE_URL:'https://gateway.invalid',CLAUDECODE:'1',Claude_Config_Dir:'relative/elsewhere'};
 const result=await b.usage({},{env});
 assert.equal(result.status,'ok');assert.equal(result.windows[0].usedPercent,23);
 assert.equal(b.launches.length,1);assert.deepEqual(b.fetches,['Bearer fake-renewed-access'],'the stale pass is never sent; the renewed one is read from the file');
 const {command,args,options,child}=b.launches[0];
 assert.equal(command,'C:\\fake\\claude.exe');assert.deepEqual(args,b.signin.renewalArgs('haiku'));
 for(const flag of ['--print','--no-session-persistence','--tools','--strict-mcp-config','--setting-sources','--safe-mode','--disable-slash-commands'])assert.ok(args.includes(flag),flag);
 assert.equal(args[args.indexOf('--tools')+1],'');assert.equal(args[args.indexOf('--setting-sources')+1],'');assert.equal(args[args.indexOf('--mcp-config')+1],'{"mcpServers":{}}');
 assert.equal(child.prompt,'OK?');assert.doesNotMatch(JSON.stringify(args),/fake-/);
 assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.equal(options.cwd,os.tmpdir());assert.equal(options.detached,process.platform!=='win32');assert.deepEqual(options.stdio,['pipe','pipe','pipe']);
 const names=Object.keys(options.env).map(name=>name.toUpperCase());
 for(const gone of ['CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDECODE'])assert.equal(names.includes(gone),false,gone);
 assert.equal(names.filter(name=>name==='CLAUDE_CONFIG_DIR').length,1);assert.equal(options.env.CLAUDE_CONFIG_DIR,path.resolve(b.dir));assert.ok(path.isAbsolute(options.env.CLAUDE_CONFIG_DIR));
 assert.equal(options.env.MAX_THINKING_TOKENS,'0');
 assert.equal(b.tracked.length,1,'the child is owned work');assert.deepEqual(b.signin.claudeSignInState(),{renewing:false,closed:false,failures:0,nextAttempt:0});
 assert.doesNotMatch(JSON.stringify(result),/fake-/);
});

test('a relative CLAUDE_CONFIG_DIR is resolved once, for the reader and the CLI alike',async t=>{
 const b=await bench(t),cwd=process.cwd(),relative=path.relative(cwd,b.dir);
 if(path.isAbsolute(relative))return t.skip('temp folder is on another drive');
 process.env.CLAUDE_CONFIG_DIR=relative;b.write(stale());
 assert.equal((await b.usage()).status,'ok');assert.equal(b.launches[0].options.env.CLAUDE_CONFIG_DIR,path.resolve(b.dir));
});

test('nothing is launched for a sign-in that is gone, a valid pass, a denial, a rate limit or a network failure',async t=>{
 let code=200;const b=await bench(t,{status:()=>code});
 b.write({...stale(),refreshToken:undefined});assert.match((await b.usage()).message,/sign in again/);
 b.write({...stale(),refreshTokenExpiresAt:Date.now()-1});assert.match((await b.usage()).message,/sign in again/);
 b.write(fresh('fake-valid'));assert.equal((await b.usage()).status,'ok');
 for(const [next,name,expected] of [[403,'fake-denied',/denied access/],[429,'fake-limited',/could not be refreshed/],['network','fake-offline',/could not be refreshed/]]){
  code=next;b.write(fresh(name));assert.match((await b.usage()).message,expected,String(next));
 }
 fs.rmSync(b.file);assert.match((await b.usage()).message,/Sign in to Claude Code/);
 assert.equal(b.launches.length,0);
});

test('a rejected pass (401) gets one renewal, one re-read and one retry, never a second round',async t=>{
 const b=await bench(t,{status:(n,token)=>token==='Bearer fake-good'?200:401});
 b.write({accessToken:'fake-rejected',refreshToken:'fake-refresh'});b.cli.onLaunch=child=>{b.write(fresh('fake-good'));child.finish(0)};
 assert.equal((await b.usage()).status,'ok');assert.deepEqual(b.fetches,['Bearer fake-rejected','Bearer fake-good']);assert.equal(b.launches.length,1);
 // The renewed pass is rejected as well: the answer is the message, with no further launch or fetch in that call.
 const c=await bench(t,{status:()=>401});
 c.write({accessToken:'fake-rejected',refreshToken:'fake-refresh'});c.cli.onLaunch=child=>{c.write(fresh('fake-also-rejected'));child.finish(0)};
 const result=await c.usage();assert.match(result.message,/refresh its sign-in/);assert.equal(c.fetches.length,2);assert.equal(c.launches.length,1);
 // A 401 without a renewal pass launches nothing.
 const d=await bench(t,{status:()=>401});d.write({accessToken:'fake-rejected-no-refresh'});
 assert.match((await d.usage()).message,/sign in again/);assert.equal(d.launches.length,0);
});

test('three meter reads at once share one renewal and all get the renewed reading',async t=>{
 const b=await bench(t);b.write(stale());b.cli.onLaunch=child=>setTimeout(()=>{b.write(fresh());child.finish(0)},30);
 const results=await Promise.all([b.usage(),b.usage(),b.usage()]);
 assert.deepEqual(results.map(result=>result.status),['ok','ok','ok']);assert.equal(b.launches.length,1);assert.equal(b.fetches.length,1,'one shared usage read');
});

test('success is a renewed credentials file, never an exit status',async t=>{
 const b=await bench(t);b.write(stale());b.cli.onLaunch=child=>child.finish(0);
 assert.match((await b.usage()).message,/refresh its sign-in/);assert.equal(b.signin.claudeSignInState().failures,1,'exit 0 with an unchanged file is a failure');
 assert.match((await b.usage()).message,/refresh its sign-in/);assert.equal(b.launches.length,1,'and the next read inside the backoff launches nothing');
 const c=await bench(t);c.write(stale());c.cli.onLaunch=child=>{c.write(fresh());child.finish(1)};
 assert.equal((await c.usage()).status,'ok','a renewed file counts even when the CLI exits non-zero');assert.equal(c.signin.claudeSignInState().failures,0);
 // A file that is unreadable after the renewal is answered like a missing sign-in, without throwing.
 const d=await bench(t);d.write(stale());d.cli.onLaunch=child=>{d.write('{ not json');child.finish(0)};
 assert.match((await d.usage()).message,/Sign in to Claude Code/);assert.equal(d.signin.claudeSignInState().failures,1);
});

test('failures back off 10 min, 30 min, 2 h, then 8 h; a changed sign-in starts over; a CLI that cannot start counts',async t=>{
 const b=await bench(t);let now=0;b.cli.onLaunch=child=>child.finish(0);
 const attempt=async(identity='same')=>{const flight=b.signin.renewClaudeSignIn({...b.options,identity,clock:()=>now,verify:async()=>false});if(flight)await flight;return !!flight};
 const launchedAt=[];
 for(const minute of [0,9,10,39,40,159,160,160+479,160+480,160+480+479,160+960]){now=minute*MIN;if(await attempt())launchedAt.push(minute)}
 assert.deepEqual(launchedAt,[0,10,40,160,640,1120]);
 assert.equal(await attempt('another sign-in'),true,'a new identity is attempted at once');
 const c=await bench(t);now=0;
 assert.equal(c.signin.renewClaudeSignIn({...c.options,identity:'x',clock:()=>now,find:()=>{throw new Error('not installed')}}),null);
 assert.equal(c.signin.renewClaudeSignIn({...c.options,identity:'x',clock:()=>now}),null,'not retried on the next read');assert.equal(c.launches.length,0);
 now=10*MIN;assert.ok(c.signin.renewClaudeSignIn({...c.options,identity:'x',clock:()=>now,launch:()=>{throw new Error('spawn failed')}})===null);
 assert.equal(c.signin.claudeSignInState().failures,2);
});

test('another CLI renews the file while ours is still running: success, and no second launch',async t=>{
 const b=await bench(t);b.write(stale());let child;b.cli.onLaunch=value=>{child=value};
 const reading=b.usage();await tick(20);b.write(fresh('fake-renewed-elsewhere'));
 const joined=b.usage({wait:false});child.finish(0);
 assert.equal((await reading).status,'ok');await joined;assert.equal(b.launches.length,1);assert.equal(b.signin.claudeSignInState().failures,0);
});

test('a caller waits only as long as its own patience; the renewal carries on and is never cancelled by a caller',async t=>{
 const b=await bench(t);b.write(stale());let child;b.cli.onLaunch=value=>{child=value};
 let started=performance.now();const slow=await b.usage({renewWaitMs:40});
 assert.match(slow.message,/refresh its sign-in/);assert.ok(performance.now()-started<4000);assert.equal(b.signin.claudeSignInState().renewing,true);
 const gone=new AbortController();let joined=false;
 // Cancel once this caller has joined the renewal, after its asynchronous sign-in read.
 const renew=given=>{const flight=b.renew()(given);assert.ok(flight,'the caller joins the shared renewal');joined=true;started=performance.now();queueMicrotask(()=>gone.abort());return flight};
 assert.match((await b.usage({signal:gone.signal,renew})).message,/refresh its sign-in/);assert.equal(joined,true);assert.ok(performance.now()-started<1000,'an aborted caller stops waiting');
 assert.equal(b.stops.length,0,'and the shared renewal was not stopped');assert.equal(b.launches.length,1);
 b.write(fresh());child.finish(0);await tick(20);
 assert.equal((await b.usage()).status,'ok','the next read picks the renewed pass up');assert.equal(b.launches.length,1);
});

test('voice (wait:false) starts or joins the renewal and answers at once',async t=>{
 const b=await bench(t);b.write(stale());let child;b.cli.onLaunch=value=>{child=value};
 const started=performance.now(),first=await b.usage({wait:false}),second=await b.usage({wait:false});
 assert.ok(performance.now()-started<4000);assert.match(first.message,/refresh its sign-in/);assert.match(second.message,/refresh its sign-in/);assert.equal(b.launches.length,1);
 child.finish(0);await tick(10);
 // A waiting caller's 401 started the renewal; a voice caller arriving meanwhile joins it.
 const c=await bench(t,{status:(n,token)=>token==='Bearer fake-good'?200:401});c.write({accessToken:'fake-rejected',refreshToken:'fake-refresh'});let open;c.cli.onLaunch=value=>{open=value};
 const meter=c.usage();await tick(30);assert.equal(c.launches.length,1);
 assert.match((await c.usage({wait:false})).message,/refresh its sign-in/);assert.equal(c.launches.length,1,'no second launch');
 c.write(fresh('fake-good'));open.finish(0);assert.equal((await meter).status,'ok');
});

test('a slow rejection still ends inside the overall budget: the retry only gets what is left, and under a second left starts nothing',async t=>{
 const b=await bench(t,{status:(n,token)=>token==='Bearer fake-good'?200:401,delay:n=>n===1?150:0});
 b.write({accessToken:'fake-rejected',refreshToken:'fake-refresh'});b.cli.onLaunch=child=>setTimeout(()=>{b.write(fresh('fake-good'));child.finish(0)},40);
 let started=performance.now();assert.equal((await b.usage({budgetMs:5000})).status,'ok');assert.ok(performance.now()-started<2000);assert.equal(b.fetches.length,2);
 const c=await bench(t,{status:()=>401,delay:n=>n===1?300:0});
 c.write({accessToken:'fake-rejected',refreshToken:'fake-refresh'});c.cli.onLaunch=child=>setTimeout(()=>{c.write(fresh('fake-good'));child.finish(0)},40);
 started=performance.now();const result=await c.usage({budgetMs:1200});
 assert.match(result.message,/refresh its sign-in/);assert.equal(c.fetches.length,1,'with under a second left no retry is started');assert.equal(c.launches.length,0,'and no renewal either');assert.ok(performance.now()-started<1200+500);
 // The usage read itself outlasting the budget: the caller is answered, the shared read is left to finish.
 const d=await bench(t,{delay:()=>400});d.write(fresh('fake-valid'));
 started=performance.now();assert.match((await d.usage({budgetMs:100})).message,/taking longer than usual/);assert.ok(performance.now()-started<350);await tick(450);
 assert.equal((await d.usage()).status,'ok');assert.equal(d.fetches.length,1);
});

test('inspection round 1: a caller that is already gone starts nothing, for a stale pass and for a rejected one',async t=>{
 const gone=new AbortController();gone.abort();
 const b=await bench(t);b.write(stale());
 assert.match((await b.usage({signal:gone.signal})).message,/taking longer than usual/);assert.match((await b.usage({signal:gone.signal,wait:false})).message,/taking longer than usual/);
 const c=await bench(t,{status:()=>401});c.write({accessToken:'fake-rejected',refreshToken:'fake-refresh'});
 // Cancelled while the first read is under way: the rejection arrives for nobody, so nothing is renewed.
 const leaving=new AbortController();setTimeout(()=>leaving.abort(),20);
 const d=await bench(t,{status:()=>401,delay:()=>80});d.write({accessToken:'fake-rejected',refreshToken:'fake-refresh'});
 await c.usage({signal:gone.signal});await d.usage({signal:leaving.signal});await tick(120);
 assert.equal(b.launches.length+c.launches.length+d.launches.length,0);assert.equal(b.fetches.length+c.fetches.length,0,'and no usage read is started for a caller that is gone');
});

test('inspection round 1: a slow RETRY gets only what is left of the budget',async t=>{
 const b=await bench(t,{status:(n,token)=>token==='Bearer fake-good'?200:401,delay:n=>n===2?2500:0});
 b.write({accessToken:'fake-rejected',refreshToken:'fake-refresh'});b.cli.onLaunch=child=>{b.write(fresh('fake-good'));child.finish(0)};
 const started=performance.now(),result=await b.usage({budgetMs:1500});
 assert.match(result.message,/taking longer than usual/);assert.ok(performance.now()-started<1500+400,'answered inside the budget');assert.equal(b.fetches.length,2);assert.equal(b.launches.length,1);
 await tick(1200);assert.equal((await b.usage()).status,'ok','the shared read was left to finish and its reading is kept');assert.equal(b.fetches.length,2);
});

test('inspection round 1: a stalled credentials read cannot outlast the budget or a cancellation',async t=>{
 const b=await bench(t);b.write(stale());let reads=0;
 const {getClaudeUsage}=b;const stalled=()=>{reads++;return new Promise(resolve=>setTimeout(()=>resolve(null),3000).unref())};
 let started=performance.now();assert.match((await getClaudeUsage({read:stalled,budgetMs:150,renew:b.renew()})).message,/taking longer than usual/);assert.ok(performance.now()-started<4000);
 const gone=new AbortController();setTimeout(()=>gone.abort(),40);started=performance.now();
 assert.match((await getClaudeUsage({read:stalled,signal:gone.signal,renew:b.renew()})).message,/taking longer than usual/);assert.ok(performance.now()-started<4000,'cancellation is not held by the disk');
 // The re-read after a renewal is bounded the same way.
 const c=await bench(t);c.write(stale());let calls=0;
 const first=async()=>{calls++;if(calls===1){const auth=JSON.parse(fs.readFileSync(c.file,'utf8')).claudeAiOauth;return {token:auth.accessToken,expired:true,refreshable:true,key:'stale-key'}}return new Promise(resolve=>setTimeout(()=>resolve(null),3000).unref())};
 started=performance.now();assert.match((await c.getClaudeUsage({read:first,budgetMs:1300,renew:c.renew({verify:undefined})})).message,/taking longer than usual/);
 assert.ok(performance.now()-started<1300+400);assert.equal(c.launches.length,1);assert.ok(calls>=2,'the re-read after the renewal was attempted and bounded');assert.ok(reads>=2);
});

test('inspection round 1: a root that exits while its pipes stay held still closes, so ownership is released',async t=>{
 const b=await bench(t);b.cli.onLaunch=()=>{};
 const flight=b.signin.renewClaudeSignIn({...b.options,identity:'x',closeGraceMs:30}),child=b.launches[0].child;
 let open=3;for(const name of ['stdin','stdout','stderr'])child[name].destroy=()=>{if(--open===0)child.emit('close',0)};
 let owned=true;b.tracked[0].promise.then(()=>{owned=false});
 child.exitCode=0;child.emit('exit',0);await tick(10);assert.equal(owned,true,'exit alone is not close');assert.equal(b.signin.claudeSignInState().renewing,true);
 await tick(60);assert.deepEqual(await flight,{ok:false});assert.equal(owned,false);assert.equal(b.signin.claudeSignInState().renewing,false);
});

test('the deadline stops the process tree; ownership and exclusion last until the process really closes',async t=>{
 const b=await bench(t);let child;b.cli.onLaunch=value=>{child=value};
 const flight=b.signin.renewClaudeSignIn({...b.options,identity:'x',deadlineMs:30,verify:async()=>false});
 let owned=true;b.tracked[0].promise.then(()=>{owned=false});
 await tick(80);assert.deepEqual(b.stops,[child],'stopped through the process-tree helper');
 assert.equal(owned,true,'killed but not closed: still owned');assert.equal(b.signin.claudeSignInState().renewing,true);
 assert.equal(b.signin.renewClaudeSignIn({...b.options,identity:'x'}),flight,'and still exclusive: a new request joins, nothing launches');assert.equal(b.launches.length,1);
 child.finish(null);assert.deepEqual(await flight,{ok:false});await tick();
 assert.equal(owned,false,'a late close releases ownership');assert.equal(b.signin.claudeSignInState().renewing,false);
});

test('a running renewal is real owned work for shutdown accounting, and aborting it stops the tree',async t=>{
 const b=await bench(t);b.cli.onLaunch=()=>{};const before=classifierProcesses().total;
 const flight=b.signin.renewClaudeSignIn({...b.options,identity:'x',track:trackOwnedWork}),child=b.launches[0].child;
 assert.equal(classifierProcesses().total,before+1);
 b.signin.closeClaudeSignIn();assert.deepEqual(b.stops,[child],'shutdown aborts the renewal');
 child.finish(null);await flight;await tick();assert.equal(classifierProcesses().total,before);
});

test('nothing is launched once shutdown has begun, even when it begins between the first look and the launch',async t=>{
 const b=await bench(t);b.write(stale());
 let looks=0;assert.equal(b.signin.renewClaudeSignIn({...b.options,identity:'x',draining:()=>++looks>1}),null,'drain began after the first check');assert.equal(looks,2);
 assert.equal(b.signin.renewClaudeSignIn({...b.options,identity:'y',draining:()=>true}),null);
 b.signin.closeClaudeSignIn();
 assert.equal(b.signin.renewClaudeSignIn({...b.options,identity:'z'}),null);assert.match((await b.usage()).message,/refresh its sign-in/);assert.equal(b.launches.length,0);
 assert.equal(b.signin.claudeSignInState().closed,true);
});

test('off switch, and off under the test runner unless a launcher is injected',async t=>{
 const b=await bench(t);b.write(stale());
 assert.equal(b.signin.renewClaudeSignIn({...b.options,identity:'x',env:{AOS_CLAUDE_SIGNIN_RENEWAL:'OFF'}}),null);
 const {launch,...withoutLauncher}=b.options;assert.ok(process.env.NODE_TEST_CONTEXT);
 assert.equal(b.signin.renewClaudeSignIn({...withoutLauncher,identity:'x'}),null);
 assert.match((await b.getClaudeUsage()).message,/refresh its sign-in/,'the default meter launches nothing in tests');assert.equal(b.launches.length,0);
});

test('the bridge closes renewals only after /shutdown passed its own guard, and on a signal; voice never waits',()=>{
 const bridge=fs.readFileSync(new URL('../runner/bridge.mjs',import.meta.url),'utf8'),router=fs.readFileSync(new URL('../runner/voice-router.mjs',import.meta.url),'utf8');
 const handler=bridge.slice(bridge.indexOf("url.pathname==='/shutdown'")),guard=handler.indexOf('},409)'),latch=handler.indexOf('closeClaudeSignIn()');
 assert.ok(guard>0&&latch>guard,'a refused shutdown must not disable later renewals');
 assert.match(bridge,/lifecycle\?\.stop\(signal\);closeClaudeSignIn\(\);/);
 assert.match(bridge,/claudeUsageReading\(\{signal:gone\.signal,getUsage:getClaudeUsage\}\)/); // forwards the signal: tests/claude-login-notice.test.mjs
 assert.match(router,/usage\[provider\]\(\{wait:false,signal\}\)/);
});
