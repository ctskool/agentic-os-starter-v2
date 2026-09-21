// Completion data travels separately from ANSI terminal output. Never evaluate it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {artifactHandoffInstructions} from './artifact-instructions.mjs';
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const normalized=text=>String(text||'').replace(/\r\n?/g,'\n').trim();
function unlinked(file,root){
 const base=fs.realpathSync(root),absolute=path.resolve(file),relative=path.relative(base,absolute);
 if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Invalid hook path');
 for(let cursor=absolute;cursor!==base;cursor=path.dirname(cursor))if(fs.lstatSync(cursor).isSymbolicLink())throw new Error('Linked hook path');
 if(fs.realpathSync(absolute)!==absolute)throw new Error('Linked hook path');return absolute;
}
function readMeta(file){if(fs.statSync(file).size>4096)throw new Error('Invalid request metadata');return JSON.parse(fs.readFileSync(file,'utf8'))}
function writeMeta(file,value){const temporary=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value),{flag:'wx'});fs.renameSync(temporary,file)}
function acceptNativeClaudePrompt(dir,data,instance,receipt){
 const activeFile=path.join(dir,'active-request.meta'),active=readMeta(activeFile),taskId=process.env.AOS_NATIVE_TASK_ID;
 if(!uuid(taskId)||active.taskId!==taskId||!uuid(active.requestKey)||typeof active.vault!=='string'||active.events!==path.resolve(dir)||(active.nativeInstance&&active.nativeInstance!==instance))throw new Error('Invalid native request identity');
 const sessionId=process.env.AOS_WORK_SESSION||taskId;
 if(!uuid(sessionId)||data.session_id!==sessionId)throw new Error('Unrelated native provider session');
 const recordFile=path.join(dir,'..','session.json');
 if(fs.existsSync(recordFile)){
  if(fs.statSync(recordFile).size>8*1024*1024)throw new Error('Invalid native task record');
  const record=JSON.parse(fs.readFileSync(recordFile,'utf8'));
  if(record.id!==taskId||record.execution!=='native'||record.provider!=='claude'||record.native?.instance!==instance||record.native.ended||(record.sessionId||record.id)!==sessionId)throw new Error('Native terminal instance changed');
 }
 const vault=fs.realpathSync(active.vault),outbox=process.env.AOS_ARTIFACT_OUTBOX,expected=path.join(vault,'system','v2','artifact-requests',taskId);
 if(typeof outbox!=='string'||path.resolve(outbox)!==expected)throw new Error('Invalid native artifact outbox');
 unlinked(outbox,vault);const outboxFile=path.join(outbox,'active-request.meta'),other=readMeta(outboxFile);
 if(other.taskId!==taskId||other.requestKey!==active.requestKey||other.outbox!==outbox||fs.realpathSync(other.vault)!==vault)throw new Error('Native request metadata disagrees');
 const hash=crypto.createHash('sha256').update(normalized(data.prompt)).digest('hex');
 const requestKey=active.expectedPromptHash===hash&&active.accepted!==true?active.requestKey:crypto.randomUUID();
 const update={requestKey,expectedPromptHash:hash,accepted:true,nativeInstance:instance,nativePromptReceipt:receipt};
 writeMeta(outboxFile,{...other,...update});writeMeta(activeFile,{...active,...update});
 return {requestKey,rotated:requestKey!==active.requestKey,outbox,taskId};
}
function claudeStopIdentity(data){
 if(!uuid(data.session_id)||typeof data.transcript_path!=='string'||!normalized(data.last_assistant_message))return null;
 let fd;
 try{
  const projects=path.join(process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude'),'projects');
  const file=unlinked(data.transcript_path,projects);if(path.basename(file)!==`${data.session_id}.jsonl`)return null;
  fd=fs.openSync(file,'r');const stat=fs.fstatSync(fd);if(!stat.isFile())return null;
  const start=Math.max(0,stat.size-512*1024),buffer=Buffer.alloc(Math.min(stat.size,512*1024));fs.readSync(fd,buffer,0,buffer.length,start);
  const lines=buffer.toString('utf8').split('\n');if(start)lines.shift();
  for(let i=lines.length-1;i>=0;i--){
   let row;try{row=JSON.parse(lines[i])}catch{continue}
   if(row.type!=='assistant'||row.sessionId!==data.session_id||!uuid(row.uuid))continue;
   const content=row.message?.content,text=typeof content==='string'?content:Array.isArray(content)?content.filter(item=>item?.type==='text'&&typeof item.text==='string').map(item=>item.text).join('\n'):'';
   if(normalized(text)===normalized(data.last_assistant_message))return `claude-${row.uuid}`;
  }
 }catch{}finally{if(fd!==undefined)fs.closeSync(fd)}
 return null;
}
try {
 const dir=process.env.AOS_WORK_EVENTS;
 if(!dir)process.exit(0);
 let raw=process.argv[2];
 if(!raw){raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>2000000)process.exit(0)}}
 const data=JSON.parse(raw);
 // Nested agents cannot claim the parent conversation's identity.
 if(data.agent_id)process.exit(0);
 // Internal title-generation threads can also notify. Once known, only accept
 // this terminal's session ID; do not discard legitimate JSON answers in it.
 if(data.type==='agent-turn-complete'){
  const sessionId=data['thread-id'];
  if(typeof sessionId!=='string'||!/^[a-f0-9-]{36}$/.test(sessionId))process.exit(0);
  const identity=path.join(dir,'main-session.txt');
  let known=process.env.AOS_WORK_SESSION||(fs.existsSync(identity)?fs.readFileSync(identity,'utf8'):null);
  if(known&&sessionId!==known)process.exit(0);
  if(!known){
   const initial=(data['input-messages']||[]).some(message=>typeof message==='string'&&message.trim()===process.env.AOS_WORK_PROMPT?.trim());
   if(!initial){try{const title=JSON.parse(data['last-assistant-message']);if(Object.keys(title).length===1&&typeof title.title==='string')process.exit(0)}catch{}}
   // Concurrent notify processes must not overwrite the winning identity or
   // publish a completion from the losing thread. A partially written winner
   // fails closed here; its own process will publish the initial completion.
   try{fs.writeFileSync(identity,sessionId,{flag:'wx'})}catch(error){if(error.code!=='EEXIST')throw error}
   known=fs.readFileSync(identity,'utf8');
   if(sessionId!==known)process.exit(0);
  }
 }
 const nativeInstance=uuid(process.env.AOS_NATIVE_INSTANCE)?process.env.AOS_NATIVE_INSTANCE:null;
 const name=crypto.randomUUID();
 let requestKey,additionalContext;
 try{const context=JSON.parse(fs.readFileSync(path.join(dir,'active-request.meta'),'utf8'));if(/^[a-f0-9-]{36}$/.test(context.requestKey||''))requestKey=context.requestKey}catch{}
 if(nativeInstance&&data.hook_event_name==='UserPromptSubmit'&&typeof data.prompt==='string'){
  const accepted=acceptNativeClaudePrompt(dir,data,nativeInstance,name);requestKey=accepted.requestKey;
  if(accepted.rotated)additionalContext=artifactHandoffInstructions({node:process.execPath,helper:fileURLToPath(new URL('./artifact-result.mjs',import.meta.url)),events:accepted.outbox,taskId:accepted.taskId,requestKey,provider:'claude'});
 }
 const event={type:data.type==='agent-turn-complete'?'complete':data.hook_event_name,
 sessionId:data['thread-id']||data.session_id,
 turnId:data['turn-id']||(data.hook_event_name==='Stop'?(claudeStopIdentity(data)||(requestKey?`claude-${requestKey}`:crypto.randomUUID())):crypto.randomUUID()),
 text:String(data['last-assistant-message']||data.last_assistant_message||'').slice(0,100000),ts:Date.now(),...(nativeInstance?{nativeInstance}: {})};
 if(event.type==='UserPromptSubmit'){
  event.requestKey=requestKey;
  // A queued hook from the prior turn cannot acknowledge a newly pasted one.
  event.prompt=typeof data.prompt==='string'?data.prompt.slice(0,64000):'';
 }
 if(['complete','Stop'].includes(event.type)){
  const {captureTranscriptArtifacts}=await import('./artifact-transcript.mjs');
  event.artifactCandidates=captureTranscriptArtifacts({
   ...event,provider:data.type==='agent-turn-complete'?'codex':'claude',transcriptPath:data.transcript_path,
  });
 }
 fs.writeFileSync(path.join(dir,name+'.tmp'),JSON.stringify(event));
 fs.renameSync(path.join(dir,name+'.tmp'),path.join(dir,name+'.json'));
 // Claude consumes this before processing a manually typed follow-up. Do not
 // repeat instructions for managed prompts that already contain their key.
 if(additionalContext)process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext}})+'\n');
}catch{} // Observability must never block the CLI's own turn.
