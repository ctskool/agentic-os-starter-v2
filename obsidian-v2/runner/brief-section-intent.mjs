// Read-only slot extraction for sections already saved in Morning Intel.
// This module performs no I/O. Unconsumed requirements stay visible to the
// scoped interpreter or the normal router; they never become a partial answer.
const SECTIONS=new Set(['inbox','ai-claude','ai-codex','ai-other','youtube','outliers','github','content-youtube','content-linkedin','content-shorts','source-status']);
const CATEGORIES=new Set(['summary','urgent','reply','sponsor']);
const NUMBER={one:1,two:2,three:3,four:4,five:5};
const ORDINAL={first:0,second:1,third:2,fourth:3,fifth:4,'1st':0,'2nd':1,'3rd':2,'4th':3,'5th':4};
const FILLER=new Set(('hey hi hello okay ok so well please jarvis astra just quick quickly briefly real really actually again me us my our your you i we the a an this that these those it its them one of for from in on at by to with about is are was were do does did has have had can could would will should there any anything what whats which who when how many much tell say show showed give get read list recap summarize summarise remind know want wanted need wondering hear see find found cover covered out up let lets today morning mornings saved report reports brief briefing intel section sections part parts current available recent newly top best leading highest ranked ranking number pick picks item items entry entries first second third fourth fifth next another latest new news updates update developments happenings highlights headline headlines story stories').split(' '));
const normalize=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[’‘]/g,"'")
 .replace(/\b(what|how|who|where)'s\b/g,'$1 is').replace(/\b(today|morning)'s\b/g,'$1')
 .replace(/\b(?:um+|uh+|you know)\b/g,' ').replace(/\byou tube\b/g,'youtube').replace(/\bgit hub\b/g,'github')
 .replace(/\baccording to\b/g,'from')
 .replace(/\be[- ]mails?\b/g,'emails').replace(/\blinked in\b/g,'linkedin').replace(/\s+/g,' ').trim();
const sourceHint=/\b(?:inbox|emails?|mail|messages?|sponsors?|sponsorships?|claude|anthropic|codex|openai|other ai|everyone else|youtube|github|outliers?|linkedin|shorts|carousels|sources?)\b/;
const actionable=/\b(?:create|make|build|write|draft|generate|design|produce|research|investigate|browse|search|verify|fact.check|refresh|run|execute|download|install|delete|edit|publish|send|forward|archive|unsubscribe|schedule|compare|analy[sz]e|dig into)\b/;
const freshness=/\b(?:live|fresh|freshly|real.time|right now|currently|up.to.date|since|after|before|yesterday|tomorrow|last night|last week|last month|last year|this week|this month|next week|tonight|afternoon|evening)\b|\b\d{4}[-/]\d{1,2}|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/;
const negation=/\b(?:no|not|never|don't|dont|isn't|isnt|aren't|arent|without|except|excluding|instead|only|unless)\b/;
const compound=/\b(?:and|also|then|plus|but|along with|as well as)\b|[;\n]/;
const cleanWords=text=>text.replace(/[^a-z0-9'\s-]/g,' ').split(/\s+/).filter(Boolean);
const outside=(guarded=false,reason='unsupported-section-request')=>({kind:'outside',...(guarded?{guarded:true,reason}:{})});

export function validBriefSectionPrevious(value){
 if(!value||value.source!=='brief-section'||!SECTIONS.has(value.section)||!/^\d{4}-\d{2}-\d{2}$/.test(value.date||''))return false;
 if(typeof value.briefSource!=='string'||!/^inbox\/(?:research\/morning-intel|reports\/morning)\/\d{4}-\d{2}-\d{2}[^/\\]*\.md$/.test(value.briefSource))return false;
 if(!value.briefSource.split('/').at(-1).startsWith(value.date))return false;
 if(value.category!==undefined&&(value.section!=='inbox'||!CATEGORIES.has(value.category)))return false;
 const count=value.count??3,offset=value.offset??0;
 return Number.isInteger(count)&&count>=1&&count<=5&&Number.isInteger(offset)&&offset>=0&&offset<=4&&count+offset<=5;
}

function identify(text){
 const sections=[];
 const content=/\b(?:content|ideas?|angles?|content plan|ranked ideas?|recommendations?|suggestions?)\b/.test(text);
 const youtube=/\byoutube|\byt\b/.test(text),linkedin=/\blinkedin\b/.test(text),shorts=/\b(?:shorts|carousels|short.form)\b/.test(text);
 if(/\b(?:inbox|emails?|mail|messages?|sponsors?|sponsorships?)\b/.test(text))sections.push('inbox');
 else if(/\b(?:urgent|operational)\b/.test(text)&&/\b(?:items?|alerts?)\b/.test(text)&&/\b(?:brief|briefing|intel)\b/.test(text))sections.push('inbox');
 if(/\b(?:claude|anthropic)\b/.test(text)&&/\b(?:news|new|updates?|developments?|morning|brief|briefing|intel|section)\b/.test(text))sections.push('ai-claude');
 if(/\b(?:codex|openai)\b/.test(text)&&/\b(?:news|new|updates?|developments?|morning|brief|briefing|intel|section)\b/.test(text))sections.push('ai-codex');
 if(/\b(?:other ai|everyone else|rest of ai|other (?:ai )?(?:companies|models|labs)|ai elsewhere)\b/.test(text))sections.push('ai-other');
 if(content&&youtube)sections.push('content-youtube');
 if(content&&linkedin)sections.push('content-linkedin');
 if(content&&shorts)sections.push('content-shorts');
 if(!content&&/\b(?:outliers?|small.channel|small channels?)\b/.test(text))sections.push('outliers');
 if(!content&&!/\b(?:outliers?|small.channel|small channels?)\b/.test(text)&&youtube&&/\b(?:radar|videos?|creators?|channels?|watch|morning|brief|briefing|intel)\b/.test(text))sections.push('youtube');
 if(/\bgithub\b/.test(text))sections.push('github');
 if(/\b(?:source status|sources?|data sources?)\b/.test(text)&&/\b(?:status|working|worked|failed|failing|available|unavailable|availability|coverage|morning|brief|briefing|intel|health)\b/.test(text))sections.push('source-status');
 return [...new Set(sections)];
}

function wordsFor(section){
 const words={
  inbox:'inbox email emails mail messages message sponsor sponsors sponsorship sponsorships pitch pitches opportunity opportunities urgent urgency operational alerts alert reply replies replying respond response responses answer needs needing worth attention requires require waiting commitments commitment summary summaries needing followup follow-up',
  'ai-claude':'claude code anthropic ai artificial intelligence happened happening released releases announcements announcement tools tool',
  'ai-codex':'codex openai ai artificial intelligence happened happening released releases announcements announcement tools tool',
  'ai-other':'other ai everyone else rest companies company models model labs lab elsewhere artificial intelligence happened happening released releases announcements announcement tools tool',
  youtube:'youtube yt radar videos video creators creator channels channel watch watched finds found',
  outliers:'youtube yt radar outlier outliers small-channel small channels channel videos video creators creator found finds',
  github:'github radar trending repo repos repository repositories project projects picks found finds',
  'content-youtube':'youtube yt content plan idea ideas angle angles video videos already suggest suggested suggestions recommend recommended recommendations picked listed',
  'content-linkedin':'linkedin content plan idea ideas angle angles post posts already suggest suggested suggestions recommend recommended recommendations picked listed',
  'content-shorts':'shorts carousels carousel short-form content plan idea ideas angle angles video videos already suggest suggested suggestions recommend recommended recommendations picked listed',
  'source-status':'source sources data status health healthy unhealthy working worked failed failing available unavailable availability collected collecting collection coverage missing skipped successful success summary summaries',
 };
 return new Set(words[section].split(' '));
}

export function inspectBriefSectionRequest(utterance,{previous}={}){
 const text=normalize(utterance),prior=validBriefSectionPrevious(previous)?previous:null;
 const hinted=sourceHint.test(text),defer=reason=>outside(hinted||!!prior,reason);
 if(!text||text.length>500)return defer('unsupported-length');
 // Preserve exact existing workflows and workspace navigation. A question
 // about their saved contents is handled below instead of rerunning anything.
 if(/^(?:(?:please|hey|okay|ok)\s+)*(?:(?:run|refresh|update|pull)\s+)?(?:morning intel|morning report|inbox brief|inbox audit|github trending|outlier radar)(?: again)?[.!?]*$/.test(text))return outside();
 if(/^(?:(?:please|hey|okay|ok)\s+)*check (?:my |the )?inbox[.!?]*$/.test(text))return outside();
 if(/^(?:open|pull up|bring up|show)\s+(?:(?:me|my|the|today|today's)\s+)*(?:inbox|emails?|calendar|morning (?:intel|brief|briefing)|inbox brief|github trending|outlier radar)(?:\s+(?:report|on the right|on the left|in a new tab))?[.!?]*$/.test(text))return outside();
 if(actionable.test(text))return defer('requested-work');
 if(/^(?:(?:hey|please|okay|ok)\s+)*(?:(?:can|could|would) you(?: please)?\s+)?(?:update|upgrade)\b/.test(text))return defer('requested-update');
 // Reply as an imperative is work; "emails needing reply" is a saved category.
 if(/^(?:(?:hey|please|okay|ok)\s+)*(?:(?:can|could|would) you(?: please)?\s+)?(?:reply|respond|answer)\b/.test(text)||/[,;:]\s*(?:please\s+)?(?:reply|respond|answer)\b/.test(text)||/\b(?:did|have) you (?:reply|respond|send)\b/.test(text)||/\bwhat (?:should|can|could|would) (?:i|we|you) (?:reply|respond)\b/.test(text))return defer('requested-message-action');
 if(freshness.test(text)||negation.test(text)||compound.test(text))return defer('freshness-date-negation-or-compound');
 const savedFrame=/\b(?:saved|brief|briefing|intel|ranked|content plan|already|listed)\b/.test(text);
 if(/\b(?:inbox|emails?|mail|messages?)\b/.test(text)&&!savedFrame&&(/\b(?:latest|newest|new|arrived|arrivals|unread)\b/.test(text)||/\bcheck for\b/.test(text)))return defer('fresh-inbox-check');
 if(/\b(?:usage|quota|tokens?|allowance|subscribers?|subscribed|subscribing|subs|followers?|views?|likes?|comments?|earnings|revenue|billing|price|pricing)\b/.test(text)){
  // Clearly distinct dashboard counters must retain their dedicated path.
  if(!/\b(?:brief|briefing|intel|inbox|emails?|sources?|radar|outliers?|content plan)\b/.test(text))return outside();
  return defer('unsupported-metric-filter');
 }
 let matches=identify(text);
 const referential=/\b(?:second|third|fourth|fifth|next|another|those|that|them|\d+(?:st|nd|rd|th)|number (?:one|two|three|four|five|\d+))\b/.test(text);
 if(!matches.length&&prior&&referential)matches=[prior.section];
 if(!matches.length)return defer('unknown-section');
 if(matches.length!==1)return outside(true,'multiple-sections');
 const section=matches[0];let category;
 const ambiguous=reason=>({kind:'ambiguous',section,...(category?{category}:{}),reason});
 const inherited=!!prior&&referential&&section===prior.section;
 if(section==='inbox'){
  const categories=[/\b(?:urgent|operational|alerts?)\b/.test(text)&&'urgent',/\b(?:reply|replies|replying|respond|response|responses)\b|\b(?:need|needs|needing|require|requires) (?:an? )?answer\b/.test(text)&&'reply',/\b(?:sponsors?|sponsorships?)\b/.test(text)&&'sponsor'].filter(Boolean);
  if(categories.length>1)return outside(true,'multiple-inbox-filters');
  category=categories[0]||(inherited?prior.category:undefined)||'summary';
 }
 const sameList=inherited&&(section!=='inbox'||(prior.category||'summary')===category);
 // New recommendations need actual work; saved ranked suggestions are reads.
 if(section.startsWith('content-')&&/\b(?:new|original|fresh|brainstorm|come up with|suggest|recommend)\b/.test(text)&&!savedFrame)return outside(true,'new-content-recommendations');
 if(/\b(?:why|explain|meaning|means|detail|details|important|matter|matters|implications?|reason|reasons)\b/.test(text))return ambiguous('section-detail');
 if(section==='source-status'&&/\b(?:which|what|any|how many)\b/.test(text)&&/\b(?:failed|failing|missing|working|unhealthy|skipped|successful)\b/.test(text))return ambiguous('source-status-filter');
 const ordinal=Object.keys(ORDINAL).find(word=>new RegExp(`\\b${word}\\b`).test(text));
 const countMatch=/\b(?:top|first)\s+(one|two|three|four|five|\d+)\b/.exec(text);
 const numberMatch=/\bnumber\s+(one|two|three|four|five|\d+)\b/.exec(text);
 const next=/\b(?:next|another)\b/.test(text);
 if(next&&!sameList)return ambiguous('missing-previous-list');
 const offset=countMatch?0:ordinal?ORDINAL[ordinal]:numberMatch?(NUMBER[numberMatch[1]]||Number(numberMatch[1]))-1:next?(prior.offset||0)+(prior.count||3):0;
 const count=countMatch?(NUMBER[countMatch[1]]||Number(countMatch[1])):ordinal||numberMatch||next?1:/\b(?:top|best|leading|highest)\b/.test(text)&&!/\b(?:ideas|picks|items|entries|repos|videos|stories|headlines)\b/.test(text)?1:3;
 if(!Number.isInteger(count)||count<1||count>5||!Number.isInteger(offset)||offset<0||offset+count>5)return ambiguous('unsupported-count');
 const known=wordsFor(section),words=cleanWords(text);
 const unknown=words.filter(word=>!FILLER.has(word)&&!known.has(word)&&!(word in NUMBER)&&!(word in ORDINAL)&&!/^\d+$/.test(word));
 if(unknown.length)return ambiguous('unresolved-section-wording');
 // An unframed number is not silently interpreted as count, date or ranking.
 if(words.some(word=>/^\d+$/.test(word))&&!countMatch&&!numberMatch&&!ordinal)return ambiguous('unresolved-number');
 const explicitCount=!!(countMatch||ordinal||numberMatch||next)||count===1;
 return {kind:'lookup',section,...(category?{category}:{}),...(explicitCount?{count}:{}),offset,...(sameList?{date:prior.date,briefSource:prior.briefSource}:{})};
}
