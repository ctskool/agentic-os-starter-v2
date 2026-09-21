import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {createCodexDeliveryWatch} from '../runner/terminal-delivery.mjs';
const session='01a09b1a-fb81-7433-a9d7-d8333de6cbe0';
const user=text=>JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}})+'\n';
function fixture(t,initial=''){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'aos-delivery-'));
 const created=Number.parseInt(session.replaceAll('-','').slice(0,12),16),folder=path.join(home,'sessions',new Date(created).toISOString().slice(0,10).replaceAll('-',path.sep));
 fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,`rollout-test-${session}.jsonl`);fs.writeFileSync(file,initial);
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));return {home,file,append:text=>fs.appendFileSync(file,text)};
}
test('delivery watches new exact user receipts, never historical matching text or start/output events',t=>{
 const f=fixture(t,user('Change the robot')),watch=createCodexDeliveryWatch(session,'Change the robot',{home:f.home});
 assert.equal(watch.poll(),false);
 for(const row of [{type:'event_msg',payload:{type:'task_started',turn_id:'new'}},{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'input_text',text:'Change the robot'}]}}])f.append(JSON.stringify(row)+'\n');
 f.append(user('Change a different image'));assert.equal(watch.poll(),false);
 f.append(user('Change the robot'));assert.equal(watch.poll(),true);assert.equal(watch.poll(),true);
});
test('fragmented UTF-8 receipts preserve full request identity and normalized Windows line endings',t=>{
 const f=fixture(t),watch=createCodexDeliveryWatch(session,'Edit 🌌\r\nKeep the labels',{home:f.home});
 const data=Buffer.from(user('Edit 🌌\nKeep the labels')),cut=data.indexOf(Buffer.from('🌌'))+2;
 f.append(data.subarray(0,cut));assert.equal(watch.poll(),false);f.append(data.subarray(cut));assert.equal(watch.poll(),true);
});
test('an existing partial line cannot acknowledge a new paste',t=>{
 const line=user('Edit it'),cut=line.length-5,f=fixture(t,line.slice(0,cut)),watch=createCodexDeliveryWatch(session,'Edit it',{home:f.home});
 f.append(line.slice(cut));assert.equal(watch.poll(),false);f.append(line);assert.equal(watch.poll(),true);
});
test('oversized appended output is skipped in bounded passes without losing the next user receipt',t=>{
 const f=fixture(t),watch=createCodexDeliveryWatch(session,'Next request',{home:f.home});
 f.append(JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:'x'.repeat(600000)}})+'\n'+user('Next request'));
 assert.equal(watch.poll(),false);assert.equal(watch.poll(),false);assert.equal(watch.poll(),true);
});
test('missing, replaced, truncated and closed logs never claim acceptance',t=>{
 assert.equal(createCodexDeliveryWatch(session,'Request',{home:path.join(os.tmpdir(),'aos-delivery-missing')}).poll(),false);
 const f=fixture(t,'original-record\n'),watch=createCodexDeliveryWatch(session,'Request',{home:f.home});fs.truncateSync(f.file,0);assert.equal(watch.poll(),false);f.append(user('Request'));assert.equal(watch.poll(),false);
 const other=createCodexDeliveryWatch(session,'Other',{home:f.home});other.close();f.append(user('Other'));assert.equal(other.poll(),false);
 const replacement=createCodexDeliveryWatch(session,'Replacement',{home:f.home});fs.renameSync(f.file,f.file+'.old');fs.writeFileSync(f.file,user('Replacement'));assert.equal(replacement.poll(),false);
});
test('event_msg user_message receipts are also accepted but only after the watch begins',t=>{
 const f=fixture(t),watch=createCodexDeliveryWatch(session,'Actual request',{home:f.home});
 f.append(JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'Actual request'}})+'\n');assert.equal(watch.poll(),true);
});
