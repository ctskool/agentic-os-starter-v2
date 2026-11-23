import type {RunEntry} from './vault';

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
export function liveActivityCallout(cards:WorkflowCallout[],item:{key:string;phase:string;label:string},nextId:()=>number,now=Date.now()):WorkflowCallout[] {
  const target=`live:${item.key}`,existing=cards.find(card=>card.target===target);
  if(item.phase==='dropped')return existing?cards.filter(card=>card!==existing):cards;
  // The card shows about sixteen characters of its label, so the label is the thing itself (Inbox Brief, Morning brief)
  // and the line under it says what is happening to it. The full text is the hover title.
  const name=(text:string,fallback:string)=>{const short=text.replace(/^(?:start|the)\s+/i,'').trim()||fallback;return short.charAt(0).toUpperCase()+short.slice(1)};
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
