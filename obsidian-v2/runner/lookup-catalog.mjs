import {TIME_ZONE} from '../shared/timezone.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createJiti} from 'jiti';
import {vaultPath} from './core.mjs';
import {withVoiceContext} from './voice-context.mjs';

const vault=await createJiti(import.meta.url).import('./voice-vault.ts');
const files=new Map(), directories=new Map();
const MAX_CACHE=96, MAX_DIRECTORY_ENTRIES=512, MAX_REPORTS=8;
const dateAt=now=>new Intl.DateTimeFormat('en-CA',{timeZone:TIME_ZONE}).format(now);
const copy=value=>structuredClone(value);
const shorten=(value,max=220)=>String(value??'').replace(/\s+/g,' ').trim().slice(0,max);
const outside=(guarded=false,reason='')=>({kind:'outside',...(guarded?{guarded:true,reason}: {})});
const normalize=text=>String(text).normalize('NFKC').toLowerCase().replace(/[’‘]/g,"'")
 .replace(/\b(what|how|where)'s\b/g,'$1 is').replace(/\btoday's\b/g,'today').replace(/\bmy day's\b/g,'my day')
 .replace(/\byou\s+tube\b/g,'youtube').replace(/\btik\s+tok\b/g,'tiktok').replace(/\btop\s+three\b/g,'top 3')
 .replace(/\bfocusing\b/g,'focus').replace(/\bsubscribed\b/g,'subscribers')
 .replace(/[^a-z0-9'\s-]/g,' ').replace(/\s+/g,' ').trim();
// Recognize source and requested field independently; accept conversation filler
// wherever it occurs, but preserve any unaccounted-for requirement for the router.
const FILLER=new Set('hey hi hello jarvis astra okay ok so well um uh please just quickly quick real really actually now right currently current latest saved available my our the a an me i we you us your for of on in at from to with is are was were am do does did have has had be can could would will should tell say show give get read list know want like wonder wondering check see remind what how which when many much count counts number numbers up doing going about today day this it there'.split(' '));
const ACTION=/\b(?:create|make|write|draft|generate|build|research|investigate|compare|analy[sz]e|edit|change|update|refresh|pull|send|email|post|publish|delete|remove|mark|complete|finish|start|stop|run|open|navigate|switch|toggle|add|schedule a|plan (?:my|the|a))\b/;
const NEGATIVE=/\b(?:not|never|without|except|excluding|instead|don't|dont|isn't|isnt|aren't|arent|no)\b/;
const FOREIGN_DATE=/\b(?:yesterday|tomorrow|last week|last month|last year|next week|next month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|20\d\d|\d{4}-\d{2}-\d{2})\b/;
const remainder=(text,known)=>text.split(' ').filter(token=>token&&!FILLER.has(token)&&!known.has(token));
const ambiguous=(source,reason,extra={})=>({kind:'ambiguous',source,reason,...extra});
const request=(source,extra={})=>({kind:'lookup',source,...extra});

export function inspectLocalLookup(input){
 const text=normalize(input);
 const knownSource=/\b(?:priorit(?:y|ies)|top 3|plate|schedule|calendar|agenda|focus|daily note|daily plan|subscribers?|subs|followers?|instagram|tiktok|youtube|yt|audience|metrics|upload|video|reports?|deliverables?|outputs?)\b/.test(text);
 const defer=reason=>outside(knownSource,reason);
 const indexQuestion=text.match(/^(?:hey |okay |please )*(?:did i|have i|is my|is the) (?:finish |complete |check off |finished |completed )?(?:priority|directive) (?:number )?(one|two|three|1|2|3)(?: (?:done|finished|completed|checked off))?(?: today)?$/);
 if(indexQuestion)return request('daily',{field:'priority-status',index:({one:0,two:1,three:2,'1':0,'2':1,'3':2})[indexQuestion[1]],when:/\btoday\b/.test(text)?'today':'latest'});
 // Existing complete UI / daily-write commands retain their original handlers.
 // This bypass is deliberately anchored: a second clause never slips through.
 if(/^(?:hey |ok |okay |please )*(?:check(?: off)?|mark|complete|finish|tick|knock out|uncheck|untick) (?:off )?(?:(?:my|the) )?(?:priority|directive|top ?(?:three|3)) ?(?:number )?(?:one|two|three|1|2|3)(?: (?:as )?(?:done|complete|finished|off))?$/.test(text))return outside();
 if(/^(?:hey |ok |okay |please )*(?:open|show|pull up|bring up) (?:my |the )?(?:daily note|calendar|schedule|terminal|dashboard)(?: (?:on the right|on the left|in the sidebar|in a new tab))?$/.test(text))return outside();
 if(/^(?:hey |ok |okay |please )*(?:pull|refresh|update|run) (?:my |the )?metrics(?: pull)?$/.test(text))return outside();
 if(!text||text.length>360||ACTION.test(text)||NEGATIVE.test(text))return defer('The complete request includes work, negation, or unsupported structure.');
 // Compound requests are left whole even when one clause is locally answerable.
 if(/\b(?:and|then|also|plus|but|along with|as well as)\b|[;\n]/i.test(String(input)))return defer('Preserve every clause in the compound request.');
 const daily=/\b(?:priorit(?:y|ies)|top 3|on my plate|on our plate|schedule|calendar|agenda|focus|to do|todo|daily note|daily plan)\b/.test(text);
 const latest=/\b(?:latest|last|newest|recent)\s+(?:(?:youtube|yt)\s+)?(?:upload|video)\b|\b(?:upload|video)\s+(?:doing|performing)\b/.test(text);
 const metrics=/\b(?:subscribers?|subs|followers?|instagram|tiktok|youtube|yt|audience|metrics)\b/.test(text);
 const reports=/\b(?:reports?|deliverables?|outputs?)\b/.test(text);
 if([daily,latest||metrics,reports].filter(Boolean).length>1)return defer('More than one information source was requested.');
 if(FOREIGN_DATE.test(text))return defer('The requested date is outside this local lookup.');
 if(daily){
  const fields=[/\b(?:priorit(?:y|ies)|top 3|plate|to do|todo)\b/.test(text)&&'priorities',/\b(?:schedule|calendar|agenda)\b/.test(text)&&'schedule',/\bfocus\b/.test(text)&&'focus'].filter(Boolean);
  const field=fields[0]||'priorities';
  const known=new Set('priorities priority top 3 plate schedule calendar agenda focus to do todo daily note plan unfinished remaining left pending still completed done'.split(' '));
  const extra=remainder(text,known);
  const when=/\b(?:today|this day)\b/.test(text)?'today':'latest';
  if(fields.length>1||extra.length)return ambiguous('daily','The requested daily-note detail needs interpretation.',{field,when});
  const state=/\b(?:unfinished|remaining|left|pending|still)\b/.test(text)?'open':/\b(?:completed|done)\b/.test(text)?'done':'all';
  return request('daily',{field,state,when});
 }
 if(latest){
  const known=new Set('last newest recent upload video youtube yt views likes comments title name called performance performing link url date published released'.split(' '));
  const fields=['views','likes','comments'].filter(field=>new RegExp(`\\b${field}\\b`).test(text));
  if(remainder(text,known).length||fields.length>1)return ambiguous('latest-upload','The requested upload detail needs interpretation.');
  return request('latest-upload',{field:fields[0]||(/\b(?:link|url)\b/.test(text)?'link':/\b(?:when|date|published|released)\b/.test(text)?'published':/\b(?:title|name|called)\b/.test(text)||/what is my (?:latest|last|newest) (?:video|upload)$/.test(text)?'title':'overview')});
 }
 if(metrics){
  if(/\b(?:usage|quota|tokens?|codex|claude|allowance|luna|astra)\b/.test(text))return defer('Model usage is a separate source.');
  const platforms=['youtube','instagram','tiktok'].filter(p=>new RegExp(`\\b${p==='youtube'?'(?:youtube|yt)':p}\\b`).test(text));
  const platform=platforms[0]||(/\b(?:subscribers?|subs)\b/.test(text)?'youtube':null);
  if(platforms.length>1||!platform)return ambiguous('metrics','Which audience metric or platform?',{platform});
  const known=new Set('subscriber subscribers subs follower followers people channel instagram tiktok youtube yt audience metrics views view 28 days day past last month total overall'.split(' '));
  const metric=/\bviews?\b/.test(text)?'views_28d':platform==='youtube'?'subscribers':'followers';
  if(remainder(text,known).length||(/\b(?:subscribers?|subs)\b/.test(text)&&platform!=='youtube')||(/\bviews?\b/.test(text)&&platform!=='youtube'))return ambiguous('metrics','This asks for a metric or comparison beyond the direct count.',{platform});
  // The saved view metric is a 28-day total, never lifetime or today's views.
  if(metric==='views_28d'&&!/\b28 days?\b/.test(text))return ambiguous('metrics','The saved YouTube views cover 28 days; the requested window is unclear.',{platform});
  return request('metrics',{platform,metric});
 }
 if(reports){
  if(/\b(?:in|inside|contents?|says?|said|recommend|explain|discuss|read|summary|summarize)\b/.test(text))return ambiguous('reports','The question asks about a report’s content, rather than the report list.');
  const known=new Set('report reports deliverable deliverables output outputs recent recently last newest ready finished completed'.split(' '));
  if(remainder(text,known).length)return ambiguous('reports','A particular saved report needs interpretation.');
  return request('reports',{field:/\b(?:latest|last|newest)\b/.test(text)?'latest':'list'});
 }
 return outside();
}

function remember(map,key,value){map.delete(key);map.set(key,value);while(map.size>MAX_CACHE)map.delete(map.keys().next().value);return value}
export function clearLookupCache(root){
 if(!root){files.clear();directories.clear();return}
 const prefix=path.resolve(root)+'\0';for(const map of [files,directories])for(const key of map.keys())if(key.startsWith(prefix))map.delete(key);
}
function fileInfo(root,relative,max=4*1024*1024){
 try{const absolute=vaultPath(root,relative),stat=fs.statSync(absolute);if(!stat.isFile()||stat.size>max)return null;return {absolute,signature:`${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`,mtime:stat.mtimeMs,size:stat.size}}catch{return null}
}
function cachedFile(root,relative,parse,{max,variant=''}={}){
 const key=`${root}\0${relative}\0${variant}`,info=fileInfo(root,relative,max);
 if(!info){files.delete(key);return null}
 const previous=files.get(key);if(previous?.signature===info.signature)return copy(previous.value);
 let value;try{value=parse(info)}catch{files.delete(key);return null}
 remember(files,key,{signature:info.signature,value});return copy(value);
}
function dailyData(root,now,allowHistorical=false){
 const today=dateAt(now);let date=today,relative=`daily-notes/${date}.md`;
 if(!fileInfo(root,relative,256000)&&allowHistorical){
  const index=directoryFiles(root,'daily-notes',/^\d{4}-\d{2}-\d{2}\.md$/);
  // A bounded incomplete listing cannot establish the most recent daily note.
  const latest=!index.truncated&&index.entries.map(p=>path.basename(p,'.md')).filter(d=>d<today).sort().at(-1);
  if(latest){date=latest;relative=`daily-notes/${date}.md`}
 }
 const clock=date===today?now:new Date(`${date}T12:00:00-06:00`);
 const daily=cachedFile(root,relative,()=>withVoiceContext({root,exchanges:[]},()=>vault.readDailyNote(clock)),{max:256000,variant:date});
 return {date,today,path:relative,status:daily?.date===date?(date===today?'current':'historical'):'missing',...(daily?.date===date?{priorities:daily.top3.slice(0,3).map(p=>({text:shorten(p.text,220),done:p.done})),schedule:daily.schedule.slice(0,16).map(s=>({time:s.time,item:shorten(s.item,160)})),scheduleCount:daily.schedule.length,focus:shorten(daily.focus,300)}:{})};
}
function metricsData(root,now,platform){
 const relative='system/metrics/metrics.csv';
 const all=cachedFile(root,relative,()=>withVoiceContext({root,exchanges:[]},()=>vault.readMetrics()))||[];
 const rows=all.filter(m=>['youtube','instagram','tiktok'].includes(m.source)&&['subscribers','followers','views_28d'].includes(m.metric)&&(!platform||m.source===platform)).map(m=>({platform:m.source,metric:m.metric,value:m.value,status:m.status,timestamp:m.timestamp,ageHours:Number.isFinite(Date.parse(m.timestamp))?Math.max(0,(now-Date.parse(m.timestamp))/3600000):null,changeSincePrevious:m.delta,previousAt:m.history.at(-2)?.timestamp||null}));
 return {path:relative,status:rows.length?'available':'missing',metrics:rows};
}
function videoData(root,now){
 const relative='system/metrics/latest-video.json';
 const data=cachedFile(root,relative,info=>{
  const raw=JSON.parse(fs.readFileSync(info.absolute,'utf8'));
  const video=withVoiceContext({root,exchanges:[]},()=>vault.readLatestVideo());
  if(!video||!video.title||typeof raw.title!=='string')return null;
  // The legacy parser uses zero for absent fields. Missing counts are not zero.
  for(const field of ['views','likes','comments'])if(typeof raw[field]!=='number'||!Number.isFinite(raw[field])||raw[field]<0)video[field]=null;
  return {...video,title:shorten(video.title),updatedAt:new Date(info.mtime).toISOString()};
 },{max:64000});
 return {path:relative,status:data?'available':'missing',...(data?{video:data,ageHours:Math.max(0,(now-Date.parse(data.updatedAt))/3600000)}:{})};
}

function directoryFiles(root,relative,pattern=/\.json$/){
 let dir,stamp;try{dir=vaultPath(root,relative);const stat=fs.statSync(dir);if(!stat.isDirectory())return {entries:[],truncated:false};stamp=`${stat.mtimeMs}:${stat.ctimeMs}`}catch{return {entries:[],truncated:false}}
 const key=`${root}\0${relative}\0${pattern}`,old=directories.get(key);
 if(old?.signature===stamp)return copy(old.value);
 const entries=[];let truncated=false,handle,seen=0;
 try{handle=fs.opendirSync(dir);let entry;while((entry=handle.readSync())){if(seen++===MAX_DIRECTORY_ENTRIES){truncated=true;break}if(entry.isFile()&&pattern.test(entry.name))entries.push(`${relative}/${entry.name}`)}}catch{return {entries:[],truncated:false}}finally{handle?.closeSync()}
 return copy(remember(directories,key,{signature:stamp,value:{entries,truncated}}).value);
}
function safeDeliverable(root,relative){
 if(typeof relative!=='string'||!relative.endsWith('.md')||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(p=>!p||p==='..'||p.startsWith('.'))||/^[a-z]:/i.test(relative))return null;
 return fileInfo(root,relative,2*1024*1024)?relative:null;
}
function reportData(root){
 const indexes=['system/runs','system/v2/runs'].map(relative=>directoryFiles(root,relative));
 const entries=indexes.flatMap(i=>i.entries).map(relative=>({relative,info:fileInfo(root,relative,128000)})).filter(row=>row.info).sort((a,b)=>b.info.mtime-a.info.mtime);
 const reports=[];
 // Bound JSON reads as well as directory enumeration. Only recorded completed
 // outputs are exposed; no content-folder traversal and no report-body reads.
 for(const {relative} of entries.slice(0,48)){
  const row=cachedFile(root,relative,info=>JSON.parse(fs.readFileSync(info.absolute,'utf8')),{max:128000});
  if(!row||row.status!=='ok')continue;
  const deliverable=safeDeliverable(root,row.deliverable_path);if(!deliverable||reports.some(r=>r.path===deliverable))continue;
  reports.push({path:deliverable,title:shorten(row.label||row.skill||path.basename(deliverable,'.md'),80),summary:shorten(row.summary,260),completedAt:typeof row.ts_completed==='string'?row.ts_completed:null});
 }
 reports.sort((a,b)=>(Date.parse(b.completedAt)||0)-(Date.parse(a.completedAt)||0));
 return {status:reports.length?'available':'missing',reports:reports.slice(0,MAX_REPORTS),truncated:indexes.some(i=>i.truncated)||entries.length>48};
}

export function getLookupContext(root,request,{now=new Date()}={}){
 root=path.resolve(root);
 if(request?.source==='daily')return {source:'daily',...dailyData(root,now,request.when==='latest')};
 if(request?.source==='metrics')return {source:'metrics',...metricsData(root,now,request.platform)};
 if(request?.source==='latest-upload')return {source:'latest-upload',...videoData(root,now)};
 if(request?.source==='reports')return {source:'reports',...reportData(root)};
 return {sources:[{source:'daily',contains:'Today’s priorities, schedule and focus'},{source:'metrics',contains:'Saved YouTube subscribers and 28-day views; Instagram and TikTok followers'},{source:'latest-upload',contains:'Latest saved YouTube upload title, views, likes and comments'},{source:'reports',contains:'Recent completed report summaries'}]};
}
export function getLocalCatalog(root,{now=new Date(),sources=[]}={}){
 return {date:dateAt(now),...getLookupContext(root,null),available:sources.filter(s=>['daily','metrics','latest-upload','reports'].includes(s)).slice(0,4).map(source=>getLookupContext(root,{source},{now}))};
}
const number=value=>new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(value);
const friendly=platform=>({youtube:'YouTube',instagram:'Instagram',tiktok:'TikTok'})[platform]||platform;
const freshMessage=(status,age)=>status==='stale'||age===null||age>24?' This is the last saved reading, not a live check.':'';
export function answerLocalLookup(root,request,{now=new Date()}={}){
 if(request?.kind!=='lookup')return null;
 const context=getLookupContext(root,request,{now});
 const lookup={source:request.source,date:context.date||dateAt(now),path:context.path||null,...(request.field?{field:request.field}:{})};
 const result=reply=>({reply:shorten(reply,780),lookup,...(['current','historical'].includes(context.status)&&request.source==='daily'?{deliverable:context.path}:{}),panels:[request.source==='daily'?'priorities':request.source==='reports'?'documents':'vitals']});
 if(request.source==='daily'){
  if(context.status==='missing')return result(request.field==='schedule'?"No schedule for today: I don't have a daily note for today.":"I don't have a daily note for today, so I can't confirm today's plan.");
  const historical=context.status==='historical',lead=historical?`There is no daily note for today. On ${context.date}, your saved`:'Today’s saved';
  if(request.field==='priority-status'){
   const priority=context.priorities[request.index];
   return result(priority?`${historical?`On ${context.date}`:'In today’s note'}, priority ${request.index+1}, ${priority.text}, is ${priority.done?'checked off':'not checked off'}.`:`${lead} note has no priority ${request.index+1} saved.`);
  }
  if(request.field==='focus')return result(context.focus?`${historical?`No focus set for today. On ${context.date}, your saved`:lead} focus ${historical?'was:': 'is:'} ${context.focus}`:`${lead} note doesn't have a current focus saved.`);
  if(request.field==='schedule')return result(context.schedule.length?`${lead} schedule ${historical?'was:':'is:'} ${context.schedule.map(s=>`${s.time}, ${s.item}`).join('; ')}.${context.scheduleCount>16?` Showing the first 16 of ${context.scheduleCount} saved entries.`:''}`:`${lead} note has no schedule entries saved.`);
  const items=context.priorities.filter(p=>request.state==='open'?!p.done:request.state==='done'?p.done:true);
  return result(items.length?`${lead} ${request.state==='open'?'remaining ':request.state==='done'?'completed ':''}priorities ${historical?'were:':'are:'} ${items.map((p,i)=>`${i+1}, ${p.text}${p.done&&request.state!=='done'?' (done)':''}`).join('; ')}.`:request.state==='open'&&context.priorities.length?`${lead} priorities are all checked off.`:`${lead} note has no matching priorities saved.`);
 }
 if(request.source==='metrics'){
  const m=context.metrics.find(m=>m.platform===request.platform&&m.metric===request.metric);
  const label=request.metric==='views_28d'?'views over 28 days':request.metric;
  if(!m||!Number.isFinite(m.value)||!['ok','stale'].includes(m.status))return result(`I don't have a usable saved ${friendly(request.platform)} ${label} reading.`);
  return result(`${friendly(request.platform)} has ${number(m.value)} ${label} in the saved metrics.${freshMessage(m.status,m.ageHours)}`);
 }
 if(request.source==='latest-upload'){
  const v=context.video;if(!v)return result("I don't have a saved latest upload right now.");
  if(request.field==='title')return result(`Your latest saved upload is ${v.title}.`);
  if(request.field==='link')return result(/^https?:\/\//i.test(v.url)?`The saved link for ${v.title} is ${v.url}`:"The latest upload doesn't have a saved link.");
  if(request.field==='published')return result(Number.isFinite(Date.parse(v.published_at))?`${v.title} was published on ${dateAt(new Date(v.published_at))}.`:"The latest upload doesn't have a valid saved publication date.");
  const keys=request.field==='overview'?['views','likes','comments']:[request.field];
  const available=keys.filter(key=>v[key]!==null&&Number.isFinite(v[key]));
  if(!['ok','stale'].includes(v.status)||!available.length)return result(`I have ${v.title} saved, but its ${request.field==='overview'?'performance':request.field} reading isn't available.`);
  return result(`${v.title}: ${available.map(key=>`${number(v[key])} ${key}`).join(', ')}.${freshMessage(v.status,context.ageHours)}`);
 }
 if(request.source==='reports'){
  const reports=context.reports.slice(0,request.field==='latest'?1:3);
  if(!reports.length)return result("I don't have any readable completed reports in the recent saved run records.");
  const r=result(`${context.truncated?'Among the recent reports I indexed':'Recent saved reports'}: ${reports.map(row=>`${row.title}${row.summary?`: ${row.summary}`:''}`).join('; ')}`);
  if(reports.length===1)r.deliverable=reports[0].path;
  return r;
 }
 return null;
}
