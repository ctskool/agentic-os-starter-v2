import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {warmCli,warmOnWake,resetCliWarmup,helperSource,WARM_WINDOW_MS,WARM_HELPER_LIMIT_MS} from '../runner/cli-warmup.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
function launcher(){
 const calls=[];
 const launch=(command,args,options)=>{const child=new EventEmitter();child.unref=()=>{child.unrefed=true};calls.push({command,args,options,child});return child};
 return {calls,launch};
}
const cli={command:'C:\\Program Files\\Codex & Co $(whoami) "x"\\codex.exe',prefix:[]};

test('nothing is started under the test runner unless the environment is injected',()=>{
 resetCliWarmup();const l=launcher();
 assert.equal(warmCli({launch:l.launch,find:()=>cli}),false);assert.equal(l.calls.length,0);
});

test('one detached, hidden, unreferenced node helper with fixed source; the CLI path travels as data',()=>{
 resetCliWarmup();const l=launcher();
 assert.equal(warmCli({env:{},now:0,launch:l.launch,find:provider=>{assert.equal(provider,'codex');return cli}}),true);
 assert.equal(l.calls.length,1);const {command,args,options,child}=l.calls[0];
 assert.equal(command,process.execPath);assert.equal(args[0],'-e');assert.equal(args[1],helperSource());assert.equal(args.length,3);
 assert.deepEqual(JSON.parse(args[2]),[cli.command]);
 assert.ok(!args[1].includes('Codex & Co')&&!args[1].includes('whoami'),'nothing about the CLI is interpolated into the source');
 assert.deepEqual(options,{detached:true,stdio:'ignore',windowsHide:true,shell:false});assert.equal(child.unrefed,true);
 assert.equal(child.listenerCount('error'),1);child.emit('error',new Error('ENOENT'));                 // swallowed
 assert.match(helperSource(),/windowsHide:true/);assert.match(helperSource(),/shell:false/);assert.match(helperSource(),new RegExp(String(WARM_HELPER_LIMIT_MS)));
});

test('at most once per window, and a failure uses up the window too',()=>{
 resetCliWarmup();const l=launcher(),go=now=>warmCli({env:{},now,launch:l.launch,find:()=>cli});
 assert.equal(go(1000),true);assert.equal(go(1000+WARM_WINDOW_MS-1),false);assert.equal(go(1000+WARM_WINDOW_MS),true);assert.equal(l.calls.length,2);
 resetCliWarmup();let attempts=0;const broken=now=>warmCli({env:{},now,launch:()=>{attempts++;throw new Error('spawn failed')},find:()=>cli});
 assert.equal(broken(0),false);assert.equal(broken(5000),false);assert.equal(attempts,1);
 resetCliWarmup();assert.equal(warmCli({env:{},now:0,launch:l.launch,find:()=>{throw new Error('codex CLI not installed')}}),false);
 assert.equal(warmCli({env:{},now:10,launch:l.launch,find:()=>cli}),false,'the failed lookup used the window');
 resetCliWarmup();assert.equal(warmCli({env:{},now:0,launch:l.launch,find:()=>null}),false);
 // A wrapper resolution (node + codex.js) is skipped: its native grandchild would not be owned by the helper.
 resetCliWarmup();const before=l.calls.length;assert.equal(warmCli({env:{},now:0,launch:l.launch,find:()=>({command:process.execPath,prefix:['C:\\npm\\codex.js']})}),false);assert.equal(l.calls.length,before);
});

test('the real helper runs the CLI with --version, and kills a hanging one at its deadline',{timeout:60000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cli-warmup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const quick=path.join(dir,'quick.cjs'),hang=path.join(dir,'hang.cjs'),seen=path.join(dir,'seen.json'),pidFile=path.join(dir,'pid.txt');
 fs.writeFileSync(quick,`require('fs').writeFileSync(${JSON.stringify(seen)},JSON.stringify(process.argv.slice(2)))`);
 fs.writeFileSync(hang,`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},60000)`);
 const run=(script,limitMs)=>new Promise(resolve=>{const started=Date.now(),child=spawn(process.execPath,['-e',helperSource(limitMs),JSON.stringify([process.execPath,script])],{stdio:'ignore',windowsHide:true,shell:false});child.on('close',()=>resolve(Date.now()-started))});
 const fast=await run(quick,5000);
 assert.deepEqual(JSON.parse(fs.readFileSync(seen,'utf8')),['--version']);assert.ok(fast<4000,`the helper ended with its child after ${fast} ms`);
 // A generous deadline: the hanging child must have had time to start and write its pid even on a loaded machine.
 const slow=await run(hang,4000);
 assert.ok(slow>=3500&&slow<20000,`the helper ended after ${slow} ms`);
 assert.ok(fs.existsSync(pidFile),'the hanging child had started before the deadline');
 const pid=Number(fs.readFileSync(pidFile,'utf8'));
 for(let i=0;i<40&&alive(pid);i++)await wait(50);
 assert.equal(alive(pid),false,'the hanging child was killed');
 // Garbage instead of the argument: the helper just exits.
 const garbage=await new Promise(resolve=>{const child=spawn(process.execPath,['-e',helperSource(5000),'not json'],{stdio:'ignore',windowsHide:true});child.on('close',resolve)});
 assert.equal(garbage,0);
});

test('only a wake event warms; transcripts, timeouts, errors and junk do not',()=>{
 resetCliWarmup();const l=launcher(),options={env:{},now:0,launch:l.launch,find:()=>cli};
 for(const message of [{type:'transcript',text:'make a guide'},{type:'wake_timeout'},{type:'wake_error'},{type:'owner'},{},null,undefined,'wake',{type:'WAKE'}])assert.equal(warmOnWake(message,options),false);
 assert.equal(l.calls.length,0);
 assert.equal(warmOnWake({type:'wake'},options),true);assert.equal(l.calls.length,1);
});
