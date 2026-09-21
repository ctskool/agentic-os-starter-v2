import fs from 'node:fs';
import {vaultPath} from './core.mjs';
import {BRIEF_SECTION_IDS,parseBriefSections,validBriefSectionRequest,briefSectionAnswer} from './brief-sections.mjs';

const folders=['inbox/research/morning-intel','inbox/reports/morning'];
export const localDate=(now=new Date())=>`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

// Only short, read-only briefing questions bypass the general router. A request
// to research, verify, or produce something must retain its full workflow.
export function isBriefQuestion(utterance){
 const text=utterance.toLowerCase().replace(/[’]/g,"'").trim();
 if(text.length>300||/\b(research|browse|search|verify|fact.check|write|draft|publish|send|create|generate|run|refresh|update|compare|analy[sz]e|deep|right now|since the brief|after the brief|latest developments)\b/.test(text))return false;
 if(!/^(?:(?:so|hey|okay|ok|please)[,\s]+)*(?:what|tell|read|summari[sz]e|give|recap|catch me up)\b/.test(text))return false;
 return /\bmorning (?:intel|brief(?:ing)?)\b/.test(text)||
  (/\b(?:ai|artificial intelligence)\b/.test(text)&&/\b(?:news|headlines?|stor(?:y|ies)|happened)\b/.test(text)&&/\b(?:today|this morning)\b/.test(text));
}

export {briefLookupPlan,inspectBriefRequest} from './brief-intent.mjs';
import {briefLookupPlan,validPlanItem} from './brief-intent.mjs';
export function hackerNewsRanking(utterance){
 const plan=briefLookupPlan(utterance);
 return plan?.length===1&&plan[0].source==='hn'&&!plan[0].count&&!plan[0].offset?plan[0].rank:null;
}

function spoken(text){
 return text.replace(/<!--[^]*?-->/g,'').replace(/!\[[^\]]*\]\([^)]*\)/g,'')
  .replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/https?:\/\/\S+/g,'')
  .replace(/[*_`#]/g,'').replace(/^[-\s]+/,'').replace(/\s+/g,' ').trim();
}
function section(raw,title){
 const match=new RegExp(`^#{2,3}\\s+${title}\\s*\\r?$([\\s\\S]*?)(?=^#{1,3}\\s|$(?![\\s\\S]))`,'im').exec(raw);
 return match?.[1]?.trim()||'';
}
export function parseHackerNews(raw){
 const body=section(raw,'(?:Hacker\\s+News|HN)(?:\\s+Pulse)?');
 // Bound work, and never treat a truncated or partly malformed table as a
 // complete ranking. Markdown report contents remain data, not instructions.
 if(!body||body.length>32000)return [];
 const lines=body.split(/\r?\n/),rows=[];
 let columns=null,started=false;
 for(const line of lines){
  if(!line.trim().startsWith('|')){if(started&&line.trim())break;continue}
  const cells=line.trim().replace(/^\||\|$/g,'').split(/(?<!\\)\|/).map(cell=>cell.trim().replace(/\\\|/g,'|'));
  if(!columns){
   const headers=cells.map(cell=>spoken(cell).toLowerCase());
   const points=headers.findIndex(h=>/^(?:pts|points|score)$/.test(h)),comments=headers.findIndex(h=>/^(?:comments|replies)$/.test(h)),title=headers.findIndex(h=>/^(?:story|title|item)$/.test(h));
   if(points>=0&&comments>=0&&title>=0)columns={points,comments,title,count:cells.length};
   continue;
  }
  if(cells.every(cell=>/^:?-{3,}:?$/.test(cell)))continue;
  started=true;
  if(cells.length!==columns.count||rows.length>=100)return [];
  const number=cell=>/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(cell)?Number(cell.replace(/,/g,'')):NaN;
  const points=number(cells[columns.points]),comments=number(cells[columns.comments]),title=spoken(cells[columns.title]).slice(0,180);
  if(!Number.isSafeInteger(points)||!Number.isSafeInteger(comments)||!title)return [];
  const url=cells[columns.title].match(/https?:\/\/[^\s)<>]+/)?.[0]||null;
  rows.push({title,points,comments,url:url&&url.length<=300?url:null});
 }
 return rows;
}

// One cache per vault, with bounded retained roots and no timers. Directory
// metadata detects new/deleted reports; selected file metadata detects edits.
// Every access still passes vaultPath, so a replacement symlink cannot reuse a
// previously safe cached file. Only the chosen report is read and parsed.
const catalogs=new Map(),MAX_ROOTS=8;
function stat(file){try{return fs.statSync(file);}catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))return null;throw error;}}
function stamp(value){return value?`${value.dev}:${value.ino}:${value.mtimeMs}:${value.ctimeMs}:${value.size}`:'missing';}
function discovery(root,today,cache){
 const dirs=folders.map(folder=>({folder,directory:vaultPath(root,folder)}));
 const signature=today+'|'+dirs.map(d=>stamp(stat(d.directory))).join('|');
 // Some filesystems defer directory timestamps. Do not negative-cache a
 // missing current report; it must appear on the very next lookup.
 if(cache.signature!==signature||!cache.files?.some(f=>f.date===today)){
  cache.signature=signature;cache.files=[];
  for(const [priority,{folder,directory}] of dirs.entries()){
   const ds=stat(directory);if(!ds?.isDirectory())continue;
   const names=fs.readdirSync(directory).filter(name=>/^\d{4}-\d{2}-\d{2}[^/\\]*\.md$/.test(name)&&!name.endsWith('_index.md')&&name.slice(0,10)<=today).sort().reverse().slice(0,256);
   for(const name of names)cache.files.push({relative:`${folder}/${name}`,date:name.slice(0,10),priority});
  }
 }
 // At most the latest date's candidates need metadata. Do not stat an entire
 // archive merely to locate the current briefing.
 const latest=cache.files.reduce((date,f)=>f.date>date?f.date:date,'');
 return cache.files.filter(f=>f.date===latest).flatMap(f=>{
  const file=vaultPath(root,f.relative),metadata=stat(file);
  return metadata?.isFile()?[{...f,file,metadata}]:[];
 }).sort((a,b)=>a.priority-b.priority||b.metadata.mtimeMs-a.metadata.mtimeMs)[0];
}
// The Top Story section as far as the story goes. The COMPLETE section is cleaned before anything is cut or split:
// comments go first and whole (they may start in the headline and span paragraphs; an unclosed one hides everything
// after it), zero-width characters go too. Then the text ends at the first line that is a Sources label ("Sources:", behind
// any list marker, quote mark or emphasis), is a rule (also a spaced one), is a heading of any depth, underlines a
// setext heading (that heading's text goes with it), or is a table row. A false stop only loses detail; a missed
// one could read a private note aloud.
function storyText(text){
 let clean=text.replace(/<!--[\s\S]*?-->/g,'').replace(/[\u200B-\u200D\u2060\uFEFF]/g,'');
 const unclosed=clean.indexOf('<!--');if(unclosed>=0)clean=clean.slice(0,unclosed);
 const lines=[];
 for(const line of clean.split('\n')){
  const bare=line.replace(/[*_~`]/g,'').replace(/^[\s>]*(?:(?:[-+]|\d+[.)])\s+)?[\s>]*/,'');
  if(/^(?:sources?|references?|citations?|links?)(?:\s*\(\d+\))?(?:\s*[:：]|\s+[—–-]\s|\s*$)/i.test(bare)||/^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)||/^\s{0,3}#{1,6}(?:\s|$)/.test(line)||/^\s*\|/.test(line))break;
  if(/^\s{0,3}=+\s*$/.test(line)){while(lines.length&&!lines.at(-1).trim())lines.pop();lines.pop();break}
  lines.push(line);
 }
 // A dash underline was caught as a rule above; the setext heading text it belonged to must go as well.
 if(/^\s{0,3}-{2,}\s*$/.test(clean.split('\n')[lines.length]||'')&&lines.length&&lines.at(-1).trim())lines.pop();
 return lines.join('\n').trim();
}
function shorten(text,limit){return text.length>limit?text.slice(0,limit-1).replace(/\s+\S*$/,'')+'…':text;}
function publicFacts(raw){
 // The Top Story section is editorial news: a headline paragraph, then the story. Its paragraphs are public facts up to
 // a Sources line or a rule; everything after that, and every other section, stays out as before.
 const written=section(raw,'Top Story'),story=storyText(written).split(/\n\s*\n/),top=story[0]||'';
 const topStoryDetail=[];let detailBudget=3000;
 for(const paragraph of story.slice(1,9)){
  const text=shorten(spoken(paragraph),700);if(!text)continue;
  if(text.length>detailBudget)break;topStoryDetail.push(text);detailBudget-=text.length;
 }
 const fallback=section(raw,'(?:TL;DR|Headlines)').split('\n').find(line=>/^\s*(?:[-*]\s*)?(?:\*\*)?top story:/i.test(line));
 // The TL;DR line is only a fallback for briefs WITHOUT a Top Story heading. A section that exists, even empty, or cleans to
 // nothing must not hand the answer to TL;DR, which can hold private items.
 const headline=shorten(spoken(top||(written||/^#{2,3}\s+Top Story\s*$/im.test(raw)?'':fallback)||''),650);
 // Only the explicitly public Headlines section supplies additional items.
 // TL;DR and AI News often mix private inbox, embargo or handoff information.
 const explicit=section(raw,'Headlines').split('\n').filter(line=>/^\s*(?:[-*]|\d+[.)])\s+/.test(line)).map(line=>shorten(spoken(line.replace(/^\s*(?:[-*]|\d+[.)])\s+/,'')),240)).filter(Boolean);
 const headlines=[...new Set([...(headline?[headline]:[]),...explicit])].slice(0,5);
 const hn=parseHackerNews(raw),ranked=[...hn].sort((a,b)=>b.points-a.points).slice(0,5),discussed=[...hn].sort((a,b)=>b.comments-a.comments).slice(0,5);
 return {headline,topStoryDetail,headlines,hackerNews:[...new Set([...ranked,...discussed])],hackerNewsCount:hn.length};
}
export function getBriefCatalog(root,now=new Date(),{includeSummary=false,sections=[]}={}){
 if(!Array.isArray(sections)||sections.length>BRIEF_SECTION_IDS.length||sections.some(id=>!BRIEF_SECTION_IDS.includes(id)))throw new Error('Unsupported saved briefing section');
 const today=localDate(now);let cache=catalogs.get(root);
 if(!cache){cache={};catalogs.set(root,cache);if(catalogs.size>MAX_ROOTS)catalogs.delete(catalogs.keys().next().value);}
 else{catalogs.delete(root);catalogs.set(root,cache);}
 const source=discovery(root,today,cache);
 const base={date:source?.date||today,briefSource:source?.relative||null,headline:'',topStoryDetail:[],headlines:[],hackerNews:[]};
 if(!source||source.date!==today)return {...base,status:source?'stale':'missing',reply:`I don't have today's morning brief yet.${source?` The latest one is from ${source.date}.`:''} You can ask me to run morning intel.`};
 const key=source.relative+'|'+stamp(source.metadata);
 if(cache.key!==key){
  cache.key=key;
  if(source.metadata.size>512000)cache.value={...base,status:'too-large',reply:"Today's morning brief is too large for a quick read. Please open it in the dashboard."};
  else{
   try{
    const raw=fs.readFileSync(source.file,'utf8').replace(/\r\n/g,'\n');
    // An edit while reading invalidates the answer rather than serving a mix.
    if(stamp(stat(vaultPath(root,source.relative)))!==stamp(source.metadata)){cache.key=null;return {...base,status:'unreadable',reply:"Today's morning brief is changing. Please try again in a moment."};}
    cache.value={...base,status:'current',...publicFacts(raw),summary:raw.slice(0,3500),summaryLimited:raw.length>3500,parsedSections:parseBriefSections(raw)};
   }catch(error){cache.key=null;if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;return {...base,status:'unreadable',reply:"Today's morning brief is unavailable right now."};}
  }
 }
 const {summary,summaryLimited,parsedSections,...publicCatalog}=cache.value;
 return structuredClone({...publicCatalog,...(includeSummary&&summary!==undefined?{summary,summaryLimited,topStoryDetail:[]}: {}),...(sections.length?{sections:Object.fromEntries([...new Set(sections)].map(id=>[id,parsedSections?.[id]]))}:{})});
}
export function readBriefSectionReply(root,request,now=new Date()){
 if(!validBriefSectionRequest(request))throw new Error('Unsupported saved briefing section request');
 const brief=getBriefCatalog(root,now,{sections:[request.section]});
 const answer=brief.reply?{reply:brief.reply,count:0}:briefSectionAnswer(brief.sections[request.section],request);
 const lookup={source:'brief-section',section:request.section,...(request.category!==undefined?{category:request.category}:{}),...(answer.count?{count:answer.count}:{}),...(request.offset!==undefined?{offset:request.offset}:{}),date:brief.date,briefSource:brief.briefSource};
 return {reply:answer.reply,briefSource:brief.briefSource,lookup};
}
function readBrief(root,now){return getBriefCatalog(root,now);}
export function readHackerNewsReply(root,rank='points',now=new Date()){
 if(!['points','comments'].includes(rank))throw new Error('Unsupported Hacker News ranking');
 return hackerNewsReply(readBrief(root,now),rank);
}
function hackerNewsReply(brief,rank,titleLimit=180){
 if('reply' in brief)return brief;
 const stories=[...brief.hackerNews].sort((a,b)=>b[rank]-a[rank]);
 if(!stories.length)return {reply:"Today's saved morning brief doesn't include a readable Hacker News ranking.",briefSource:brief.briefSource};
 const top=stories[0],tied=stories[1]?.[rank]===top[rank];
 const label=rank==='comments'?'most comments':'most points';
 return {reply:`From today's saved morning brief, ${shorten(top.title,titleLimit)} ${tied?'was tied for':'had'} the ${label} on Hacker News: ${top.points.toLocaleString('en-US')} points and ${top.comments.toLocaleString('en-US')} comments.`,briefSource:brief.briefSource};
}
export function readBriefReply(root,now=new Date()){
 return editorialReply(readBrief(root,now));
}
function editorialReply(brief,limit=650){
 if('reply' in brief)return brief;
 // Prefer the explicitly ranked news story. TL;DR can include private inbox
 // triage, which must not accidentally become the answer to an AI-news query.
 const text=brief.headline;
 if(!text)return {reply:"Today's morning brief doesn't identify a top story. Please open the brief for the full headlines.",briefSource:brief.briefSource};
 const short=text.length>limit?text.slice(0,limit-3).replace(/\s+\S*$/,'')+'…':text;
 // A headline alone says little. When the brief keeps the story in the paragraphs after it, the first one or two
 // sentences follow, inside the same spoken limit. A headline that already is a paragraph is left alone.
 const room=Math.min(420,limit-short.length-1),first=brief.topStoryDetail?.[0]||'';
 let lead='';
 if(short.length<=220&&room>=80&&first){
  for(const sentence of first.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/).slice(0,2)){if((lead+' '+sentence).trim().length>room)break;lead=(lead+' '+sentence).trim()}
  if(!lead)lead=shorten(first,room);
 }
 return {reply:`From today's morning brief: ${short}${lead?`${/[.!?…]$/.test(short)?'':'.'} ${lead}`:''}`,briefSource:brief.briefSource};
}
export function readBriefLookupReply(root,plan,now=new Date()){
 if(!Array.isArray(plan)||!plan.length||plan.length>4||!plan.every(validPlanItem))throw new Error('Unsupported saved briefing lookup');
 const brief=readBrief(root,now);
 const lookup={plan:structuredClone(plan),date:brief.date,briefSource:brief.briefSource};
 if('reply' in brief)return {reply:brief.reply,briefSource:brief.briefSource,lookup};
 const perPlanLimit=Math.floor(820/plan.length);
 const replies=plan.map(p=>{
  if(!p.count&&!p.offset)return p.source==='hn'?hackerNewsReply(brief,p.rank,Math.min(180,perPlanLimit-155)).reply:editorialReply(brief,Math.min(650,perPlanLimit-40)).reply;
  const count=p.count||1,offset=p.offset||0,all=p.source==='hn'?[...brief.hackerNews].sort((a,b)=>b[p.rank]-a[p.rank]):brief.headlines;
  const items=all.slice(offset,offset+count);
  if(items.length<count)return `Today's saved morning brief doesn't include ${count>1?`that many ${p.source==='hn'?'Hacker News stories':'public headlines'}`:'that numbered story'}.`;
  // All requested items must fit the shared speech budget. Numeric detail is
  // useful for a winner; a list gets concise titles instead of five full stats.
  const titleLimit=Math.floor((perPlanLimit-80)/count)-6;
  return p.source==='hn'?`From today's saved morning brief, Hacker News by ${p.rank}: ${items.map((item,i)=>`${offset+i+1}. ${shorten(item.title,titleLimit)}`).join('; ')}.`:
   `From today's saved morning brief, the listed headlines: ${items.map((item,i)=>`${offset+i+1}. ${shorten(item,titleLimit)}`).join('; ')}.`;
 });
 return {reply:[...new Set(replies)].join(' '),briefSource:brief.briefSource,lookup};
}
