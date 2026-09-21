import {randomInt} from 'node:crypto';
import {SKILLS} from '../shared/contract.mjs';

const starts=["Sure, I'll get started.","Okay, I'll work on that.","Let me get that underway.","All right, I'm on it.","I'll take care of that.","Sure, let me work through that.","Okay, I'll get to work.","Let me take a look."];
// A reused CLI is not proof of a revision: it can receive an unrelated subject.
const followups=["Sure, let me work through that.","Okay, I'll take a look.","All right, I'm on it.","Let me see what I can do.","Sure, I'll work on that.","Okay, let me handle that.","I'll take it from here.","Let me get into that."];
const workflowObjects={
 'vault-summary':'the vault summary','plan-today':"today's plan",'plan-tomorrow':"tomorrow's plan",'refresh-schedule':'the schedule update',
 'morning-intel':'the intel brief','inbox-brief':'the inbox brief','deep-research-chase':'the research','content-cascade':'the content drafts',
 'yt-pipeline':'the YouTube research','weekly-review':'the weekly review','vault-cleanup':'the vault review','metrics-pull':'the metrics refresh',
 'github-trending':'the GitHub update','yt-week-review':'the YouTube review','outlier-radar':'the outlier scan','lead-research':'the lead research',
 'morning':'the morning brief','morning-report':'the morning report','ai-trend-scan':'the AI trend scan','angle-brainstorm':'the brainstorm',
 'outline-build':'the outline'
};
const words=text=>String(text||'').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
const functionWords=new Set(words("I I'll I'm I will am let me sure okay ok all right please a an the this that it those these your on for of to and in into through at with get getting take taking care work working start started help handle handling"));
function acceptanceVocabulary(request){
 const requested=new Set(words(request));
 // This changes presentation only. Obvious editing language can ground the
 // classifier's synonym without turning a reused terminal into a revision.
 const text=String(request||'').replace(/[’‘]/g,"'");
 const negative=/\b(?:don't|do not|never|without|no need to)\b/i.test(text);
 if(!negative&&(/\b(?:adjust|revise|edit|change|modify|tweak)\b/i.test(text)||/\bmake (?:it|that|this)\b.{0,90}\b(?:instead|shorter|longer|larger|smaller|faster|slower|clearer|simpler|brighter|darker)\b/i.test(text)))for(const word of ['adjust','revise','update','edit','change','modify','tweak'])requested.add(word);
 return requested;
}

// Reuse useful wording the existing classifier already supplied. Only a short,
// prospective acceptance whose concrete terms occur in the request is eligible.
// This is output validation, not another intent classifier or model call.
export function groundedAcceptance(reply,request){
 const text=String(reply||'').replace(/[’‘]/g,"'").trim();
 if(!text||text.length>115||words(text).length>20||/[\n\r\[\]<>`#|{}?]/.test(text))return null;
 if(!/^(?:(?:sure|okay|ok|all right)[,.]?\s+)?(?:I(?:'ll| will)\s+|let me\s+|I'm (?:working|looking|getting|taking|handling)\b)/i.test(text))return null;
 if(/\b(?:done|ready|complete[ds]?|finished|saved|created|sent|uploaded|deleted|approved|guarantee|definitely|already|successfully|seconds?|minutes?|hours?|but|except|cannot|can't|couldn't|not|won't)\b|https?:|\d/i.test(text))return null;
 const requested=acceptanceVocabulary(request);
 const concrete=words(text).filter(word=>!functionWords.has(word));
 if(concrete.length&&/\b(?:don't|do not|never|without|no need to)\b/i.test(String(request).replace(/[’‘]/g,"'")))return null;
 if(concrete.some(word=>!requested.has(word)))return null;
 const source=words(request).join(' '),spokenWords=words(text),spoken=spokenWords.join(' ');
 if(words(request).length>=8&&source.includes(spoken))return null;
 if(spokenWords.some((_word,index)=>index+8<=spokenWords.length&&source.includes(spokenWords.slice(index,index+8).join(' '))))return null;
 // Long near-verbatim task descriptions are still an echo, even after "I'll".
 if(concrete.length>8)return null;
 return /[.!]$/.test(text)?text:text+'.';
}

export function createWorkAcknowledgments({choose=length=>randomInt(length)}={}){
 const recent=new Map();
 return ({provider='codex',count=1,continuation=false,skill='voice-ask',classifiedReply='',request='',engine='rules'}={})=>{
  const previous=recent.get(provider)||[];
  const object=workflowObjects[skill];
  const pool=count>1?[
   `I'll get those ${count} tasks underway.`, `Okay, I'll start those ${count} tasks.`, `I'll work on those ${count} tasks.`
  ]:object?[`I'll get started on ${object}.`,`Okay, I'll work on ${object}.`,`Let me take care of ${object}.`,`All right, let me handle ${object}.`,`I'll get ${object} underway.`]:continuation?followups:starts;
  const candidate=count===1&&engine!=='rules'?groundedAcceptance(classifiedReply,request):null;
  const options=pool.filter(text=>!previous.includes(text));
  const available=options.length?options:pool.filter(text=>text!==previous.at(-1));
  const reply=candidate&&!previous.includes(candidate)?candidate:available[Math.min(available.length-1,Math.max(0,choose(available.length)))];
  recent.set(provider,[...previous,reply].slice(-4));return reply;
 };
}

// Labels come from an actual workflow or a named artifact in the worker's
// result, never from the dictated task title or an invented topic summary.
export function completionLabel(record,turn){
 const skill=record?.workflow?.job?.skill||record?.workflow?.skill;
 if(skill&&skill!=='voice-ask'&&Object.hasOwn(SKILLS,skill))return workflowObjects[skill]?.replace(/^the /,'')||SKILLS[skill].label.toLowerCase();
 const text=String(turn?.text||'');
 for(const match of text.matchAll(/\[([^\]\r\n]{1,60})\]\(([^)\r\n]+)\)/g)){
  if(!/\.(?:svg|png|jpe?g|webp|pdf|pptx|docx|html)(?:[?#]|$)/i.test(match[2]))continue;
  const label=match[1].replace(/[*_`]/g,'').trim();
  if(words(label).length>7||/[\\/:]|[\p{Extended_Pictographic}]/u.test(label)||/^(?:here|view|open|download|read|click|the output file)(?:\s+(?:it|this|here|file|result))?$/i.test(label))continue;
  return label;
 }
 if(/\.(?:svg|png|jpe?g|webp)(?:[?#)\s]|$)/i.test(text))return 'graphic';
 if(/\.(?:pdf|docx|pptx|html)(?:[?#)\s]|$)/i.test(text))return 'document';
 return record?.provider==='claude'?'Claude Code':record?.provider==='codex'?'Codex':null;
}
