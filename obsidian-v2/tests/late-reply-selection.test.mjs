import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {routeVoice} from '../runner/bridge-core.mjs';
import {reconcileCurrent,setCurrent,readCurrentState,readConversationEpoch} from '../runner/current-conversations.mjs';

// A conversation the user selects while a spoken request is still being
// dispatched must remain selected. The late reply may open its task, but it
// must not move the automatic voice destination back or onto its new task.
const chosen={provider:'codex',model:'gpt-6-astra'};
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aos-late-reply-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'.agentic-os-v2-test-vault'),'agentic-os-v2-only');
 for(const d of ['queue','processing','runs','logs','voice-results','voice-requests','voice-cancelled'])fs.mkdirSync(path.join(dir,'system/v2',d),{recursive:true});
 const root=path.resolve(fs.realpathSync(dir)),records=new Map(),now=Date.now();
 const task=(overrides={})=>{const r={id:crypto.randomUUID(),provider:'codex',model:'gpt-6-astra',state:'ready',created:now-60000,lastActivityAt:now-1000,conversationActivityAt:now-1000,turns:[{id:'t1',ts:now-1000,text:'earlier answer'}],...overrides};records.set(r.id,r);return r};
 const terminals={records,live:new Map(),get(id){const r=records.get(id);if(!r)throw new Error('Task not found');return r},list(){return [...records.values()]},sent:[],
  start(spec){const r={id:spec.id,provider:spec.selection.provider,model:spec.selection.model,state:'starting',created:Date.now(),lastActivityAt:Date.now(),conversationActivityAt:Date.now(),turns:[],prompt:spec.prompt,title:spec.title};records.set(r.id,r);terminals.onStart?.(r);return r},
  send(id,text,options){terminals.sent.push({id,text,options});terminals.onSend?.(id);return records.get(id)},
  startWorkflow(){throw new Error('not expected')},continueWorkflow(){throw new Error('not expected')}};
 reconcileCurrent(root,terminals,{scope:'web',sessionId:crypto.randomUUID()});
 const select=(id)=>setCurrent(root,terminals,{provider:'codex',id,scope:'web'});
 const route=(transcript,workTarget=null)=>routeVoice(root,{id:crypto.randomUUID(),transcript,selection:chosen,terminalMode:true,workTarget,conversationEpoch:readConversationEpoch(root,'codex','web'),appScope:'web'},undefined,async()=>{throw new Error('The rules path must not call a model here.')},terminals,{resolveCli:()=>({command:'codex'}),updateCurrent:change=>setCurrent(root,terminals,{...change,scope:'web'})});
 return {root,terminals,task,select,route,current:()=>readCurrentState(root,'web').codex};
}
const request='Research the history of the Apollo program and write me a short summary.';

test('a new task dispatched by a late reply does not replace a conversation chosen during the request',async t=>{
 const f=fixture(t),other=f.task();let created=null;
 f.terminals.onStart=r=>{created=r;f.select(other.id)};
 const response=await f.route(request);
 assert.deepEqual(response.workIds,[created.id]);
 assert.equal(response.conversationSuperseded,undefined);
 assert.equal(f.current(),other.id);
});

test('a continuation sent to the old conversation does not move the selection back after the user chose another one',async t=>{
 const f=fixture(t),old=f.task(),other=f.task();f.select(old.id);
 f.terminals.onSend=()=>f.select(other.id);
 const response=await f.route(request,old.id);
 assert.deepEqual(response.workIds,[old.id]);
 assert.equal(f.terminals.sent.length,1);
 assert.equal(f.current(),other.id);
});

test('without an intervening choice the dispatched task still becomes the current conversation',async t=>{
 const f=fixture(t);f.task();
 const response=await f.route(request);
 assert.equal(f.current(),response.workIds[0]);
});

test('an explicit spoken new task still selects itself even if another conversation was clicked meanwhile',async t=>{
 const f=fixture(t),other=f.task();let created=null;
 f.terminals.onStart=r=>{created=r;f.select(other.id)};
 const response=await f.route('Start a new task: '+request);
 assert.deepEqual(response.workIds,[created.id]);
 assert.equal(f.current(),created.id);
});
