#!/usr/bin/env node
// Offline qualification of the strict local rules ("open this file", "UI command").
// Every case runs through the COMPLETE deployed policy: the real routeVoice with
// its rules, lookups, exclusions, the strict rules, the Jev hedge and every
// validator. Only the effects (terminals) and the model call are stand-ins, and
// the vault is a mirror in a temporary folder, so nothing here can write to the
// real vault. Jev runs exactly as it does live (the strict rules never ask it).
//
//   node scripts/voice-strict-qualify.mjs <cases.json> [...] --vault <real vault> --out <new-results.json> [--luna-ms 3000] [--no-jev]
//   node scripts/voice-strict-qualify.mjs --latency --vault <real vault> --out <new-results.json>
//
// A case: {id, group:'localOpen'|'localUi', transcript, expect, selected?, setup?, appScope?, provider?}
//   expect: {act:'open', path} | {act:'open', deliverable} | {act:'ui', obsidian} | {act:'none'}
//   setup:  earlier turns of the same conversation, [{say, model}] — `model` is what the
//           stand-in model answers for that turn. They go through routeVoice too, so
//           accepted offers, pending arguments and prior receipts are real, not reconstructed.
// Expectations are written BEFORE any case is shown to the code.
// The key comes from AOS_JEV_KEY or .runtime/jev.json; it is never printed or saved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {routeVoice} from '../runner/bridge-core.mjs';
import {setCurrent} from '../runner/current-conversations.mjs';
import {readJevConfig,classifyJev,JEV_REVISION,classifierProcesses} from '../runner/jev.mjs';
import {invalidateStrictIndex,invalidateTargetIndex} from '../runner/voice-targets.mjs';
import {projectRoot} from '../runner/runtime.mjs';
import {attempted} from './voice-strict-credit.mjs';

const args=process.argv.slice(2);
const flag=name=>{const index=args.indexOf(name);if(index<0)return null;const value=args[index+1];args.splice(index,2);return value??''};
const has=name=>{const index=args.indexOf(name);if(index<0)return false;args.splice(index,1);return true};
const latencyMode=has('--latency'),noJev=has('--no-jev'),outFile=flag('--out'),vaultArg=flag('--vault');
const lunaMs=Number(flag('--luna-ms')??3000)||3000;
if(!outFile||!vaultArg||(!latencyMode&&!args.length)){console.error('Usage: node scripts/voice-strict-qualify.mjs <cases.json> [...] --vault <vault> --out <new-results.json> [--luna-ms n] [--no-jev] | --latency --vault <vault> --out <file>');process.exit(2)}
const out=path.resolve(outFile),realVault=path.resolve(vaultArg);
if(fs.existsSync(out)){console.error('Refusing to overwrite an existing results file.');process.exit(2)}
if(!fs.statSync(realVault).isDirectory()){console.error('The vault folder does not exist.');process.exit(2)}
// The policy that was measured: the exact code and whether it had uncommitted changes.
const git=(...parts)=>{try{return execFileSync('git',parts,{cwd:projectRoot,encoding:'utf8'}).trim()}catch{return null}};
const policy={commit:git('rev-parse','HEAD'),branch:git('rev-parse','--abbrev-ref','HEAD'),uncommittedRunnerChanges:Boolean(git('status','--porcelain','--','runner','shared'))};

// --- the mirror: the content tree the index sees, and nothing operational -------
const TYPES=new Set(['md','canvas','png','jpg','jpeg','webp','gif','svg','pdf']);
function buildMirror(){
 const mirror=fs.mkdtempSync(path.join(os.tmpdir(),'voice-strict-mirror-'));let files=0;
 const walk=(dir,relative,depth)=>{
  if(depth>12)return;
  for(const item of fs.readdirSync(dir,{withFileTypes:true})){
   if(item.name.startsWith('.')||item.isSymbolicLink())continue;
   const rel=relative?`${relative}/${item.name}`:item.name;
   if(item.isDirectory()){if(!relative&&['node_modules','_archive-vault','system'].includes(item.name))continue;walk(path.join(dir,item.name),rel,depth+1);continue}
   if(!item.isFile()||!TYPES.has(path.extname(item.name).slice(1).toLowerCase()))continue;
   const target=path.join(mirror,rel);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'');
   // Same-date reports are ordered by modification time, so the mirror keeps it.
   const stat=fs.statSync(path.join(dir,item.name));fs.utimesSync(target,stat.atime,stat.mtime);files++;
  }
 };
 walk(realVault,'',0);
 return {mirror,files};
}
const {mirror,files:mirrored}=buildMirror();
process.on('exit',()=>{try{fs.rmSync(mirror,{recursive:true,force:true})}catch{}});

// --- one conversation through the complete policy -------------------------------------
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const quiet=async()=>{for(let i=0;i<400&&classifierProcesses().total;i++)await tick(10);if(classifierProcesses().total)throw new Error('work was still owned after 4 s')};
function operationalReset(){fs.rmSync(path.join(mirror,'system'),{recursive:true,force:true});invalidateTargetIndex(mirror)}
function standIn(reply,ms,seen){return (_root,_job,_prompt,options)=>new Promise((resolve,reject)=>{
 seen.lunaStarted=true;
 const timer=setTimeout(()=>{seen.lunaAnswered=true;resolve({text:JSON.stringify(reply)})},ms);
 const stop=()=>{clearTimeout(timer);seen.lunaCancelled=true;reject(new Error('Voice request cancelled'))};
 if(options.signal?.aborted)stop();else options.signal?.addEventListener('abort',stop,{once:true});
})}
const SENTINEL={tier:2,reply:'__LUNA__'};
const JEV_QUIET=async()=>({route:'tier2',tier:2,skill:null,p:0.5,kind:'written',kp:0.5,revision:JEV_REVISION,pinned:true,ms:1,socketReused:true});
// A conversation is one vault-state: its own settings, receipts, selected task and queue.
function conversation(item){
 const selection={provider:item.provider||'codex',model:item.provider==='claude'?'sonnet':'gpt-6-astra'},tasks=[],calls=[];
 const get=id=>{const task=tasks.find(entry=>entry.id===id);if(!task)throw new Error('Task not found');return task};
 const terminals={live:new Map(),list:()=>tasks,get,send(id){calls.push('send');return get(id)},start(options){calls.push('start');const task={id:options.id,...options.selection,title:options.title,state:'working',turns:[]};tasks.push(task);return task},
  startWorkflow(options){calls.push(`workflow:${options.skill}`);return {id:options.id}},continueWorkflow(id,options){calls.push(`continue:${options.skill}`);return get(id)}};
 let workTarget=null;
 if(item.selected){const task={id:crypto.randomUUID(),...selection,title:'Selected conversation',state:'ready',created:Date.now(),turns:[{text:'Done.',ts:Date.now()}],...item.selected};tasks.push(task);setCurrent(mirror,terminals,{provider:selection.provider,id:task.id});workTarget=task.id}
 const turn=async(transcript,{jevConfig,classify,strict,reply=SENTINEL,ms=lunaMs,defer})=>{
  const records=[],seen={};let asked=null;calls.length=0;
  const jev={config:jevConfig,log:()=>{},classify:async(state,options)=>{try{asked=await classify(state,options);return asked}catch(error){asked={error:String(error.message||error).slice(0,120),ms:error.ms??null};throw error}}};
  const started=performance.now();
  const receipt=await routeVoice(mirror,{id:crypto.randomUUID(),transcript,selection,terminalMode:true,workTarget,origin:'test',...(item.appScope?{appScope:item.appScope}:{})},undefined,standIn(reply,ms,seen),terminals,{resolveCli:()=>({command:'unused',prefix:[]}),updateCurrent:()=>{},jev,strict:{config:strict,log:(_root,_id,record)=>records.push(record),...(defer?{defer}:{})}}).catch(error=>({error:String(error.message||error).slice(0,200)}));
  const totalMs=Math.round((performance.now()-started)*10)/10;
  // Records are written after the answer; the run is complete once nothing is owned.
  await quiet();
  return {receipt,totalMs,startedAt:started,calls:[...calls],asked,record:records.at(-1)||null,lunaStarted:!!seen.lunaStarted,lunaCancelled:!!seen.lunaCancelled,lunaAnswered:!!seen.lunaAnswered};
 };
 return {turn};
}
async function speak(item,options){
 operationalReset();if(options.coldIndex)invalidateStrictIndex(mirror);
 const talk=conversation(item);
 // Earlier turns use the same switches, with a scripted Jev that stays out of the way.
 for(const step of item.setup||[]){await talk.turn(step.say,{...options,classify:JEV_QUIET,reply:step.model,ms:20});await tick(3)}
 return talk.turn(item.transcript,options);
}
// Everything a receipt can show that it did, as one comparable set. A right action
// with anything extra beside it is not a right outcome.
const canon=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined&&v!==null).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canon(v)])):value;
function did(run){
 const receipt=run.receipt;if(receipt.error)return {error:receipt.error};
 const effects=(receipt.decision?.effects||[]).filter(effect=>!['reply','ui'].includes(effect));
 return canon({obsidian:receipt.obsidian||null,deliverable:receipt.deliverable||null,reveal:receipt.reveal||null,reveals:receipt.reveals?.length?receipt.reveals:null,reopened:receipt.reopened?true:null,action:receipt.action&&receipt.action!=='reply'?receipt.action:null,
  work:receipt.workIds?.length||receipt.queued?true:null,dispatched:run.calls.length?run.calls:null,effects:effects.length?effects:null,pendingSkill:receipt.pendingSkill||null});
}
const wanted=item=>canon(item.expect.act==='open'?(item.expect.deliverable?{deliverable:item.expect.deliverable,reveal:'open'}:{obsidian:{op:'open-note',query:item.expect.path}}):item.expect.act==='ui'?{obsidian:item.expect.obsidian}:{});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const KIND={localOpen:'open',localUi:'ui'},RULE={'router.strictOpen':'open','router.strictUi':'ui'};
function judge(item,run){
 const rule=run.receipt.decision?.rule||null,exitKind=RULE[rule]||null,action=did(run),expected=wanted(item),finalCorrect=same(action,expected);
 const record=run.record,reached=Boolean(record);
 let missedBecause=null;
 if(!exitKind&&item.expect.act!=='none')missedBecause=!reached?`answered upstream: ${rule}`:record.blockedBy?`guard: ${record.blockedBy}`:`code: ${record.reason||'unconfirmed'}`;
 // A strict action is judged on its own. Everything else is judged too: when the
 // rules did not act, the final action still has to be what was expected.
 return {rule,exitKind,verdict:exitKind?(finalCorrect?'correct':'WRONG'):item.expect.act!=='none'?'missed':'abstained',missedBecause,did:action,finalCorrect,
  otherMismatch:!exitKind&&!finalCorrect&&!same(action,{})?`${rule} did ${JSON.stringify(action)}`:null,
  // What the guard cost or saved: the rules would have produced this, had no guard stood in the way.
  blockedCandidate:reached&&record.blockedBy&&record.candidate?{...record.candidate,matchesExpectation:same(canon(record.candidate.action.deliverable?{deliverable:record.candidate.action.deliverable,reveal:'open'}:record.candidate.action),expected)}:null};
}

const median=list=>{const sorted=[...list].sort((a,b)=>a-b);return sorted.length?sorted[Math.floor(sorted.length/2)]:null};
// --- latency mode: paired, no network ----------------------------------------------
if(latencyMode){
 const jevConfig={key:'sk-or-latency-arm-000000',mode:{codex:'fastpath',claude:'fastpath'},theta:0.9,deadlineMs:600,tier2kind:true};
 const written={kind:'written',say:['How many revised mockups did I say were ready?','What should I focus on before lunch?','Did the retention numbers improve this month?','Give me a one line summary of where the launch stands.','Is there anything I promised a sponsor this week?']},
  // Sentences that start like an open, pass the door, and name no file: the index is consulted, nothing matches.
  lead={kind:'display-lead',say:['Pop open the quarterly forecast memo','I wanna see the retention numbers breakdown','Can I see the onboarding checklist for editors','Pop open the unreleased pricing memo','Lemme see the sponsor rate card draft']};
 const framed={kind:'framed',say:lead.say,selected:{title:'Unrelated work'}};
 // Paired design: the same sentence is spoken with the rules off and on, back to back, the order alternating,
 // several times per cell, after a warm-up pass that is thrown away. The gate reads the median of the PAIRED
 // differences (on minus off), so drift and the first-run cost of the process cancel out.
 const reps=Number(flag('--reps')??4)||4,rows=[];
 const once=(set,say,offset,coldIndex,strict)=>speak({transcript:say,...(set.selected?{selected:set.selected}:{})},{jevConfig,classify:async()=>{await tick(200);return JEV_QUIET()},strict:{open:strict,ui:strict},ms:offset,coldIndex});
 for(const set of [written,lead,framed])for(const strict of ['off','on'])await once(set,set.say[0],60,true,strict);
 for(const offset of [60,400])for(const coldIndex of [true,false])for(const set of [written,lead,framed])for(let rep=0;rep<reps;rep++)for(const [index,say] of set.say.entries()){
  const order=(rep+index)%2?['on','off']:['off','on'],pair={};
  for(const strict of order){
   // Warm means warm: the index is built right before the measured request (and thrown away for a cold one).
   if(!coldIndex){await once(set,say,5,false,'on')}
   const run=await once(set,say,offset,coldIndex,strict);pair[strict]=run;
   rows.push({set:set.kind,offset,coldIndex,strict,rep,say,totalMs:run.totalMs,rule:run.receipt.decision?.rule,reply:run.receipt.reply,strictMs:run.record?.ms??null,stage:run.record?.stage??null,reason:run.record?.reason??null,blockedBy:run.record?.blockedBy??null,deferred:run.record?.deferred??null});
  }
  rows.at(-1).pairedDifferenceMs=rows.at(-2).pairedDifferenceMs=Math.round((pair.on.totalMs-pair.off.totalMs)*10)/10;
 }
 // A written request answered while ANOTHER request's cold would-be check is indexing.
 const beside=[];
 for(let round=0;round<8;round++)for(const busy of [false,true]){
  operationalReset();invalidateStrictIndex(mirror);
  const other=conversation({}),mine=conversation({});
  let checkStartedAt=null,checkStarts;const checkStarting=new Promise(resolve=>{checkStarts=resolve});
  const background=busy?other.turn('Pop open the unreleased pricing memo',{jevConfig,classify:JEV_QUIET,strict:{open:'shadow',ui:'shadow'},ms:5,defer:callback=>{checkStartedAt=performance.now();checkStarts();callback()}}):null;
  if(busy)await checkStarting;
  const run=await mine.turn('How many revised mockups did I say were ready?',{jevConfig,classify:JEV_QUIET,strict:{open:'on',ui:'on'},ms:60});
  const checked=await background;
  beside.push({busy,totalMs:run.totalMs,reply:run.receipt.reply,backgroundReason:checked?checked.record?.reason||null:null,requestStartedAfterCheckMs:busy&&checkStartedAt!==null?Math.round((run.startedAt-checkStartedAt)*10)/10:null});
 }
 const summary=[];
 for(const set of ['written','display-lead','framed'])for(const offset of [60,400])for(const coldIndex of [true,false]){
  const pick=strict=>rows.filter(row=>row.set===set&&row.offset===offset&&row.coldIndex===coldIndex&&row.strict===strict);
  const off=median(pick('off').map(row=>row.totalMs)),on=median(pick('on').map(row=>row.totalMs)),inside=pick('on').map(row=>row.strictMs).filter(value=>typeof value==='number'),paired=pick('on').map(row=>row.pairedDifferenceMs);
  summary.push({set,modelAnswersAtMs:offset,coldIndex,pairs:paired.length,medianOffMs:off,medianOnMs:on,medianPairedDifferenceMs:median(paired),maxPairedDifferenceMs:Math.max(...paired),minPairedDifferenceMs:Math.min(...paired),strictMsMedian:median(inside),strictMsMax:inside.length?Math.max(...inside):null,
   reachedResolution:pick('on').filter(row=>row.reason==='no-match').length,blocked:pick('on').filter(row=>row.blockedBy).length,everyReplyFromModel:pick('on').every(row=>row.reply==='__LUNA__')});
 }
 const concurrent={aloneMedianMs:median(beside.filter(row=>!row.busy).map(row=>row.totalMs)),besideColdCheckMedianMs:median(beside.filter(row=>row.busy).map(row=>row.totalMs)),everyReplyFromModel:beside.every(row=>row.reply==='__LUNA__'),backgroundChecksThatIndexed:beside.filter(row=>row.busy&&row.backgroundReason==='no-match').length,backgroundChecks:beside.filter(row=>row.busy).length};
 fs.writeFileSync(out,JSON.stringify({createdAt:new Date().toISOString(),mode:'latency',policy,mirrored,summary,concurrent,rows,beside},null,2));
 console.log(JSON.stringify({policy,summary,concurrent},null,2));console.log(`\nSaved to ${out}`);process.exit(0);
}

// --- qualification ---------------------------------------------------------------------
const saved=readJevConfig();
if(!noJev&&!saved.key){console.error('No Jev key. Set AOS_JEV_KEY or add it to .runtime/jev.json, or pass --no-jev.');process.exit(2)}
// Jev as it runs live: fast path for both providers at the saved threshold. The strict rules never ask it.
const jevConfig=noJev?{key:'',mode:{codex:'off',claude:'off'},theta:null,deadlineMs:600,tier2kind:false}:{...saved,mode:{codex:'fastpath',claude:'fastpath'},theta:saved.theta??0.9,tier2kind:true};
const cases=args.flatMap(file=>JSON.parse(fs.readFileSync(file,'utf8')).map(item=>({...item,file:path.basename(file)})));
const invalid=cases.filter(item=>!['open','ui','none'].includes(item.expect?.act)||typeof item.transcript!=='string'||!KIND[item.group]||(item.setup&&!item.setup.every(step=>typeof step.say==='string'&&step.model&&typeof step.model==='object')));
if(invalid.length){console.error(`${invalid.length} case(s) have no valid expectation, group or setup (${invalid.slice(0,5).map(item=>item.id).join(', ')}). Write every expectation before running.`);process.exit(2)}
if(new Set(cases.map(item=>item.id)).size!==cases.length){console.error('Duplicate case ids.');process.exit(2)}
// An expected path must exist in the vault, or the case is mislabeled rather than missed.
for(const item of cases){const target=item.expect.path||item.expect.deliverable;if(target&&!fs.existsSync(path.join(mirror,target))){console.error(`${item.id}: expected file is not in the vault: ${target}`);process.exit(2)}}

const results=[];
for(const [index,item] of cases.entries()){
 const run=await speak(item,{jevConfig,classify:(state,options)=>classifyJev(state,{...options,deadlineMs:jevConfig.deadlineMs}),strict:{open:'on',ui:'on'}});
 results.push({id:item.id,file:item.file,author:item.author||null,group:item.group,transcript:item.transcript,hasSetup:Boolean(item.setup?.length),selected:Boolean(item.selected),expect:item.expect,...judge(item,run),reachedStrictRules:Boolean(run.record),record:run.record,
  jev:run.asked?{route:run.asked.route??null,p:run.asked.p??null,kind:run.asked.kind??null,kp:run.asked.kp??null,ms:run.asked.ms??null,error:run.asked.error??null}:null,totalMs:run.totalMs,lunaStarted:run.lunaStarted,lunaCancelled:run.lunaCancelled,dispatched:run.calls});
 process.stdout.write(`\r${index+1}/${cases.length}`);
}
process.stdout.write('\n');
const percentile=(values,q)=>{const sorted=values.filter(value=>typeof value==='number').sort((a,b)=>a-b);return sorted.length?sorted[Math.min(sorted.length-1,Math.floor(sorted.length*q))]:null};
const tally=list=>{const counts={};for(const key of list)counts[key]=(counts[key]||0)+1;return counts};
function report(group){
 const kind=KIND[group];
 // Actions are counted by who decided, never by the group a case was written for.
 const exits=results.filter(item=>item.exitKind===kind),correct=exits.filter(item=>item.verdict==='correct'),wrong=exits.filter(item=>item.verdict==='WRONG');
 const mine=results.filter(item=>item.group===group),positives=mine.filter(item=>item.expect.act!=='none'),negatives=mine.filter(item=>item.expect.act==='none');
 // A targeted trap: written as a near-miss for this kind, reached the strict rules, every guard passed, AND the
 // refusal is attributable to this kind: its checks got past the door, or the sentence was phrased as an attempt
 // at this kind of command (see `attempted`). An unrelated question earns no credit, whatever words occur in it.
 const unguarded=negatives.filter(item=>item.record&&!item.record.blockedBy),targeted=unguarded.filter(item=>item.record.kind===kind||attempted(kind,item.transcript));
 // A frame trap earns credit only when a conversation-frame guard stood in the way AND the rules would otherwise
 // have produced a confirmed action of this kind. Other guards (exclusions, work history) are listed apart.
 const guarded=negatives.filter(item=>item.record?.blockedBy),framed=guarded.filter(item=>item.record.blockedBy.startsWith('frame:')&&item.blockedCandidate?.kind===kind);
 return {actions:exits.length,correct:correct.length,WRONG:wrong.length,wrongIds:wrong.map(item=>item.id),precisionPercent:exits.length?Math.round(1000*correct.length/exits.length)/10:null,
  actionsFromTheOtherGroup:exits.filter(item=>item.group!==group).map(item=>item.id),modelEverStartedOnAnAction:exits.some(item=>item.lunaStarted),jevEverAskedOnAnAction:exits.some(item=>item.jev),
  challengeSet:{cases:mine.length,expectedToAct:positives.length,expectedToAbstain:negatives.length,reachedStrictRules:mine.filter(item=>item.reachedStrictRules).length,
   targetedTraps:targeted.length,targetedTrapsByStage:tally(targeted.map(item=>item.record.stage)),targetedTrapsByReason:tally(targeted.map(item=>item.record.reason)),unguardedTrapsNotCredited:unguarded.filter(item=>!targeted.includes(item)).map(item=>item.id),
   frameTraps:framed.length,frameTrapsByGuard:tally(framed.map(item=>item.record.blockedBy)),guardedTrapsNotCredited:tally(guarded.filter(item=>!framed.includes(item)).map(item=>`${item.record.blockedBy}${item.blockedCandidate?'':' (the rules would have refused anyway)'}`)),
   trapsAnsweredUpstream:negatives.filter(item=>!item.record).length,
   missed:mine.filter(item=>item.verdict==='missed').length,missedByCause:tally(mine.filter(item=>item.verdict==='missed').map(item=>item.missedBecause)),
   guardCost:{expectedActionsAGuardBlocked:positives.filter(item=>item.record?.blockedBy).length,ofWhichTheRulesWouldHaveBeenRight:positives.filter(item=>item.blockedCandidate?.matchesExpectation).length}},
  actionMs:{p50:percentile(exits.map(item=>item.totalMs),0.5),p95:percentile(exits.map(item=>item.totalMs),0.95)},strictMs:{p50:percentile(exits.map(item=>item.record?.ms),0.5),max:percentile(exits.map(item=>item.record?.ms),1)}};
}
const summary={policy,frozen:{strict:{open:'on',ui:'on'},jev:noJev?'off':{mode:'fastpath',theta:jevConfig.theta,deadlineMs:jevConfig.deadlineMs},lunaMs},mirroredFiles:mirrored,cases:results.length,casesWithSetup:results.filter(item=>item.hasSetup).length,casesWithSelection:results.filter(item=>item.selected).length,
 jevErrors:results.filter(item=>item.jev?.error).length,
 open:report('localOpen'),ui:report('localUi'),
 // Every final action is judged, not only the strict ones.
 finalActions:{asExpected:results.filter(item=>item.finalCorrect).length,of:results.length,otherMismatches:results.filter(item=>item.otherMismatch).map(item=>({id:item.id,transcript:item.transcript,what:item.otherMismatch}))},
 tier3Exits:results.filter(item=>item.rule==='jev.earlyExit').map(item=>item.id)};
fs.writeFileSync(out,JSON.stringify({createdAt:new Date().toISOString(),inputs:args.map(file=>path.basename(file)),summary,results},null,2));
console.log(JSON.stringify(summary,null,2));
console.log(`\nSaved ${results.length} results to ${out}`);
process.exit(0);
