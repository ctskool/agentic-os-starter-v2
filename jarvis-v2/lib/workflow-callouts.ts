import type {RunEntry} from './vault';
import {activityState,type ActivityTask} from '../../obsidian-v2/shared/task-activity';

export interface WorkflowCallout {
  id:number;
  kind:'doc'|'link'|'task';
  target:string;
  label:string;
  slot:number;
  startedAt?:number;
  etaS?:number|null;
  phase?:'queued'|'working'|'done'|'failed';
  detail?:string;
  note?:string;
  liveReport?:boolean;
  /** The conversation a call's hand-off started or added to. The card stays up until that conversation finishes. */
  taskId?:string;
  boundAt?:number;
  sawWorking?:boolean;
  attention?:boolean;
}

export const isPendingCallout=(card:WorkflowCallout)=>card.kind==='task'&&(card.phase==='queued'||card.phase==='working');

export function queueWorkflowCallout(cards:WorkflowCallout[],id:string,label:string,nextId:()=>number):WorkflowCallout[] {
  if(cards.some(card=>card.target===`run:${id}`))return cards;
  const used=new Set(cards.map(card=>card.slot)),free=[0,1,2,3].find(slot=>!used.has(slot));
  const victim=free===undefined?(cards.find(card=>!isPendingCallout(card))??cards[0]):null;
  const entry:WorkflowCallout={id:nextId(),kind:'task',target:`run:${id}`,label,slot:free??victim!.slot,phase:'queued',startedAt:Date.now()};
  return [...cards.filter(card=>card!==victim),entry];
}

// Reconcile by run ID, including jobs that finish before the first dashboard poll.
// A completed workflow becomes a report link; it never selects a CLI conversation.
export function reconcileWorkflowCallouts(cards:WorkflowCallout[],runs:RunEntry[],etas:Record<string,number>,nextId:()=>number):WorkflowCallout[] {
  let next=cards;
  for(const run of runs){
    let existing=next.find(card=>card.kind==='task'&&card.target===`run:${run.id}`);
    if(run.status==='running'&&!existing){
      next=queueWorkflowCallout(next,run.id,run.label??run.skill.replace(/-/g,' '),nextId);
      existing=next.find(card=>card.target===`run:${run.id}`);
    }
    if(!existing||!isPendingCallout(existing))continue;
    if(run.status==='running'){
      if(existing.phase==='working')continue;
      next=next.map(card=>card===existing?{...card,phase:'working',startedAt:run.ts_started?Date.parse(run.ts_started):card.startedAt,etaS:etas[run.skill]??null}:card);
    }else if(run.status==='ok'&&run.deliverable_path){
      next=next.map(card=>card===existing?{...card,kind:run.link?'link':'doc',target:run.link??run.deliverable_path!,phase:undefined}:card);
    }else if(run.status==='ok'||run.status==='error'){
      next=next.map(card=>card===existing?{...card,phase:run.status==='ok'?'done':'failed',detail:run.status==='error'?run.summary:undefined}:card);
    }
  }
  return next;
}

// A Live hand-off shows beside the orb like a skill run: what V2 is doing with what was said.
// The card is keyed by the hand-off, so each phase updates it in place; an answered or started card clears like a finished run.
export function liveActivityCallout(cards:WorkflowCallout[],item:{key:string;phase:string;label:string;taskIds?:string[]},nextId:()=>number,now=Date.now()):WorkflowCallout[] {
  const target=`live:${item.key}`,existing=cards.find(card=>card.target===target);
  if(item.phase==='dropped')return existing?cards.filter(card=>card!==existing):cards;
  // The card shows about sixteen characters of its label, so the label is the thing itself (Inbox Brief, Morning brief)
  // and the line under it says what is happening to it. The full text is the hover title.
  // A request in the person's own words arrives quoted ("Start “make me a one-pager…” in your Claude terminal"): the
  // words are the name. A follow-up names no words ("Continue “that task”"), so it is a follow-up until the task's title is known.
  const name=(text:string,fallback:string)=>{
    const quoted=text.match(/“([^”]+)”/)?.[1];
    if(quoted)return /^that task$/i.test(quoted)?'Follow-up':taskCardLabel(quoted,fallback);
    const short=text.replace(/^(?:start|the)\s+/i,'').trim()||fallback;return short.charAt(0).toUpperCase()+short.slice(1);
  };
  if(item.phase==='started'&&item.taskIds?.length){
    // The hand-off started real work: the card now follows that conversation (reconcileTaskCallouts) instead of clearing.
    // One card per conversation: an earlier card for the same one gives way to this request's card.
    const taskId=item.taskIds[0],bound={label:name(item.label,'Task'),phase:'working' as const,note:'working',detail:item.label,taskId,boundAt:now,sawWorking:false,attention:false};
    const kept=cards.filter(card=>card===existing||card.taskId!==taskId);
    if(existing)return kept.map(card=>card===existing?{...card,...bound}:card);
    const taken=new Set(kept.map(card=>card.slot)),open=[0,1,2,3].find(slot=>!taken.has(slot));
    const yields=open===undefined?(kept.find(card=>!isPendingCallout(card))??kept[0]):null;
    return [...kept.filter(card=>card!==yields),{id:nextId(),kind:'task',target,slot:open??yields!.slot,startedAt:now,...bound}];
  }
  const view=item.phase==='handoff'?{label:'Handing off',phase:'working' as const,note:'V2 is working it out',detail:'Live handed this to V2'}:
    item.phase==='starting'?{label:name(item.label,'Task'),phase:'working' as const,note:'starting',detail:item.label}:
    item.phase==='answered'?{label:name(item.label,'Saved notes'),phase:'done' as const,note:'answered from this',detail:`V2 answered from ${item.label||'saved notes'}`}:
    item.phase==='started'?{label:name(item.label,'Task'),phase:'done' as const,note:'started',detail:item.label}:null;
  if(!view)return cards;
  if(existing)return cards.map(card=>card===existing?{...card,...view}:card);
  const used=new Set(cards.map(card=>card.slot)),free=[0,1,2,3].find(slot=>!used.has(slot));
  const victim=free===undefined?(cards.find(card=>!isPendingCallout(card))??cards[0]):null;
  return [...cards.filter(card=>card!==victim),{id:nextId(),kind:'task',target,slot:free??victim!.slot,startedAt:now,...view}];
}

// A Claude task is renamed by the bridge a second or two after it starts, from the short title Claude Code writes for
// the session ("Riemann hypothesis one-pager"). Until then, and for Codex, the card has only the words that were
// said, so the way of asking is taken off the front ("Yeah, can you do some research on X" reads "Research on X")
// along with quote marks and the ums. The hover title keeps the full words.
const FILLER=/^(?:(?:ok(?:ay)?|so|hey|yeah|yes|yep|sure|actually|alright|all right|please|now|and|well|um+|uh+|jarvis)[,.\s]+)+/i;
const ASKING=/^(?:(?:can|could|would|will) you(?: please| just)?(?: go ahead and)?|i(?: want| need|'d like| would like)(?: you)? to|go ahead and|please|just)\s+/i;
// Only the verbs that hand over a thing: "do some research", "build me a one-pager". "Make the intro shorter" is the request itself.
const HANDING=/^(?:do (?:some|a|an) |(?:make|build|create|write|draft|give|get|put together) me (?:(?:a|an|the|some) )?)/i;
export function taskCardLabel(text:string|undefined,fallback='Task'){
  let clean=String(text||'').replace(/\s+/g,' ').trim().replace(/^[“"'‘]+|[”"'’]+$/g,'').replace(/[,]?\s+(?:um+|uh+|er+)[,.]?(?=\s)/gi,'');
  for(let round=0;round<3;round++)clean=clean.replace(FILLER,'').replace(ASKING,'');
  clean=clean.replace(HANDING,'').trim();
  return /[\p{L}\p{N}]/u.test(clean)?clean.charAt(0).toUpperCase()+clean.slice(1):fallback;
}

// How long a just-bound card waits for its conversation to be seen working before a "finished" reading is believed
// (the task list can be a moment older than the hand-off), and how long a card waits for a conversation that is not listed.
export const TASK_CARD_SETTLE_MS=8000;
export const TASK_CARD_MISSING_MS=20000;
type CardTask=ActivityTask&{queuedFollowups?:number};

// A card bound to a conversation stays up while it works, says so when it needs the person, and finishes when it does:
// complete (cleared like any finished run), failed (kept with the error), or gone when the conversation was stopped.
// Returns the same array when nothing changed, so the clear-after-complete timer is not restarted by every poll.
export function reconcileTaskCallouts(cards:WorkflowCallout[],tasks:CardTask[],loaded:boolean,now=Date.now()):WorkflowCallout[] {
  if(!cards.some(card=>card.taskId&&isPendingCallout(card)))return cards;
  const runs=new Set(cards.filter(card=>card.target.startsWith('run:')).map(card=>card.target));
  let changed=false;
  const next=cards.flatMap(card=>{
    if(!card.taskId||!isPendingCallout(card))return [card];
    const drop=()=>{changed=true;return [] as WorkflowCallout[]};
    const set=(patch:Partial<WorkflowCallout>)=>{
      if((Object.keys(patch) as (keyof WorkflowCallout)[]).every(key=>card[key]===patch[key]))return [card];
      changed=true;return [{...card,...patch}];
    };
    // A background workflow has its own run card, with its report link when it lands.
    if(runs.has('run:'+card.taskId))return drop();
    const task=tasks.find(item=>item.id===card.taskId),age=now-(card.boundAt??now);
    if(!task)return loaded&&age>TASK_CARD_MISSING_MS?drop():[card];
    const label=taskCardLabel(task.title,card.label),state=activityState(task);
    if(state==='working')return set({label,phase:'working',note:task.state==='stopping'?'stopping':'working',sawWorking:true,attention:false});
    if(state==='needs input')return set({label,phase:'working',note:'needs you',sawWorking:true,attention:true});
    const finishedTurn=(task.turns?.at(-1)?.ts??0)>=(card.boundAt??Infinity);
    if(!card.sawWorking&&!finishedTurn&&age<=TASK_CARD_SETTLE_MS)return set({label});
    if(task.queuedFollowups)return set({label,phase:'working',note:'waiting its turn',attention:false});
    if(state==='failed')return set({label,phase:'failed',note:undefined,detail:task.error||card.detail,attention:false});
    // Stopped by hand before it answered: nothing finished, so nothing to announce.
    if(['stopped','closed'].includes(task.state)&&!finishedTurn||state===null)return drop();
    return set({label,phase:'done',note:undefined,attention:false});
  });
  return changed?next:cards;
}
