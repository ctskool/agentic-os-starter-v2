// Called by the worker after it has produced a real local file. This requests
// presentation; it never claims that a dashboard has already opened the result.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function json(file,maxBytes){if(fs.statSync(file).size>maxBytes)throw new Error('Invalid dashboard task configuration.');return JSON.parse(fs.readFileSync(file,'utf8'));}
function unlinked(absolute,boundary){
 if(fs.realpathSync(absolute)!==absolute)throw new Error('Linked handoff directories are not allowed.');
 for(let cursor=absolute;cursor!==boundary;cursor=path.dirname(cursor)){
  if(cursor===path.dirname(cursor)||fs.lstatSync(cursor).isSymbolicLink())throw new Error('Invalid dashboard task directory.');
 }
}
class NativeRequestPending extends Error {
 constructor(proof){super('This dashboard request is no longer active.');this.proof=proof;}
}
function nativePromptProof(active,record,context,runtimeEvents,previous){
 if(record.execution!=='native'||record.provider!=='claude'||record.native?.ended||
  !uuid(active.nativeInstance)||record.native?.instance!==active.nativeInstance||
  active.accepted!==true||context.accepted!==true||context.nativeInstance!==active.nativeInstance||
  !uuid(active.nativePromptReceipt)||context.nativePromptReceipt!==active.nativePromptReceipt)return null;
 const proof={taskId:active.taskId,requestKey:active.requestKey,instance:active.nativeInstance,sessionId:record.sessionId||record.id,receipt:active.nativePromptReceipt};
 // Collection removes the receipt before saving session.json. A proof already
 // read by this helper may bridge that tiny interval, never a different turn.
 if(previous&&Object.keys(proof).every(key=>proof[key]===previous[key]))return proof;
 try{
  const file=path.join(runtimeEvents,proof.receipt+'.json');unlinked(file,runtimeEvents);
  const event=json(file,200000);
  if(event.type!=='UserPromptSubmit'||event.nativeInstance!==proof.instance||event.sessionId!==proof.sessionId||event.requestKey!==proof.requestKey||typeof event.prompt!=='string')return null;
  const hash=crypto.createHash('sha256').update(event.prompt.replace(/\r\n?/g,'\n').trim()).digest('hex');
  return hash===active.expectedPromptHash&&hash===context.expectedPromptHash?proof:null;
 }catch{return null;}
}
function validatedContext({outbox,taskId,requestKey,explicit},previous){
 // Explicit invocations bind to this installation's task record. Legacy
 // invocations may read their inherited event path, but never write to it.
 const runtimeEvents=explicit?path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','.runtime','terminals',taskId,'events'):path.resolve(process.env.AOS_WORK_EVENTS||'');
 const owner=path.dirname(runtimeEvents),actualTask=path.basename(owner);
 if(path.basename(runtimeEvents)!=='events'||!uuid(actualTask))throw new Error('Invalid dashboard task directory.');
 unlinked(runtimeEvents,path.dirname(path.dirname(owner)));
 const active=json(path.join(runtimeEvents,'active-request.meta'),4096),record=json(path.join(owner,'session.json'),8*1024*1024);
 if(!uuid(active.taskId)||!uuid(active.requestKey)||active.taskId!==actualTask||active.events!==runtimeEvents||
  record.id!==active.taskId||typeof record.vault!=='string'||
  fs.realpathSync(active.vault)!==fs.realpathSync(record.vault)||
  (explicit&&(active.taskId!==taskId||active.requestKey!==requestKey)))throw new Error('This dashboard request is no longer active.');
 const vault=fs.realpathSync(record.vault),expected=path.join(vault,'system','v2','artifact-requests',actualTask),absolute=outbox?path.resolve(outbox):expected;
 if(absolute!==expected)throw new Error('The artifact outbox does not belong to this task vault.');
 unlinked(absolute,vault);
 const context=json(path.join(absolute,'active-request.meta'),4096);
 if(context.taskId!==actualTask||context.requestKey!==active.requestKey||context.outbox!==absolute||fs.realpathSync(context.vault)!==vault)throw new Error('This dashboard request is no longer active.');
 if(record.artifactRequestKey!==active.requestKey){
  const proof=nativePromptProof(active,record,context,runtimeEvents,previous);
  if(proof)throw new NativeRequestPending(proof);
  throw new Error('This dashboard request is no longer active.');
 }
 return context;
}
async function currentContext(options){
 const deadline=Date.now()+1500;let proof;
 for(;;){
  try{return validatedContext(options,proof)}catch(error){
   // Only a verified native prompt receipt can wait for the bridge's next
   // 700ms collection. Success still requires the original strict key match.
   if(!(error instanceof NativeRequestPending)||Date.now()>=deadline)throw error;
   proof=error.proof;if(process.env.AOS_ARTIFACT_TRACE)process.stderr.write('waiting for collection\n');
   await new Promise(resolve=>setTimeout(resolve,50));
  }
 }
}
try{
 const args=process.argv.slice(2),source=args.shift();
 if(!source||source.startsWith('--')||source.length>2048)throw new Error('Usage: artifact-result <local file> [--open] [--label title]');
 let open=false,label,outbox,taskId,requestKey;const seen=new Set();
 while(args.length){const arg=args.shift();if(seen.has(arg))throw new Error('Duplicate artifact option.');seen.add(arg);
  if(arg==='--open')open=true;
  else if(['--label','--outbox','--task','--request'].includes(arg)&&args.length){const value=args.shift();if(arg==='--label')label=value;else if(arg==='--outbox')outbox=value;else if(arg==='--task')taskId=value;else requestKey=value;}
  else throw new Error('Unknown artifact option.');
 }
 const explicit=outbox!==undefined||taskId!==undefined||requestKey!==undefined;
 if(explicit&&(!outbox||!uuid(taskId)||!uuid(requestKey)))throw new Error('The complete dashboard request identity is required.');
 if(!explicit&&!process.env.AOS_WORK_EVENTS)throw new Error('Artifact handoff is unavailable outside a dashboard task.');
 const context=await currentContext({outbox,taskId,requestKey,explicit}),dir=context.outbox;
 const event={type:'artifact',taskId:context.taskId,requestKey:context.requestKey,path:path.resolve(process.cwd(),source),label,open,ts:Date.now()};
 const name=crypto.randomUUID(),temporary=path.join(dir,name+'.tmp');
 // A new voice turn may start while the worker command is being launched.
 const current=validatedContext({outbox,taskId,requestKey,explicit});if(current.requestKey!==context.requestKey)throw new Error('This dashboard request is no longer active.');
 fs.writeFileSync(temporary,JSON.stringify(event),{flag:'wx'});fs.renameSync(temporary,path.join(dir,name+'.json'));
 process.stdout.write(JSON.stringify({status:'pending',requestedOpen:open,message:'Output submitted for dashboard validation. Opening is confirmed separately by the app.'})+'\n');
}catch(error){process.stderr.write(String(error.message||error)+'\n');process.exitCode=1;}
