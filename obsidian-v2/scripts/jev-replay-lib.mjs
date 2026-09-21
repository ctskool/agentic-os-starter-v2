// Rebuilds, from saved voice receipts, the state the bridge would have sent to
// Jev for every request that reached the general classifier.
//
// Receipts do not record everything the bridge knew. What cannot be rebuilt is
// left empty and named in `reconstruction` (the batch test reports such cases
// separately), or the request is skipped:
//  - the selected worker's last result is not in a receipt, so it is left empty
//    (never replaced by the spoken acknowledgment);
//  - the selected task's state at the time is unknown and is assumed "ready";
//  - an accepted offer rewrites the transcript inside the router, so bare
//    affirmations are skipped rather than replayed with the wrong words;
//  - lookup inspectors run without the previous-lookup context the router had;
//  - an explicit new task is saved with the epoch AFTER its reset and with its
//    completion time, so the epoch before the request and the routing time are
//    inferred; a carried-forward reference is therefore always marked uncertain.
// Exclusions use the router's own compoundBriefRequest and the production lookup
// inspectors, and history is limited in production order (six provider-scoped
// exchanges first, then the conversation).
import {newTaskIntent} from '../shared/new-task-intent.mjs';
import {stripPleasantry} from '../runner/voice-stop.mjs';
import {compoundHint} from '../runner/lookup-fallback.mjs';
import {compoundBriefRequest} from '../runner/voice-router.mjs';
import {inspectBriefRequest} from '../runner/brief-voice.mjs';
import {inspectBriefSectionRequest} from '../runner/brief-section-intent.mjs';
import {inspectLocalLookup} from '../runner/lookup-catalog.mjs';

const scope=receipt=>receipt.appScope||'web';
const reachedClassifier=receipt=>receipt.decision?receipt.decision.boundary==='general':receipt.engine!=='rules'&&receipt.lookupRoute!=='scoped-model';
const looksLikeTest=receipt=>receipt.origin==='test'||/do not use tools|integration (?:check|test)|answer with that word only|reply with only that phrase|based only on the saved context/i.test(receipt.transcript);
const affirmation=text=>/^(?:yes(?: please)?(?: (?:do (?:it|that)|go ahead))?|yeah|yep|sure|absolutely|go ahead|do (?:it|that)|let'?s do (?:it|that)|please do(?: (?:it|that))?|go for it|sounds good)(?: please)?(?: jarvis)?[.!?\s]*$/i.test(text.trim().replace(/,/g,' ').replace(/\s+/g,' '));
const exchange=other=>({you:other.transcript,jarvis:other.reply||'',...(other.pendingSkill?{pendingSkill:other.pendingSkill}:{}),...(other.lookupRoute?{lookupRoute:other.lookupRoute}:{})});

export function buildReplayCases(input){
 const receipts=input.filter(receipt=>receipt&&typeof receipt.transcript==='string').sort((a,b)=>a.ts-b.ts);
 const seen=new Set(),cases=[];let skipped=0;
 for(const [index,receipt] of receipts.entries()){
  if(!reachedClassifier(receipt))continue;
  const intent=newTaskIntent(receipt.transcript);
  const transcript=stripPleasantry(intent?intent.payload:receipt.transcript).trim();
  if(!transcript||affirmation(transcript)){skipped++;continue}
  const workTarget=intent?null:receipt.workTarget||null;
  // The router classified before any reset: an explicit new task was routed in
  // the epoch before the one its receipt records, at roughly ts - routingMs.
  const epoch=(receipt.conversationEpoch??0)-(intent&&!receipt.conversationSuperseded?1:0);
  const routedAt=receipt.ts-(typeof receipt.routingMs==='number'?receipt.routingMs:0);
  const memory=receipts.slice(0,index).filter(other=>other.provider===receipt.provider&&scope(other)===scope(receipt)&&routedAt-other.ts<10*60*1000&&(other.conversationEpoch??0)===epoch).slice(-6);
  // A task is titled by the request that created it.
  const creator=workTarget?receipts.find(other=>other.workIds?.includes(workTarget)):null;
  const exchanges=intent?[]:memory.filter(other=>(other.workTarget||null)===workTarget||(workTarget&&!other.workTarget&&other.workIds?.length===1&&other.workIds[0]===workTarget)).slice(-2).map(exchange);
  const reconstruction=[...(exchanges.length?['lookup inspectors ran without previous-lookup context']:[]),...(workTarget?['selected worker\'s last result unavailable','task state assumed ready']:[]),...(creator||!workTarget?[]:['task title unavailable'])];
  // Router rule: an explicit new task about "that story" may carry the last quick
  // answer (execution tier 1-2, under three minutes old) into the new conversation.
  if(intent&&/\b(?:that story|that report|that answer|those findings)\b/i.test(transcript)){
   const latest=memory.at(-1);
   if(latest&&latest.tier<=2&&routedAt-latest.ts<180000)exchanges.push(exchange(latest));
   reconstruction.push('new-conversation reference: pre-reset epoch and routing time inferred');
  }
  const duplicate=seen.has(transcript.toLowerCase());seen.add(transcript.toLowerCase());
  cases.push({id:`replay-${String(cases.length+1).padStart(3,'0')}`,source:'replay',receiptId:receipt.id,provider:receipt.provider,transcript,
   state:{separateTasks:!!intent?.multiple,newConversation:!!intent,
    compound:compoundBriefRequest(transcript,{compound:!intent?.multiple&&compoundHint(transcript),guarded:Boolean(inspectBriefSectionRequest(transcript).guarded||inspectBriefRequest(transcript).guarded||inspectLocalLookup(transcript).guarded)}),
    target:workTarget?{title:(creator?.transcript||'Selected conversation').slice(0,120),state:'ready',lastAnswer:''}:null,exchanges},
   reconstruction,suspectedTest:looksLikeTest(receipt),duplicate,label:null});
 }
 return {cases,skipped};
}
