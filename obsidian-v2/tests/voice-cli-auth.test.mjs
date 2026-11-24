import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import crypto from 'node:crypto';
import {classifierEnv,commandFor} from '../runner/adapters.mjs';
import {terminalSpec} from '../runner/terminals.mjs';

test('restricted Claude inherits sign-in storage, not incidental API or cloud-provider credentials',()=>{
 const inherited={PATH:'path',HOME:'home',USERPROFILE:'user',CLAUDE_CONFIG_DIR:'config',CLAUDE_CODE_OAUTH_TOKEN:'existing-subscription-token',ANTHROPIC_API_KEY:'incidental-key',anthropic_auth_token:'proxy-token',Anthropic_Base_Url:'proxy',CLAUDE_CODE_USE_BEDROCK:'1',CLAUDE_CODE_USE_VERTEX:'1',CLAUDE_CODE_USE_FOUNDRY:'1',CLAUDE_CODE_SIMPLE:'1',CLAUDECODE:'parent-session'};
 const before={...inherited},env=classifierEnv({provider:'claude',model:'haiku'},inherited);
 assert.deepEqual(env,{PATH:'path',HOME:'home',USERPROFILE:'user',CLAUDE_CONFIG_DIR:'config',CLAUDE_CODE_OAUTH_TOKEN:'existing-subscription-token',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_TERMINAL_TITLE:'1',MAX_THINKING_TOKENS:'0',CLAUDE_CODE_MAX_OUTPUT_TOKENS:'1200'});
 assert.deepEqual(inherited,before,'Parent process environment must not change');
 assert.deepEqual(classifierEnv({provider:'claude',skill:'review',restricted:true},inherited),env);
 const workerEnv=classifierEnv({provider:'claude',skill:'review'},inherited);
 assert.equal(workerEnv.CLAUDE_CODE_OAUTH_TOKEN,inherited.CLAUDE_CODE_OAUTH_TOKEN);assert.equal(workerEnv.CLAUDE_CONFIG_DIR,'config');
 assert.equal(workerEnv.ANTHROPIC_API_KEY,undefined);assert.equal(workerEnv.CLAUDECODE,undefined);
 assert.equal(workerEnv.MAX_THINKING_TOKENS,undefined);assert.equal(workerEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS,undefined);
 assert.deepEqual(classifierEnv({provider:'codex'},inherited),inherited,'Codex auth is unchanged');
});
test('Haiku classifier is nonpersistent, tool-free and customization-free without disabling OAuth',()=>{
 const args=commandFor(os.tmpdir(),{id:crypto.randomUUID(),provider:'claude',model:'haiku'},{command:'claude',prefix:[]}).args;
 for(const flag of ['--print','--safe-mode','--disable-slash-commands','--strict-mcp-config','--no-session-persistence'])assert.ok(args.includes(flag),flag);
 assert.equal(args[args.indexOf('--model')+1],'haiku');
 assert.equal(args[args.indexOf('--tools')+1],'');
 assert.deepEqual(JSON.parse(args[args.indexOf('--mcp-config')+1]),{mcpServers:{}});
 assert.equal(args[args.indexOf('--setting-sources')+1],'');
 assert.match(args[args.indexOf('--system-prompt')+1],/classifier process has no execution tools/i);
 assert.ok(!args.includes('--bare'),'Bare mode requires API authentication');
 assert.equal(args[args.indexOf('--effort')+1],'low','The voice classifier answers at low effort (MAX_THINKING_TOKENS alone does not stop Haiku thinking)');
 const worker=commandFor(os.tmpdir(),{id:crypto.randomUUID(),provider:'claude',model:'sonnet',skill:'review'},{command:'claude',prefix:[]}).args;
 assert.ok(!worker.includes('--safe-mode'));assert.ok(!worker.includes('--disable-slash-commands'));
 // Full workers run at medium effort whatever the person's own default is (Chase, 2026-11-24: at high, Opus thought
 // for a minute and a half before starting a one-page explainer). Interactive terminals get the same setting.
 assert.equal(worker[worker.indexOf('--effort')+1],'medium');assert.equal(worker.filter(arg=>arg==='--effort').length,1);
 const record={id:crypto.randomUUID(),provider:'claude',model:'opus',prompt:'Make a one-pager'};
 for(const terminal of [terminalSpec(os.tmpdir(),record,{command:'claude',prefix:[]}).args,terminalSpec(os.tmpdir(),{...record,sessionId:record.id},{command:'claude',prefix:[]},{resumePrompt:'Make it shorter'}).args]){
  assert.equal(terminal[terminal.indexOf('--effort')+1],'medium');assert.equal(terminal[terminal.indexOf('--model')+1],'opus');
 }
});
