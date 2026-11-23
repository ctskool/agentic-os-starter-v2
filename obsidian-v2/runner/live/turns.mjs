const WINDOW=90000;
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
  let first=rows.indexOf(last);
  while(first>0){
   const previous=rows[first-1];
   if(!previous.user||previous.offset<=this.used||last.turnId!==null&&previous.turnId!==last.turnId)break;
   first--;
  }
  const utterance=rows.slice(first,rows.indexOf(last)+1);
  this.used=Math.max(this.used,anchor);
  const exchanges=[];
  for(const row of rows.slice(0,first)){
   const tail=exchanges.at(-1);
   if(tail?.user===row.user&&tail.turnId===row.turnId)tail.rows.push(row);else exchanges.push({user:row.user,turnId:row.turnId,rows:[row]});
  }
  const lastAt=Math.max(...utterance.map(row=>row.at));
  return {text:join(utterance).slice(0,4000),firstOffset:utterance[0].offset,lastAt,offer:recentOffer(exchanges,anchor,lastAt),
   preceding:exchanges.slice(-8).map(turn=>({role:turn.user?'user':'assistant',text:join(turn.rows).slice(-800)}))};
 }
 skip(anchor){this.used=Math.max(this.used,anchor)}
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
