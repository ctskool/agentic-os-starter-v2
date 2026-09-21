// One resolver for "open / show / pull up X": named reports, daily notes,
// vault notes and files, and files a worker conversation already registered.
// Deterministic and model-free. Phrasing is normalized here; the decision of
// WHAT the user means is made against a live index, never by pattern-matching
// a sentence. Ambiguity returns candidates for one short question; nothing
// here starts work.
import fs from 'node:fs';
import path from 'node:path';
import {vaultPath} from './core.mjs';
import {parseSpokenDate,localParts,describeDate} from './spoken-dates.mjs';
import {linkedArtifacts} from './artifacts.mjs';
import {SKILLS} from '../shared/contract.mjs';

export const REPORT_KINDS=[
 {name:'yt-week-review',re:/\b(?:you\s?tube|yt)\s+(?:week(?:ly)?\s+)?(?:review|report)\b/,dirs:['inbox/reports/yt-reviews'],label:'YouTube weekly review'},
 {name:'inbox-brief',re:/\b(?:inbox|email|e-mail|gmail)\s+(?:brief(?:ing)?|report|audit|triage|summary)\b/,dirs:['inbox/reports/inbox-briefs'],label:'inbox brief'},
 {name:'weekly-review',re:/\bweekly\s+(?:review|report|retro(?:spective)?)\b|\bweek(?:ly)?\s+in\s+review\b/,dirs:['inbox/reports/weekly'],label:'weekly review'},
 {name:'github-trending',re:/\b(?:git\s?hub\s+|get\s?hub\s+)?trending(?:\s+(?:report|repos|repositories|list))?\b/,dirs:['inbox/research/github-trending'],label:'GitHub trending'},
 {name:'outlier-radar',re:/\b(?:outlier\s+)?radar(?:\s+(?:report|sweep|scan))?\b|\boutliers?(?:\s+(?:report|list|scan))\b/,dirs:['inbox/research/outlier-radar'],label:'outlier radar'},
 {name:'morning-intel',re:/\bmorning\s+(?:intel|report|brief(?:ing)?|sweep|news)\b|\bintel(?:\s+(?:brief(?:ing)?|report|sweep))?\b|\b(?:ai\s+)?(?:news\s+)?brief(?:ing)?\b/,dirs:['inbox/research/morning-intel','inbox/reports/morning'],filter:/-intel/,label:'morning intel'},
];
const DAILY_RE=/\b(?:daily(?:\s+note)?|day\s+note|journal|my\s+day(?:\s+note)?|today's\s+note|the\s+note\s+for\s+today)\b/;
const TYPES={md:'note',canvas:'canvas',png:'image',jpg:'image',jpeg:'image',webp:'image',gif:'image',svg:'image',pdf:'pdf'};
const SKIP_DIRS=new Set(['node_modules','_archive-vault','system']);
const INDEX_TTL=30000,MAX_FILES=40000;
const indexes=new Map();
export const tokenize=text=>String(text||'').normalize('NFKC').toLowerCase().replace(/['’]/g,'').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const humanize=name=>name.replace(/^\d{4}-\d{2}-\d{2}[-_ ]?/,'').replace(/[-_]+/g,' ').trim()||name;

export function invalidateTargetIndex(root){if(root){indexes.delete(root);runCache.delete(root)}else{indexes.clear();runCache.clear()}}
export function targetIndex(root,{now=Date.now()}={}){
 root=path.resolve(root);
 const cached=indexes.get(root);
 if(cached&&now-cached.ts<INDEX_TTL)return cached.entries;
 const entries=[];
 const walk=(dir,relative,depth)=>{
  if(depth>12||entries.length>=MAX_FILES)return;
  let items;try{items=fs.readdirSync(dir,{withFileTypes:true})}catch{return}
  for(const item of items){
   if(item.name.startsWith('.')||item.isSymbolicLink())continue;
   const rel=relative?`${relative}/${item.name}`:item.name;
   if(item.isDirectory()){if(!relative&&SKIP_DIRS.has(item.name))continue;walk(path.join(dir,item.name),rel,depth+1);continue}
   if(!item.isFile())continue;
   const ext=path.extname(item.name).slice(1).toLowerCase(),type=TYPES[ext];
   if(!type)continue;
   const name=item.name.slice(0,-(ext.length+1)),date=/^(\d{4}-\d{2}-\d{2})/.exec(name)?.[1]||null;
   let mtime=0;try{mtime=fs.statSync(path.join(dir,item.name)).mtimeMs}catch{}
   entries.push({path:rel,name,ext,type,date,tokens:tokenize(date?name.slice(10):name),folderTokens:tokenize(relative),mtime,archived:/(?:^|\/)archive(?:\/|$)/.test(relative),index:name==='_index'||name.endsWith('_index')});
  }
 };
 walk(root,'',0);
 indexes.set(root,{ts:now,entries});
 return entries;
}

// --- phrasing ----------------------------------------------------------------
const PREAMBLE=/^(?:(?:hey|hi|hello|ok|okay|all right|alright|so|well|um|uh|jarvis|astra|please|just|now|also|actually|and|then|yeah|yes|no)[,\s]+)+/;
const REQUEST=/^(?:(?:can|could|would|will|can't|couldn't|won't|why don't|why can't) you(?: please| just| also| maybe)?|would you mind|do you mind|are you able to|is it possible to|is there a way to|i(?: would|'d) (?:like|love|want) (?:you )?to|i (?:want|need|would like) (?:you )?to|i(?: would|'d) (?:like|love) to|i (?:want|need) to|let me|let's|go ahead and|please|just|quickly|real quick)[,\s]+/;
// Bare "pull" and "bring" are workflow verbs ("pull metrics"); only the
// phrasal forms mean display.
const OPEN_VERB=/^(?:open(?: up| back up)?|pull (?:up|back up)|bring (?:up|back|back up)|show(?: me| us)?|put up|display|view|see|look at|take a look at|have a look at|reopen|re-open|go to|navigate to|jump to|switch to|take me to)\s+(.+)$/;
const OPEN_SEPARABLE=/^(?:pull|bring|put)\s+(.+?)\s+(?:back\s+)?up$/;
const NOT_OPEN=/\b(?:don't|do not|never|not|without|unless|instead of|how (?:do|would|to|can)|what (?:does|did|is|was)|read(?: me)?|summari[sz]e|tell me|explain|describe|refresh|rerun|re-run|regenerate|research|draft|write|create|make|build|generate|send|email|delete|remove|archive|rename|move)\b|;/;
const COMPOUND=/\band\s+(?:then\s+)?(?:summari[sz]e|read|tell|explain|draft|write|create|research|open|show|pull|bring|send|email|make|build|edit|change|update|then)\b|\bor\b/;
// A sentence of work ahead of "then open it" ("Create a chart. Then open it",
// "First update the diagram. Then show me") makes the whole thing work with a
// promised open. A sentence is work when it starts with a work verb once the
// courtesy and sequencing words are gone; "It is complete" and "the blue
// design is outdated" are descriptions, not work.
const WORK_VERB_START=/^(?:create|make|build|draft|write|generate|design|produce|research|investigate|put together|analy[sz]e|compare|rewrite|revise|prepare|outline|brainstorm|render|export|edit|update|fix|change|modify|adjust|tweak|improve|refine|polish|redo|regenerate|resize|convert|translate|expand|shorten|extend|finish|complete|correct|proofread|reformat|format|clean up|touch up)\b/;
const SEQUENCE=/^(?:(?:first|next|then|now|also|finally|after that|afterwards|and|and then|but|so|please|just|go ahead and)[,\s]+)+/;
function imperativeWork(clause){
 let text=String(clause||'').trim();
 for(let i=0;i<4;i++){const next=text.replace(PREAMBLE,'').replace(REQUEST,'').replace(SEQUENCE,'').trim();if(next===text)break;text=next}
 return WORK_VERB_START.test(text);
}
const TRAILING=/(?:[,.!?]*\s+(?:for me|please|thanks|thank you|jarvis|again|back|back up|real quick|really quick|quick|quickly|right now|now|so (?:that )?i can (?:see|read|look at|review|check)(?: it| that| them)?|so i can see it|in (?:a |the |another |an |one of the |my )?(?:new |other |separate |different )?(?:obsidian )?(?:tabs?|windows?|panes?|notes?|viewer)|in obsidian|inside (?:of )?obsidian|on (?:the |my )?(?:screen|dashboard|hud|display)|in (?:the )?(?:dashboard|hud|web viewer|viewer)|here|there|on screen|up on (?:the )?screen|for a (?:sec|second|minute)))+[,.!?]*$/;
const WHERE=/\b(?:on|to|in|over on|over to)\s+(?:the\s+|my\s+)?(right|left)(?:\s+(?:sidebar|side|panel|pane|hand side))?\b|\b(?:in|as)\s+a\s+split\b|\bsplit\s+(?:view|pane|screen)\b|\bside\s+by\s+side\b/;
const WEB_OR_UI=/\b(?:calendar|gmail|google mail|youtube studio|terminal|terminals|dashboard|cockpit|command center|sidebar|settings|graph(?: view)?|search|command palette|repos?|repositor(?:y|ies))\b|\bgit\s?hub\b(?!\s+trending)|https?:\/\//;
const STOP=new Set(['the','a','an','my','our','your','that','this','those','these','up','please','jarvis','for','me','us','of','from','with','about','on','in','at','to','into','again','back','here','there','just','also','too','quick','quickly','real','really','so','can','i','we','it','and','then','now','some','any','kind','sort','like','thing','things','stuff','one','ones','file','files','note','notes','doc','docs','document','documents','page','pages','report','reports','result','results','output','outputs','answer','saved','latest','last','recent','most','newest','earlier','previous','old','older','new','version','copy','tab','tabs','window','obsidian','dashboard','screen','viewer']);
const GENERIC=new Set(['it','that','this','them','those','these','one','ones','thing','stuff','file','files','doc','docs','document','documents','note','notes','page','pages','report','reports','result','results','output','outputs','answer','explainer','image','images','graphic','graphics','picture','pictures','photo','diagram','diagrams','chart','charts','visual','visuals','visualization','visualisation','pdf','deck','slides','slide','version','draft','summary','brief','html','you','made','created','built','generated','mentioned','wrote','produced','put','together','sent','gave','showed','earlier','last','latest','previous','recent','again','conversation','task','worker','codex','claude','just','saved','said','from','of','the','a','an','that','were','was','talking','about','with','me','up','up']);
const REPORT_WORDS=new Set(['report','reports','brief','briefing','sweep','scan','list','repos','repositories','triage','audit','summary','file','note','version','copy','one','thing']);
// Section and detail questions belong to the brief readers, not to file opening.
const DETAIL=/\b(?:stor(?:y|ies)|headlines?|sections?|items?|number\s+\S+|second|third|top\s+\d+|first|sponsors?|leads?|emails?|highlights?|takeaways?|details?|part|paragraph|bullet|entry|entries)\b/;
const IMAGE_HINT=/\b(?:image|images|graphic|graphics|picture|pictures|photo|diagram|diagrams|chart|charts|visual|visuals|visualization|visualisation|png|jpe?g|screenshot|poster|thumbnail|cover|logo|banner|infographic|mockup|illustration)\b/;
const BY_WORKER=/\b(?:you|it|the (?:agent|worker|assistant|codex|claude|terminal|task))\s+(?:just\s+|already\s+)?(?:made|created|built|generated|produced|wrote|designed|drew|rendered|put together|came up with|gave me|sent me|saved)\b/;
const PDF_HINT=/\bpdf|deck|slides?\b/;
const DOC_HINT=/\b(?:note|notes|doc|docs|document|documents|markdown|summary|brief|report|write-?up|explainer|page)\b/;
const ORDINAL=/^(?:(?:the|number)\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|1|2|3|4|5|one|two|three|four|five|top|last)(?:\s+one)?\b[.!?\s]*$/;
const AFFIRM=/^(?:yes(?: please)?|yeah|yep|sure|absolutely|go ahead|do (?:it|that)|please do|go for it|sounds good|that one|that works|ok(?:ay)?)(?: please)?(?: jarvis)?[.!?\s]*$/i;

export function openIntent(transcript){
 if(typeof transcript!=='string')return null;
 const whole=transcript.normalize('NFKC').replace(/[’‘]/g,"'").replace(/[“”]/g,'"').toLowerCase().replace(/\s+/g,' ').trim();
 if(whole.length>300||/\n|"|https?:\/\//.test(whole))return null;
 // Spoken requests often restate themselves ("pull it up? can you pull up the
 // report…"). Each sentence is judged alone; the last one that asks to open
 // something wins, since restatements tend to be the more specific ask.
 const clauses=whole.split(/[.!?;]+/).map(c=>c.trim()).filter(Boolean);
 if(clauses.length>1){
  // "Create a new diagram. Then open it." is work with a promised open, and
  // "Open the proposal. Then create a summary." is work too: any sentence of
  // work makes the utterance one request for the worker, never an open now.
  if(clauses.some(imperativeWork))return null;
  for(const clause of [...clauses].reverse()){const intent=openIntent(clause);if(intent)return intent}return null;
 }
 let text=whole.replace(/[.!?]+$/,'');
 for(let i=0;i<4;i++){const next=text.replace(PREAMBLE,'').replace(REQUEST,'');if(next===text)break;text=next.trim()}
 // Trailing courtesy words hide separable verbs ("bring that up for me").
 for(let i=0;i<4;i++){const next=text.replace(TRAILING,'').trim();if(next===text)break;text=next}
 if(NOT_OPEN.test(text)||COMPOUND.test(text))return null;
 const separable=/^(?:pull|bring|put)\s+(?!(?:up|back)\b)/.test(text)&&/\bup$/.test(text)?OPEN_SEPARABLE.exec(text)?.[1]:null;
 const command=separable??OPEN_VERB.exec(text)?.[1]??OPEN_SEPARABLE.exec(text)?.[1];
 if(!command)return null;
 let target=command.trim(),where;
 const placed=WHERE.exec(target);
 if(placed){where=placed[1]==='right'?'right-sidebar':placed[1]==='left'?'left-sidebar':'split';target=(target.slice(0,placed.index)+' '+target.slice(placed.index+placed[0].length)).replace(/\s+/g,' ').trim()}
 for(let i=0;i<4;i++){const next=target.replace(TRAILING,'').trim();if(next===target)break;target=next}
 target=target.replace(/^(?:up\s+)+/,'').replace(/[,.!?]+$/,'').trim();
 if(!target||WEB_OR_UI.test(target)||DETAIL.test(target))return null;
 return {target,where};
}

// --- reports and daily notes -----------------------------------------------------
function reportFiles(root,kind){
 const out=[];
 for(const dir of kind.dirs){
  let absolute;try{absolute=vaultPath(root,dir);if(fs.lstatSync(absolute).isSymbolicLink())continue}catch{continue}
  let items;try{items=fs.readdirSync(absolute,{withFileTypes:true})}catch{continue}
  for(const item of items){
   if(!item.isFile()||!item.name.endsWith('.md')||item.name.startsWith('_')||item.name.endsWith('_index.md'))continue;
   const relative=`${dir}/${item.name}`;let stat;try{stat=fs.statSync(vaultPath(root,relative))}catch{continue}
   if(!stat.isFile())continue;
   out.push({path:relative,date:/^(\d{4}-\d{2}-\d{2})/.exec(item.name)?.[1]||null,mtime:stat.mtimeMs,preferred:kind.filter?kind.filter.test(item.name):true});
  }
 }
 return out.sort((a,b)=>(b.date||'').localeCompare(a.date||'')||b.mtime-a.mtime||b.path.localeCompare(a.path));
}
function pickReport(files,when){
 const preferred=files.filter(f=>f.preferred),pool=preferred.length?preferred:files;
 if(!when)return {file:pool[0]||null};
 const inWindow=when.kind==='range'?f=>f.date&&f.date>=when.from&&f.date<=when.to:f=>f.date===when.date;
 const hit=pool.find(inWindow)||files.find(inWindow);
 if(hit)return {file:hit};
 const before=when.kind==='range'?when.from:when.date;
 return {file:null,nearest:pool.find(f=>f.date&&f.date<before)||files.find(f=>f.date&&f.date<before)||null};
}
export function matchReportKind(text){return REPORT_KINDS.find(kind=>kind.re.test(text))||null}

// --- notes and files -------------------------------------------------------------
function editDistance(a,b,limit){
 if(Math.abs(a.length-b.length)>limit)return limit+1;
 let previous=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){
  const current=[i];let best=i;
  for(let j=1;j<=b.length;j++){current[j]=Math.min(previous[j]+1,current[j-1]+1,previous[j-1]+(a[i-1]===b[j-1]?0:1));best=Math.min(best,current[j])}
  if(best>limit)return limit+1;previous=current;
 }
 return previous[b.length];
}
function tokenMatch(query,token){
 if(query===token)return 3;
 if(query.length>=3&&token.startsWith(query))return 2;
 if(token.length>=4&&query.startsWith(token))return 2;
 if(query.length>=5&&editDistance(query,token,query.length>=8?2:1)<=(query.length>=8?2:1))return 2;
 return 0;
}
export function searchTargets(root,text,{when=null,now=Date.now(),types=null,limit=3}={}){
 root=path.resolve(root);
 const query=tokenize(text).filter(t=>!STOP.has(t));
 const entries=targetIndex(root,{now}).filter(e=>!types||types.includes(e.type));
 const dated=when?entries.filter(e=>e.date&&(when.kind==='range'?e.date>=when.from&&e.date<=when.to:e.date===when.date)):entries;
 if(!query.length){
  if(!when)return {query,matches:[]};
  const pool=dated.filter(e=>!e.index&&!e.archived).sort((a,b)=>b.mtime-a.mtime);
  return {query,matches:pool.slice(0,limit).map(e=>({entry:e,score:1}))};
 }
 const phrase=query.join(' ');
 const scored=[];
 for(const entry of dated){
  if(entry.index&&!query.includes('index'))continue;
  let score=0,nameHits=0,pathHits=0;
  for(const q of query){
   let best=0;
   for(const token of entry.tokens)best=Math.max(best,tokenMatch(q,token));
   if(best){score+=best;nameHits++;continue}
   if(entry.folderTokens.some(token=>tokenMatch(q,token)>=2)){score+=1;pathHits++}
  }
  if(!nameHits)continue;
  const coverage=(nameHits+pathHits)/query.length;
  if(coverage<0.6&&query.length>1)continue;
  if(entry.tokens.join(' ')===phrase)score+=3;
  else if(entry.tokens.join(' ').includes(phrase))score+=2;
  if(entry.archived)score-=0.5;
  scored.push({entry,score,coverage});
 }
 scored.sort((a,b)=>b.score-a.score||b.coverage-a.coverage||(b.entry.date||'').localeCompare(a.entry.date||'')||b.entry.mtime-a.entry.mtime);
 return {query,matches:scored.slice(0,limit)};
}
const labelFor=entry=>humanize(entry.name);
// Two notes with the same title are told apart by date, then by folder, so a
// spoken "which one?" can be answered by name as well as by position.
export function uniqueLabels(entries,today){
 const typeName={image:'an image',pdf:'a PDF',canvas:'a canvas'};
 const labels=entries.map(labelFor);
 const folders=entry=>entry.path.split('/').slice(0,-1);
 // The shortest folder suffix that no other tied entry shares: "in drafts"
 // when that is enough, "in acme/drafts" when it is not.
 const folderLabel=(entry,label,group)=>{
  const own=folders(entry);
  for(let depth=1;depth<=own.length;depth++){const suffix=own.slice(-depth).join('/');if(!group.some(other=>other!==entry&&folders(other).slice(-depth).join('/')===suffix))return `${label} in ${suffix}`}
  return `${label} in ${own.join('/')||'vault'}`;
 };
 const stages=[
  (entry,label)=>typeName[entry.type]?`${label} as ${typeName[entry.type]}`:label,
  (entry,label)=>entry.date?`${label} from ${describeDate(entry.date,today)}`:label,
  folderLabel,
  (entry,label)=>`${label} (${entry.path.split('/').pop()})`,
 ];
 for(const stage of stages){
  const before=[...labels],shared=before.map(label=>before.filter(other=>other===label).length>1);
  if(!shared.some(Boolean))break;
  for(const [i,entry] of entries.entries())if(shared[i])labels[i]=stage(entry,before[i],entries.filter((_,j)=>shared[j]&&before[j]===before[i]));
 }
 return labels;
}

// --- worker artifacts ------------------------------------------------------------
function finalArtifacts(task){
 if(!task||!Array.isArray(task.turns))return [];
 return task.turns.flatMap(turn=>Array.isArray(turn?.artifacts)?turn.artifacts.filter(item=>item&&item.isFinal!==false&&typeof item.path==='string'):[]);
}
function pickArtifact(task,hint){
 const all=finalArtifacts(task);if(!all.length)return null;
 const byHint=hint==='image'?all.filter(a=>String(a.mime||'').startsWith('image/')):hint==='pdf'?all.filter(a=>a.mime==='application/pdf'):hint==='doc'?all.filter(a=>/^text\//.test(String(a.mime||''))):[];
 return (byHint.length?byHint:all).at(-1);
}
function undisplayableLink(task,root){
 const turn=task?.turns?.at?.(-1);
 if(!turn||!turn.artifactErrors?.length)return null;
 for(const link of linkedArtifacts(turn.text||'')){
  let relative=link.path.replace(/\\/g,'/');
  try{const absolute=path.resolve(root,relative),rel=path.relative(fs.realpathSync(root),absolute).replace(/\\/g,'/');if(rel&&!rel.startsWith('..'))relative=rel}catch{}
  return {path:relative,ext:path.extname(relative).slice(1).toLowerCase()};
 }
 return null;
}

// --- workflow run outputs ---------------------------------------------------------
// "Show me the content cascade" / "the trend scan": the newest saved output of a
// named workflow, read from the run ledgers the same way the dashboard does.
const RUN_DIRS=['system/runs','system/v2/runs'];
const SKILL_STOP=new Set([...STOP,'report','reports','run','runs','result','results','output','outputs','deliverable','file','files','doc','document']);
// A workflow name needs one word of its own; "today" or "morning" alone is not one.
const SKILL_GENERIC=new Set(['today','tomorrow','morning','weekly','daily','pull','build','run','ask','ai','yt','chase','research','review','plan','outline','angles','summary']);
const runCache=new Map();
function safeRunDeliverable(root,relative){
 if(typeof relative!=='string'||!relative.endsWith('.md')||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(p=>!p||p==='..'||p.startsWith('.')))return null;
 try{return fs.statSync(vaultPath(root,relative)).isFile()?relative:null}catch{return null}
}
export function runDeliverables(root,{now=Date.now()}={}){
 root=path.resolve(root);
 const cached=runCache.get(root);
 if(cached&&now-cached.at<30000)return cached.runs;
 const files=[];
 for(const dir of RUN_DIRS){
  let absolute;try{absolute=vaultPath(root,dir);if(fs.lstatSync(absolute).isSymbolicLink())continue}catch{continue}
  let items;try{items=fs.readdirSync(absolute,{withFileTypes:true})}catch{continue}
  for(const item of items){
   if(!item.isFile()||!item.name.endsWith('.json'))continue;
   let stat;try{stat=fs.statSync(path.join(absolute,item.name))}catch{continue}
   if(stat.size>128000)continue;
   files.push({file:path.join(absolute,item.name),mtime:stat.mtimeMs});
  }
 }
 files.sort((a,b)=>b.mtime-a.mtime);
 // Every ledger row is read, newest first, so a busy workflow cannot push an
 // older one past a cutoff; the bounds are structural (rows parsed, kept per
 // workflow, kept in total), never a clock.
 const runs=[],seen=new Set(),perSkill=new Map();
 for(const {file,mtime} of files.slice(0,5000)){
  if(runs.length>=400)break;
  let row;try{row=JSON.parse(fs.readFileSync(file,'utf8'))}catch{continue}
  if(!row||row.status!=='ok'||typeof row.skill!=='string')continue;
  if((perSkill.get(row.skill)||0)>=40)continue;
  const relative=safeRunDeliverable(root,row.deliverable_path);
  if(!relative||seen.has(relative))continue;
  seen.add(relative);perSkill.set(row.skill,(perSkill.get(row.skill)||0)+1);
  const completed=typeof row.ts_completed==='string'&&!Number.isNaN(Date.parse(row.ts_completed))?row.ts_completed:null;
  runs.push({skill:row.skill,path:relative,date:/^(\d{4}-\d{2}-\d{2})/.exec(path.basename(relative))?.[1]||(completed?localParts(new Date(completed)).iso:null),completedAt:completed,mtime});
 }
 runCache.set(root,{at:now,runs});
 return runs;
}
export function matchSkill(target){
 const words=tokenize(target).filter(t=>!SKILL_STOP.has(t));
 if(!words.length||words.every(w=>SKILL_GENERIC.has(w)))return [];
 const hits=[];
 for(const [key,skill] of Object.entries(SKILLS)){
  if(key==='voice-ask'||typeof skill?.label!=='string')continue;
  const tokens=[...new Set([...tokenize(key.replace(/-/g,' ')),...tokenize(skill.label)])];
  // Exact or prefix only: "context" must never become "content".
  const near=(w,t)=>w===t||(w.length>=4&&t.startsWith(w))||(t.length>=4&&w.startsWith(t));
  if(!words.every(w=>tokens.some(t=>near(w,t))))continue;
  const covered=tokens.filter(t=>words.some(w=>near(w,t))).length;
  hits.push({key,label:skill.label.split(' ').map(w=>/^[A-Z0-9]+$/.test(w)?w:w.toLowerCase()).join(' '),coverage:covered/tokens.length});
 }
 hits.sort((a,b)=>b.coverage-a.coverage||a.key.localeCompare(b.key));
 return hits.length?hits.filter(h=>h.coverage>=hits[0].coverage-0.01):[];
}

// --- promised opens ------------------------------------------------------------------
// "Once you create that, open it" / "make the diagram and then show me" attach
// an open to the work. They are not open requests now and never a lookup.
const NEGATED_OPEN=/\b(?:don't|do not|no need to|without|never|not|under no circumstances)\b(?:\s+\S+){0,6}?\s+(?:open|show|display|pull|bring|pop)\b/;
// "Open it only after I approve it" / "open it tomorrow" is not a completion-time promise.
const CONDITIONAL_OPEN=/\b(?:open|show|display|pull|bring|put|pop)\b[^.!?;]*\b(?:only (?:after|once|when|if)|(?:after|once|when|if) (?:i|we)\b|when i (?:say|ask)|tomorrow|tonight|later|next (?:week|time|month)|not yet|in (?:an?|\d+|a few|a couple of|half an|several) (?:hours?|minutes?|days?|weeks?)|at (?:\d{1,2}(?::\d{2})?\s*(?:am|pm|o'clock)|noon|midnight)|this (?:afternoon|evening)|after (?:lunch|dinner)|end of (?:the )?day|first thing|in the morning)\b|\b(?:only (?:after|once|when|if)|(?:after|once|when|if) (?:i|we)\b|tomorrow|tonight|later)\b[^.!?;]*\b(?:open|show|display|pull|bring|pop)\b/;
// "Open it when done. Actually, do not." takes the promise back.
const RETRACTED_OPEN=/\b(?:actually|no|wait|never ?mind|scratch that|forget (?:it|that))[,\s]+(?:do not|don't|never ?mind|forget (?:it|that)|scratch that|no need|skip (?:it|that)|leave it)[.!?\s]*$|\bnever ?mind (?:the |about )?(?:open\w*|show\w*|display\w*)\b/;
const COMPLETION=/\b(?:once|when|after|as soon as|whenever)\s+(?:(?:you(?:'re|'ve|'d|'ll| are| have| had| will)?|it(?:'s| is| has)?|that(?:'s| is| has)?|its|thats|this(?:'s| is)?|the \w+(?: \w+)?(?:'s| is| has)?)\s+(?:\w+\s+){0,3}?)?(?:done|finished|ready|complete|completed|created|made|built|generated|rendered|saved|finish|create|make|build|generate|render|exists?|there|got it|have it|come back|comes back|returns?)\b/;
const THEN_OPEN=/\b(?:and then|then|after that|afterwards?|and(?: also)?|also)[,\s]+(?:(?:um|uh|like|please|just|also)[,\s]+)*(?:(?:can|could|would|will) you\s+)?(?:please\s+|just\s+|also\s+)?(?:open|show|display|pull|bring|put|pop)\b/;
const OPEN_OBJECT="(?:it|that|them|this|those|'?em|the (?:\\w+ ){0,2}?(?:result|results|file|files|image|images|output|explainer|graphic|diagram|chart|pdf|doc|document|visual|picture|thing|version|one|artwork|illustration|poster|drawing|render|mockup|design|logo|banner))";
const OPEN_REF=new RegExp(`\\b(?:(?:open|display|show(?: me| us)?|pull up|bring up|put up|pop up)\\s+${OPEN_OBJECT}\\b|(?:pull|bring|put|pop)\\s+${OPEN_OBJECT}\\s+(?:back )?up\\b|show (?:me|us)(?:\\s+(?:what you (?:made|created|built|did|found|got|have|learned|discovered|came up with)|the results?))?(?=[,.!?;]|$| when| once| after))`);
export function deferredOpen(transcript){
 if(typeof transcript!=='string')return false;
 const text=transcript.normalize('NFKC').replace(/[’‘]/g,"'").toLowerCase().replace(/\s+/g,' ').trim();
 if(!text||text.length>1200||openIntent(text))return false;
 // Each sentence is judged on its own, commas flattened and clock colons kept.
 // A condition, negation or retraction withdraws the promise when it sits in
 // the sentence that asks for the open, or is a sentence of its own about the
 // open ("Only after I approve it.", "Actually, do not."). A sentence about
 // something else ("I will call the client tomorrow.") does not.
 const sentences=text.split(/[.!?;]+/).map(s=>s.replace(/,+|(?<!\d):|:(?!\d)/g,' ').replace(/\s+/g,' ').trim()).filter(Boolean);
 if(!sentences.some(s=>OPEN_REF.test(s)))return false;
 // A sentence of its own withdraws the promise only when it is a bare
 // condition about me or us, or a retraction; "Actually, can you create…"
 // is a request, not a retraction.
 const BARE_CONDITION=/^(?:only (?:after|once|when|if)|(?:after|once|when|if|unless|until) (?:i|we)|not (?:yet|now|right now)|no need)/;
 for(const s of sentences){
  const opens=OPEN_REF.test(s);
  if(opens&&(NEGATED_OPEN.test(s)||CONDITIONAL_OPEN.test(s)||RETRACTED_OPEN.test(s)))return false;
  if(!opens&&(BARE_CONDITION.test(s)||RETRACTED_OPEN.test(s)))return false;
 }
 return COMPLETION.test(text)||THEN_OPEN.test(text);
}

// --- the resolver ----------------------------------------------------------------
export function resolveOpenTarget(root,transcript,{now=new Date(),exchanges=[],selectedTask=null,taskById=()=>null,appScope='web',timeZone}={}){
 root=path.resolve(root);
 const nowMs=now.getTime(),today=localParts(now,timeZone).iso;
 const last=exchanges.at(-1),fresh=last&&nowMs-Date.parse(last.ts)<180000?last:null;
 const plain=String(transcript||'').normalize('NFKC').replace(/[’‘]/g,"'").toLowerCase().trim();
 // Follow-ups to a candidate list or an offered nearest date.
 if(fresh?.lookup?.source==='open-candidates'&&Array.isArray(fresh.lookup.candidates)){
  const candidates=fresh.lookup.candidates;
  const ordinal=ORDINAL.exec(plain.replace(PREAMBLE,'').replace(REQUEST,''));
  let pick=null;
  if(ordinal){const word=ordinal[1];const index={first:0,'1st':0,'1':0,one:0,top:0,second:1,'2nd':1,'2':1,two:1,third:2,'3rd':2,'3':2,three:2,fourth:3,'4th':3,'4':3,four:3,fifth:4,'5th':4,'5':4,five:4,last:candidates.length-1}[word];pick=candidates[index]??null}
  else{const words=tokenize(plain).filter(t=>!STOP.has(t));if(words.length){const hits=candidates.filter(c=>{const label=tokenize(c.label);return words.every(w=>label.some(t=>tokenMatch(w,t)>=2))});if(hits.length===1)pick=hits[0]}}
  if(pick)return pick.artifact?{kind:'artifact',taskId:pick.taskId,artifact:pick.artifact,label:pick.label}:{kind:'note',path:pick.path,label:pick.label,type:pick.type||'note'};
 }
 if(fresh?.lookup?.source==='open-offer'&&fresh.lookup.path&&AFFIRM.test(plain))return {kind:'note',path:fresh.lookup.path,label:fresh.lookup.label,type:'note',referent:true};
 const intent=openIntent(transcript);
 if(!intent)return null;
 const when=parseSpokenDate(intent.target,{now,timeZone});
 const target=(when?when.rest:intent.target).replace(/\b(?:latest|last|most recent|newest|current)\b/g,' ').replace(/\s+/g,' ').trim();
 const base={where:intent.where,when};
 const hint=IMAGE_HINT.test(target)?'image':PDF_HINT.test(target)?'pdf':DOC_HINT.test(target)?'doc':null;
 // 1. Named report kinds. The remaining words must all belong to the report
 // name: "the graphic you made from the brief" is not a request for the brief.
 const kind=hint==='image'||hint==='pdf'?null:matchReportKind(target);
 const leftover=kind?tokenize(target.replace(kind.re,' ')).filter(t=>!STOP.has(t)&&!REPORT_WORDS.has(t)):[];
 if(kind&&!leftover.length){
  const {file,nearest}=pickReport(reportFiles(root,kind),when);
  if(file)return {...base,kind:'report',report:kind.name,path:file.path,label:kind.label,date:file.date,type:'note'};
  const noun=`${kind.label} report`;
  if(when)return {...base,kind:'missing',label:noun,dateLabel:when.label,nearest:nearest?{path:nearest.path,label:`${noun} from ${describeDate(nearest.date,today)}`}:null};
  return {...base,kind:'missing',label:noun,nearest:null};
 }
 // 1b. Named workflow outputs ("the content cascade", "the trend scan"): the
 // newest saved run of that workflow. Whole words only; a note wins only when
 // no workflow is named.
 if(!kind&&hint!=='image'&&hint!=='pdf'){
  const skills=matchSkill(target);
  // An exact note title wins over a workflow name.
  const asked=tokenize(target).filter(t=>!STOP.has(t)).join(' ');
  const exactNote=skills.length&&asked?targetIndex(root,{now:nowMs}).some(e=>!e.index&&e.tokens.join(' ')===asked):false;
  if(skills.length&&!exactNote){
   const runs=runDeliverables(root,{now:nowMs});
   const withRuns=skills.map(s=>({...s,files:runs.filter(r=>r.skill===s.key).map(r=>({path:r.path,date:r.date,mtime:r.mtime,preferred:true})).sort((a,b)=>(b.date||'').localeCompare(a.date||'')||b.mtime-a.mtime)})).filter(s=>s.files.length);
   if(withRuns.length>1)return {...base,kind:'ambiguous',candidates:withRuns.map(s=>({path:s.files[0].path,label:s.label,type:'note'}))};
   const chosen=withRuns[0]||skills[0];
   const noun=`${chosen.label} report`;
   if(!withRuns.length)return {...base,kind:'missing',label:noun,...(when?{dateLabel:when.label}:{}),nearest:null};
   const {file,nearest}=pickReport(chosen.files,when);
   if(file)return {...base,kind:'report',report:chosen.key,path:file.path,label:chosen.label,date:file.date,type:'note'};
   return {...base,kind:'missing',label:noun,dateLabel:when.label,nearest:nearest?{path:nearest.path,label:`${noun} from ${describeDate(nearest.date,today)}`}:null};
  }
 }
 // 2. Daily notes. Today's note (and placements) stay with the existing
 // daily-note action; only dated asks resolve here.
 if(!kind&&(DAILY_RE.test(target)||(when&&/^(?:note|notes)$/.test(target)))){
  if(!when)return null;
  const date=when.kind==='day'?when.date:today;
  const relative=`daily-notes/${date}.md`;
  let exists=false;try{exists=fs.statSync(vaultPath(root,relative)).isFile()}catch{}
  if(exists)return {...base,kind:'daily',path:relative,label:`daily note for ${describeDate(date,today)}`,date,type:'note'};
  const older=targetIndex(root,{now:nowMs}).filter(e=>e.path.startsWith('daily-notes/')&&e.date&&e.date<date).sort((a,b)=>b.date.localeCompare(a.date))[0];
  return {...base,kind:'missing',label:'daily note',dateLabel:describeDate(date,today),nearest:older?{path:older.path,label:`daily note from ${describeDate(older.date,today)}`}:null};
 }
 // 3. Referential asks resolve against the selected conversation, then what was just shown.
 const words=tokenize(target);
 // "The poster you made" points at worker output even though "poster" is a
 // real word: anything attributed to the assistant resolves like a pronoun.
 const referential=!words.length||words.every(w=>GENERIC.has(w)||STOP.has(w))||BY_WORKER.test(target);
 // A date inside a worker reference ("the graphic you made on yesterday's
 // report") describes the source, not a file to filter by.
 if(referential&&(!when||BY_WORKER.test(target))){
  if(selectedTask){
   const artifact=pickArtifact(selectedTask,hint);
   if(artifact)return {...base,kind:'artifact',taskId:selectedTask.id,artifact,label:artifact.label||path.basename(artifact.path),selected:true};
   const link=undisplayableLink(selectedTask,root);
   if(link)return {...base,kind:'undisplayable',path:link.path,ext:link.ext,taskTitle:selectedTask.title};
  }
  for(const exchange of [...exchanges].reverse()){
   if(nowMs-Date.parse(exchange.ts)>30*60*1000)break;
   if(exchange.deliverable&&(!hint||hint==='doc'))return {...base,kind:'note',path:exchange.deliverable,label:humanize(path.basename(exchange.deliverable,'.md')),type:'note',referent:true};
   for(const id of exchange.workIds||[]){
    const task=taskById(id);const artifact=task?pickArtifact(task,hint):null;
    if(artifact)return {...base,kind:'artifact',taskId:task.id,artifact,label:artifact.label||path.basename(artifact.path),selected:selectedTask?.id===task.id,taskTitle:task.title};
   }
  }
  return {...base,kind:'unresolved',target:intent.target,referential:true};
 }
 // 4. Named notes and files.
 const types=hint==='image'?['image']:hint==='pdf'?['pdf']:null;
 const {matches,query}=searchTargets(root,target,{when,now:nowMs,types});
 if(!matches.length)return {...base,kind:'unresolved',target:intent.target,dateLabel:when?.label||null};
 const [top,second]=matches,tied=matches.filter(m=>m.score>=top.score-0.01);
 if(second&&second.score>=top.score-0.01&&(query.length||!when)){const labels=uniqueLabels(tied.map(m=>m.entry),today);return {...base,kind:'ambiguous',candidates:tied.map((m,i)=>({path:m.entry.path,label:labels[i],type:m.entry.type}))}}
 if(!query.length&&when&&matches.length>1){const labels=uniqueLabels(matches.map(m=>m.entry),today);return {...base,kind:'ambiguous',candidates:matches.map((m,i)=>({path:m.entry.path,label:labels[i],type:m.entry.type}))}}
 return {...base,kind:'note',path:top.entry.path,label:labelFor(top.entry),type:top.entry.type,date:top.entry.date};
}

export function describeCandidates(candidates){
 const labels=candidates.map(c=>c.label);
 if(labels.length<=1)return labels[0]||'';
 return `${labels.slice(0,-1).join(', ')} or ${labels.at(-1)}`;
}

// --- Jev-gated strict opens --------------------------------------------------------
// Used only after Jev has said the whole utterance asks to open something. Jev's
// label never acts: every spoken word must be explained here, names match
// literally, and exactly one file may qualify. Anything else is a refusal with
// a reason, and the model decides exactly as before. Nothing above this line
// uses any of it, and none of it reads or writes the caches above.
// No two alternatives may match the same words: a run of them followed by anything else is otherwise retried
// in 2^n ways ("on screen" used to be listed twice, once inside "on (the |my )?screen").
const GIVEN_TRAILING=/(?:[,\s]+(?:for me|please|thanks|thank you|jarvis|astra|again|real quick|really quick|quickly|right now|now|in obsidian|inside (?:of )?obsidian|up on (?:the |my )?screen|on (?:the |my )?screen))+$/;
const GIVEN_REFUSED=/\b(?:don't|do not|never|not|no|without|unless|instead|only|after|once|until|before|when|whenever|if|later|tomorrow|tonight|how|why|what|where|which|who|whose|whether|explain|tell|describe|summari[sz]e|read)\b|[;:]/;
// Opens land in the default place only. A tab request is not the default: the
// executor reuses a leaf that already shows the file, wherever that leaf is.
const GIVEN_PLACEMENT=/\b(?:split|sidebar|side ?bar|pane|panes|panel|window|windows|tab|tabs|beside|next to)\b/;
const GIVEN_ASK=/^(?:(?:can|could|would|will) you(?: please| just)?|would you mind|go ahead and|please|just|quickly|real quick)[,\s]+/;
// The assistant shows it…
const GIVEN_SHOW=/^(?:open(?: up| back up)?|reopen|re-open|show(?: me| us)?|display|pull (?:up|back up)|bring (?:up|back up)|put up|pop (?:open|up)|go to|navigate to|jump to|switch to|take me to)\s+(.+)$/;
const GIVEN_SEPARABLE=/^(?:pull|bring|put|pop)\s+(?!(?:up|back|open)\b)(.+?)\s+(?:back\s+)?up$/;
// …or the user looks at it, with the user as the subject. "Can you have a look
// at the research?" asks the assistant to review it and is not an open.
const GIVEN_LOOK=/^(?:(?:can|could|may) (?:i|we)(?: please| just)?|let me|lemme|let's|lets|i (?:wanna|want to|need to|would like to)|i'd like to)\s+(?:see|view|look at|(?:take|have|get) a (?:quick )?(?:look|peek) at|peek at)\s+(.+)$/;
export function openIntentGiven(transcript){
 if(typeof transcript!=='string')return {refused:'no-transcript'};
 const whole=transcript.normalize('NFKC').replace(/[’‘]/g,"'").replace(/[“”]/g,'"').toLowerCase().replace(/\s+/g,' ').trim();
 if(!whole||whole.length>300||/\n|"|https?:\/\//.test(whole))return {refused:'shape'};
 if(whole.split(/[.!?]+/).map(part=>part.trim()).filter(Boolean).length>1)return {refused:'multi-sentence'};
 let text=whole.replace(/[.!?]+$/,'').replace(/,/g,' ').replace(/\s+/g,' ').trim();
 for(let i=0;i<4;i++){const next=text.replace(PREAMBLE,'').replace(GIVEN_TRAILING,'').trim();if(next===text)break;text=next}
 if(GIVEN_REFUSED.test(text))return {refused:'refused-word'};
 if(COMPOUND.test(text))return {refused:'compound'};
 if(NEGATED_OPEN.test(text)||CONDITIONAL_OPEN.test(text)||COMPLETION.test(text))return {refused:'conditional'};
 if(WHERE.test(text)||GIVEN_PLACEMENT.test(text))return {refused:'placement'};
 let target=GIVEN_LOOK.exec(text)?.[1];
 if(!target){
  let asked=text;for(let i=0;i<3;i++){const next=asked.replace(GIVEN_ASK,'').trim();if(next===asked)break;asked=next}
  target=GIVEN_SEPARABLE.exec(asked)?.[1]??GIVEN_SHOW.exec(asked)?.[1];
 }
 if(!target)return {refused:'no-lead'};
 target=target.replace(/^(?:up\s+)+/,'').trim();
 if(!target)return {refused:'no-target'};
 if(WEB_OR_UI.test(target)||DETAIL.test(target))return {refused:'not-a-file'};
 return {target};
}

// Words that may be ignored: determiners, and nothing else. Deliberately not
// STOP: "previous", "old", "new", "version" and "copy" are constraints, and a
// constraint nothing explains is a refusal. Prepositions are relationships
// ("the files IN the weekly review" is not the weekly review) and are kept.
const FILLER=new Set(['the','a','an','my','our','your','that','this','those','these']);
const DETERMINER=FILLER;
// "The research note on Kevin Ngo": only right after a word that says what kind
// of file it is may "on" or "about" introduce the name.
const NAMING=new Set(['on','about','called','named','titled']);
const NEWEST=/\b(?:latest|last|most recent|newest|current)\b/g;
const STRICT_REPORT_NOUN=/^(?:report|reports|brief|briefing|list|sweep|scan|repos|repositories)$/;
const MONTHS='jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
// Only date phrases with one reading. The shared parser always counts a weekday
// backwards ("this Friday" becomes last week's) and moves a yearless calendar
// date that has not happened yet into last year, so a calendar date needs its year.
const STRICT_DATE=new RegExp(`^(?:(?:from|for|on|of|dated|back on)\\s+)?(?:this morning(?:'s)?|today(?:'s)?|todays|earlier today|(?:the\\s+)?day before yesterday(?:'s)?|yesterday(?:'s)?(?:\\s+morning)?|(?:\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\\s+days?\\s+(?:ago|back)|(?:last|this)\\s+week(?:'s)?|\\d{4}-\\d{2}-\\d{2}|(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS}),?\\s+\\d{4}|\\d{1,2}/\\d{1,2}/\\d{4})$`);
// Singular only: "the files" or "the notes" asks for several things, and one file cannot be that.
const TYPE_WORDS={note:'note',doc:'note',document:'note',page:'note',file:'any',image:'image',picture:'image'};
// A spoken file format is a constraint of its own: "the logo png" is never the SVG.
const EXTENSION_WORDS={png:['png'],jpg:['jpg','jpeg'],jpeg:['jpg','jpeg'],svg:['svg'],gif:['gif'],webp:['webp'],pdf:['pdf'],canvas:['canvas'],markdown:['md']};
const strictIndexes=new Map();
export function invalidateStrictIndex(root){if(root)strictIndexes.delete(path.resolve(root));else strictIndexes.clear()}
// The same files, skip rules and limits as targetIndex, read without blocking
// the event loop and kept in a cache of its own.
export function strictIndex(root,{now=Date.now(),cache=strictIndexes,signal}={}){
 root=path.resolve(root);
 const cached=cache.get(root);
 if(cached&&now-cached.ts<INDEX_TTL)return cached.entries;
 const build=(async()=>{
  const entries=[];
  const walk=async(dir,relative,depth)=>{
   if(depth>12||entries.length>=MAX_FILES)return;
   if(signal?.aborted)throw new Error('Index build cancelled');
   let items;try{items=await fs.promises.readdir(dir,{withFileTypes:true})}catch{return}
   for(const item of items){
    if(item.name.startsWith('.')||item.isSymbolicLink())continue;
    const rel=relative?`${relative}/${item.name}`:item.name;
    if(item.isDirectory()){if(!relative&&SKIP_DIRS.has(item.name))continue;await walk(path.join(dir,item.name),rel,depth+1);continue}
    if(!item.isFile()||entries.length>=MAX_FILES)continue;
    const ext=path.extname(item.name).slice(1).toLowerCase(),type=TYPES[ext];
    if(!type)continue;
    const name=item.name.slice(0,-(ext.length+1)),date=/^(\d{4}-\d{2}-\d{2})/.exec(name)?.[1]||null;
    entries.push({path:rel,name,ext,type,date,tokens:tokenize(date?name.slice(10):name),folderTokens:tokenize(relative),archived:/(?:^|\/)archive(?:\/|$)/.test(relative),index:name==='_index'||name.endsWith('_index')});
   }
  };
  await walk(root,'',0);
  return entries;
 })();
 const entry={ts:now,entries:build};cache.set(root,entry);
 // A failed or cancelled build is never served from the cache.
 build.catch(()=>{if(cache.get(root)===entry)cache.delete(root)});
 return build;
}
async function reportFilesAsync(root,kind){
 const out=[];
 for(const dir of kind.dirs){
  let absolute;try{absolute=vaultPath(root,dir);if((await fs.promises.lstat(absolute)).isSymbolicLink())continue}catch{continue}
  let items;try{items=await fs.promises.readdir(absolute,{withFileTypes:true})}catch{continue}
  for(const item of items){
   if(!item.isFile()||!item.name.endsWith('.md')||item.name.startsWith('_')||item.name.endsWith('_index.md'))continue;
   const relative=`${dir}/${item.name}`;let stat;try{stat=await fs.promises.stat(vaultPath(root,relative))}catch{continue}
   if(!stat.isFile())continue;
   out.push({path:relative,date:/^(\d{4}-\d{2}-\d{2})/.exec(item.name)?.[1]||null,mtime:stat.mtimeMs,preferred:kind.filter?kind.filter.test(item.name):true});
  }
 }
 return out.sort((a,b)=>(b.date||'').localeCompare(a.date||'')||b.mtime-a.mtime||b.path.localeCompare(a.path));
}
/** Resolves a target Jev vouched for to exactly one file, or refuses with a reason. */
export async function resolveOpenStrict(root,target,{now=new Date(),appScope='web',timeZone,cache,signal}={}){
 root=path.resolve(root);
 const spoken=String(target||'').toLowerCase().replace(/\s+/g,' ').trim();
 if(!spoken)return {refused:'no-target'};
 const when=parseSpokenDate(spoken,{now,timeZone});
 if(when&&!STRICT_DATE.test(when.matched))return {refused:'date-form'};
 let rest=when?when.rest:spoken;
 if(when&&parseSpokenDate(rest,{now,timeZone}))return {refused:'date-form'};
 const newest=rest.search(NEWEST)>=0;
 if(newest&&when)return {refused:'date-form'};
 rest=rest.replace(NEWEST,' ').replace(/\s+/g,' ').trim();
 // One bounded construction only: "<type word> on/about/called <name>", once.
 // Its naming word is dropped. With two naming words there is a relationship
 // between two things ("the note about the file called X" is not X): nothing is
 // dropped, the words stay unexplained, and the request is refused below.
 const content=tokenize(rest).filter(word=>!FILLER.has(word));
 const naming=content.map((word,index)=>NAMING.has(word)?index:-1).filter(index=>index>=0);
 const words=naming.length===1&&naming[0]>0&&naming[0]<content.length-1&&TYPE_WORDS[content[naming[0]-1]]?content.filter((_,index)=>index!==naming[0]):content;
 if(!words.length)return {refused:'deferred-referential'};
 // 1. A named saved report, as an ordered phrase: [filler] <report name> [one report noun].
 const kind=IMAGE_HINT.test(rest)||PDF_HINT.test(rest)?null:matchReportKind(rest);
 if(kind){
  const match=kind.re.exec(rest);
  // Only determiners may come before the name, and only one report noun may
  // follow it directly: "the weekly review in a list" asks for something else.
  const before=tokenize(rest.slice(0,match.index)).filter(word=>!DETERMINER.has(word)),after=tokenize(rest.slice(match.index+match[0].length));
  if(!before.length&&(!after.length||(after.length===1&&STRICT_REPORT_NOUN.test(after[0])))){
   const {file}=pickReport(await reportFilesAsync(root,kind),when);
   return file?{kind:'report',report:kind.name,path:file.path,date:file.date}:{refused:'report-missing'};
  }
  // A report is named, but with words around it this grammar does not
  // understand. That is a request about the report, not the report.
  return {refused:'report-grammar'};
 }
 // "Latest" only has a defined meaning for saved reports. For a named file it
 // would be dropped, and an older exact title could win.
 if(newest)return {refused:'newest-named-file'};
 // Recognised, but not opened by this release; the reason shows the demand.
 if(words.every(word=>GENERIC.has(word)||STOP.has(word))||BY_WORKER.test(rest))return {refused:'deferred-referential'};
 if(DAILY_RE.test(rest))return {refused:'deferred-daily'};
 if(matchSkill(rest).length)return {refused:'deferred-workflow-output'};
 // 2. A named file: every word is literally in the name (or its folder, or says
 // the file's type), and exactly one file in the whole index qualifies.
 const entries=await strictIndex(root,{now:now.getTime(),...(cache?{cache}:{}),signal});
 const formats=words.filter(word=>EXTENSION_WORDS[word]).map(word=>EXTENSION_WORDS[word]);
 const inWindow=entry=>!when||(entry.date&&(when.kind==='range'?entry.date>=when.from&&entry.date<=when.to:entry.date===when.date));
 const qualifies=(entry,typed)=>{
  if(entry.index&&!words.includes('index'))return false;
  if(appScope==='web'&&entry.type!=='note')return false;
  if(!inWindow(entry))return false;
  // A spoken format must be the file's format, whether or not the word is also in its name.
  if(formats.length&&!formats.every(list=>list.includes(entry.ext)))return false;
  let nameHits=0,described=0;
  for(const word of words){
   if(entry.tokens.includes(word)){nameHits++;continue}
   if(typed&&EXTENSION_WORDS[word])continue;
   if(entry.folderTokens.includes(word))continue;
   const type=typed?TYPE_WORDS[word]:null;
   // One word may say what kind of file it is. Two ("the note ... the file ...") are two things.
   if(type&&(type==='any'||type===entry.type)&&++described===1)continue;
   return false;
  }
  return nameHits>0;
 };
 // Files that contain every word come first ("the draft script notes" is the
 // notes file). Only when there is none may "note" or "image" describe the file
 // instead of naming it.
 const literal=entries.filter(entry=>qualifies(entry,false)),full=literal.length?literal:entries.filter(entry=>qualifies(entry,true));
 if(!full.length)return {refused:'no-match'};
 if(full.length===1)return {kind:'note',path:full[0].path,type:full[0].type,date:full[0].date};
 // More than one file fits. An exact title is not a tie-break: with five
 // "agentic os video" notes, the one titled exactly that was an archived one.
 return {refused:`ambiguous:${full.length}`};
}
// The routed result for a strict resolution: the shapes the rules open path
// returns for a saved report and for a named file, in the default place.
export function strictOpenRouted(resolved){
 const base={tier:2,engine:'rules',context:'',panels:['documents'],lookupRoute:'open',reply:''};
 if(resolved?.kind==='report')return {...base,deliverable:resolved.path,reveal:'open'};
 if(resolved?.kind==='note')return {...base,obsidian:{op:'open-note',query:resolved.path}};
 return null;
}
/** The validator for resolved open actions. It runs before the model call is
 * cancelled. It can only reject: the exact path is kept as resolved. */
export function validateStrictOpen(routed,{root,appScope='web'}={}){
 if(!routed||typeof routed!=='object'||routed.tier!==2||routed.reply!==''||routed.lookupRoute!=='open'||routed.engine!=='rules')return false;
 const allowed=new Set(['tier','engine','context','panels','lookupRoute','reply','deliverable','reveal','obsidian']);
 if(Object.keys(routed).some(key=>!allowed.has(key)))return false;
 const viaReport=typeof routed.deliverable==='string',viaNote=Boolean(routed.obsidian&&typeof routed.obsidian==='object');
 if(viaReport===viaNote)return false;
 if(viaReport&&(routed.reveal!=='open'||!routed.deliverable.endsWith('.md')))return false;
 if(viaNote&&(routed.reveal!==undefined||Object.keys(routed.obsidian).some(key=>key!=='op'&&key!=='query')||routed.obsidian.op!=='open-note'))return false;
 const relative=viaReport?routed.deliverable:routed.obsidian.query;
 if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(part=>!part||part==='..'||part.startsWith('.')))return false;
 const type=TYPES[path.extname(relative).slice(1).toLowerCase()];
 if(!type||(appScope==='web'&&type!=='note'))return false;
 try{return fs.statSync(vaultPath(path.resolve(root),relative)).isFile()}catch{return false}
}
