const WINDOW=90000,TALK_OVER=2500,TALK_OVER_WORDS=12;
export const CORRECTION_RE=/(?:\b(?:actually|wait|hold on|never\s*mind|scratch that|no|instead)\b|\b(?:don['’]?t|do not|didn['’]?t mean)\b)/i;
const UNDO_CANCEL_RE=/\b(?:stop|wait|cancel|hold on|hang on|no|don['’]?t|do not|never\s*mind|scratch that)\b/i;
const offset=value=>Number.isFinite(value)&&value>=0?value:null;
const join=rows=>rows.map(row=>row.text).join('').trim();
function recentOffer(exchanges,anchor,at){
 const rows=exchanges.findLast(turn=>!turn.user)?.rows,last=rows?.at(-1);
 if(!last||anchor-last.offset>60000||at-last.at>60000)return null;
 const text=join(rows),cue=/\b(?:want me to|should I|shall I|would you like me to|I can\b[^.!?]*?\bif you)\b/i.exec(text);
 if(!cue&&!/\?["”’']?$/.test(text))return null;
 const chars=Array.from(text);
 if(chars.length<=400)return text;
 // Keep the actual offer when it follows a long spoken explanation.
 if(!cue)return '…'+chars.slice(-399).join('');
 const offered=Array.from(text.slice(cue.index));
 return offered.length>400?offered.slice(0,399).join('')+'…':offered.join('');
}
export class LiveTurns {
 constructor(startedAt){this.startedAt=startedAt;this.rows=[];this.index=0;this.used=-1}
 prune(now){this.rows=this.rows.filter(row=>now-row.at<=WINDOW).slice(-2000)}
 add(event,now){
  const text=typeof event.delta==='string'?event.delta:event.delta?.text;
  if(typeof text!=='string'||!text)return null;
  const row={index:++this.index,at:now,offset:offset(event.offset_ms??event.delta?.offset_ms??event.end_offset_ms??event.end_ms)??Math.max(0,now-this.startedAt),
   user:event.type==='session.input_transcript.delta',turnId:event.turn_id??event.item_id??null,text:text.slice(0,4000)};
  this.rows.push(row);this.prune(now);return row;
 }
 anchor(event,now){return offset(event.delegation.offset_ms??event.offset_ms)??Math.max(0,now-this.startedAt)}
 take(anchor,now){
  this.prune(now);
  const rows=this.rows.filter(row=>row.offset<=anchor).sort((a,b)=>a.offset-b.offset||a.index-b.index);
  const last=rows.findLast(row=>row.user&&row.offset>this.used&&row.text.trim());
  if(!last)return null;
  // The caller's words, back to where their turn began. When Live talks over them (2026-11-26 test call: "On that
  // outline, make sure it has a quick section on cost per hour" reached routing as its last half), Live's words in
  // between are skipped as long as the caller kept going: their next words came within TALK_OVER of the last ones,
  // and Live said only a few words meanwhile, none of them a question (a question hands the caller the floor).
  let first=rows.indexOf(last),earliest=last,between='';
  for(let i=first-1;i>=0;i--){
   const previous=rows[i];
   if(previous.offset<=this.used)break;
   if(!previous.user){between=previous.text+between;continue}
   if(between){
    const said=between.trim();
    if(earliest.at-previous.at>TALK_OVER||/\?/.test(said)||said.split(/\s+/).length>TALK_OVER_WORDS)break;
   }else if(last.turnId!==null&&previous.turnId!==last.turnId)break;
   if(previous.text.trim())earliest=previous;
   first=i;between='';
  }
  const utterance=rows.slice(first,rows.indexOf(last)+1).filter(row=>row.user);
  this.used=Math.max(this.used,anchor);
  const exchanges=[];
  for(const row of rows.slice(0,first)){
   const tail=exchanges.at(-1);
   if(tail?.user===row.user&&tail.turnId===row.turnId)tail.rows.push(row);else exchanges.push({user:row.user,turnId:row.turnId,rows:[row]});
  }
  const lastAt=Math.max(...utterance.map(row=>row.at));
  // A turn picked up after an earlier hand-off took its first half can start with that half's full stop (". Check the web…").
  return {text:join(utterance).replace(/^[\s.,;:!?…-]+/,'').slice(0,4000),firstOffset:utterance[0].offset,lastAt,offer:recentOffer(exchanges,anchor,lastAt),
   preceding:exchanges.slice(-8).map(turn=>({role:turn.user?'user':'assistant',text:join(turn.rows).slice(-800)}))};
 }
 skip(anchor){this.used=Math.max(this.used,anchor)}
 // What the caller said from this point on, for telling a real cancel from a "wait" inside a request.
 textFrom(offset){return join(this.rows.filter(row=>row.user&&row.offset>=offset).sort((a,b)=>a.offset-b.offset||a.index-b.index)).replace(/^[\s.,;:!?…-]+/,'').trim()}
 // The caller was still mid-sentence at a hand-off and kept going: the words before it end without a full stop, the
 // words after it are the same turn (no other turn id) and are not a correction or a cancel.
 continuesAfter(anchor){
  const user=this.rows.filter(row=>row.user&&row.text.trim()&&row.offset>this.used).sort((a,b)=>a.offset-b.offset||a.index-b.index);
  const before=user.filter(row=>row.offset<=anchor),after=user.filter(row=>row.offset>anchor),last=before.at(-1);
  if(!last||!after.length||/[.!?]["”’']?\s*$/.test(last.text))return false;
  if(after.some(row=>row.turnId!==null&&last.turnId!==null&&row.turnId!==last.turnId))return false;
  const more=join(after);
  return !UNDO_CANCEL_RE.test(more)&&!CORRECTION_RE.test(more);
 }
 undoInterruptionAfter(anchor,until){
  const rows=this.rows.filter(row=>row.offset>anchor&&row.at<=until).sort((a,b)=>a.offset-b.offset||a.index-b.index);
  const utterances=new Map();
  let implicitTurn=null;
  for(const row of rows){
   if(!row.user){implicitTurn=row;continue}
   const key=row.turnId??implicitTurn;
   if(!utterances.has(key))utterances.set(key,[]);
   utterances.get(key).push(row);
  }
  for(const utterance of utterances.values()){
   const text=join(utterance),cancel=UNDO_CANCEL_RE.test(text);
   if(cancel||CORRECTION_RE.test(text))return {offset:utterance.at(-1).offset,cancel};
  }
  return null;
 }
 correctionAfter(anchor){return CORRECTION_RE.test(join(this.rows.filter(row=>row.user&&row.offset>anchor).slice(-20)))}
}
