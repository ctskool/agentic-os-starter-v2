// Saved Markdown is data. This parser never runs instructions, resolves links,
// or reads any other document. Section boundaries protect adjacent private data.
const definitions={
 inbox:{label:'Inbox',parent:/^inbox(?:\b|\s*\()/i},
 'ai-claude':{label:'Claude and Anthropic news',parent:/^ai news\b/i,child:/^(?:anthropic|claude)\b/i},
 'ai-codex':{label:'Codex and OpenAI news',parent:/^ai news\b/i,child:/^(?:openai|codex)\b/i},
 'ai-other':{label:'Other AI news',parent:/^ai news\b/i,child:/^(?:everyone else|other(?:s| ai)?(?: news)?)\b/i},
 youtube:{label:'YouTube radar',parent:/^youtube radar\b/i,ownBody:true},
 outliers:{label:'Small-channel outliers',parent:/^youtube radar\b/i,child:/^(?:small[- ]channel )?outliers\b/i},
 github:{label:'GitHub radar',parent:/^github (?:radar|trending)\b/i},
 'content-youtube':{label:'YouTube content plan',parent:/^(?:so what\b.*content plan|content plan\b)/i,child:/^youtube\b/i},
 'content-linkedin':{label:'LinkedIn content plan',parent:/^(?:so what\b.*content plan|content plan\b)/i,child:/^linkedin\b/i},
 'content-shorts':{label:'Shorts and carousels content plan',parent:/^(?:so what\b.*content plan|content plan\b)/i,child:/^(?:shorts?|carousels?)\b/i},
 'source-status':{label:'Source status',parent:/^source status\b/i},
};
export const BRIEF_SECTION_IDS=Object.freeze(Object.keys(definitions));
const MAX_ITEMS=24,MAX_ITEM=1000,MAX_TEXT=4500;
export function briefSectionLabel(id){return definitions[id]?.label||null;}
export function validBriefSectionRequest(request){return request&&BRIEF_SECTION_IDS.includes(request.section)&&(request.category===undefined||request.section==='inbox'&&['urgent','reply','sponsor','summary'].includes(request.category))&&(request.count===undefined||Number.isInteger(request.count)&&request.count>=1&&request.count<=5)&&(request.offset===undefined||Number.isInteger(request.offset)&&request.offset>=0&&request.offset<=4)&&(request.count??1)+(request.offset??0)<=5;}
function speak(value){return String(value||'').replace(/<!--[^]*?-->/g,'').replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/https?:\/\/\S+/g,'').replace(/[*_`#]/g,'').replace(/^\s*>\s?/gm,'').replace(/\s+/g,' ').trim();}
function shorten(text,limit){return text.length>limit?text.slice(0,limit-1).replace(/\s+\S*$/,'')+'…':text;}
function consumeFence(line,current){
 const match=/^\s*(`{3,}|~{3,})(.*)$/.exec(line);
 if(!match)return {fence:current,skip:Boolean(current)};
 if(!current)return {fence:{character:match[1][0],length:match[1].length},skip:true};
 const closes=match[1][0]===current.character&&match[1].length>=current.length&&!match[2].trim();
 return {fence:closes?null:current,skip:true};
}
function nodesFor(raw){
 const lines=raw.replace(/\r\n/g,'\n').replace(/<!--[^]*?-->/g,'').split('\n'),nodes=[],stack=[];
 let fence=null;
 for(let i=0;i<lines.length;i++){
  const state=consumeFence(lines[i],fence);fence=state.fence;if(state.skip)continue;
  const match=/^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);if(!match)continue;
  const level=match[1].length;while(stack.length&&stack.at(-1).level>=level)stack.pop().end=i;
  const node={title:speak(match[2]),level,start:i+1,end:lines.length,parent:stack.at(-1)||null};nodes.push(node);stack.push(node);
 }
 return {lines,nodes};
}
function inboxCategory(label){
 const text=speak(label).toLowerCase().replace(/needsreply/g,'needs reply').replace(/[^a-z\s]/g,' ').replace(/\s+/g,' ').trim();
 if(/^(?:needs? (?:a )?repl(?:y|ies)|reply needed|reply required|replies needed|respond|response required|awaiting (?:my |your )?reply)(?: (?:items?|emails?|messages?|threads?))?$/.test(text))return 'reply';
 if(/^(?:sponsors?|sponsorships?)(?: (?:pitches|opportunities|items|emails|messages|threads|requests|leads))?$/.test(text))return 'sponsor';
 if(/^urgent(?: (?:items|emails|messages|threads|alerts|priority))?$/.test(text))return 'urgent';
 if(/^(?:summary|overview|fyi|informational|ignore(?: tier)?|other|routine)(?:\b|$)/.test(text))return 'summary';
 return null;
}
function inboxItemCategories(text,category,label=''){
 const categories=new Set(category?[category]:[]);
 const negativeReply=/\b(?:no|not|never|without)\b[^.!?]{0,35}\b(?:reply|response|respond)\b|\b(?:reply|response)\b[^.!?]{0,15}\b(?:not needed|not required|unnecessary)\b|\b(?:thread|conversation|request)\s+(?:is\s+)?(?:already\s+)?closed\b/i.test(text);
 if(negativeReply)categories.delete('reply');else if(/\b(?:needs? (?:a )?reply|reply (?:needed|required)|worth (?:a )?reply|requires? (?:a )?response)\b/i.test(text))categories.add('reply');
 const negativeSponsor=/\b(?:no|not|never)\b[^.!?]{0,20}\b(?:sponsors?|sponsorships?)\b|\bignore\b[^.!?]{0,35}\b(?:sponsors?|sponsorships?|pitches)\b|\b(?:sponsor|sponsorship)\s+spam\b/i.test(text)||/^\W*ignore\b/i.test(label);
 if(negativeSponsor)categories.delete('sponsor');else if(/\b(?:sponsors?|sponsorships?)\b/i.test(text))categories.add('sponsor');
 const negativeUrgent=/\b(?:not|no|never)\b[^.!?]{0,20}\burgent\b|\burgent\s*[?:—–-]?\s*(?:no|not)\b/i.test(text);
 if(negativeUrgent)categories.delete('urgent');else if(/\burgent\b/i.test(text))categories.add('urgent');
 return [...categories];
}
function parseItems(body,{inbox=false}={}){
 const lines=body.split('\n'),items=[];let current=null,category=null,categoryLabel=null,malformed=false,truncated=false,table=null,fence=null;
 const flush=()=>{if(!current)return;const text=speak(current.parts.join(' '));if(text){if(items.length<MAX_ITEMS){const categories=inbox?inboxItemCategories(text,current.category,current.categoryLabel):[],itemCategory=inbox?categories[0]:current.category;if(text.length>MAX_ITEM)truncated=true;items.push({text:shorten(text,MAX_ITEM),...(itemCategory?{category:itemCategory}:{}),...(categories.length>1?{categories}:{}),...(current.categoryLabel?{categoryLabel:current.categoryLabel}:{}),...(current.rank?{rank:current.rank}:{})});}else truncated=true;}current=null;};
 const begin=(text,rank=null)=>{flush();current={parts:[text],category,categoryLabel,rank};};
 const setLabel=label=>{flush();categoryLabel=shorten(speak(label).replace(/:$/,''),100);category=inbox?inboxCategory(label):null;};
 for(let index=0;index<lines.length;index++){
  const line=lines[index],trim=line.trim();
  const state=consumeFence(line,fence);fence=state.fence;if(state.skip)continue;
  if(!trim){if(table)table=null;continue;}
  if(/^[-*_]{3,}$/.test(trim)){flush();table=null;continue;}
  const heading=/^#{1,6}\s+(.+)$/.exec(trim);if(heading){table=null;setLabel(heading[1]);continue;}
  if(trim.startsWith('|')){
   flush();const cells=trim.replace(/^\||\|$/g,'').split(/(?<!\\)\|/).map(cell=>speak(cell.trim().replace(/\\\|/g,'|')));
   if(!table){table={headers:cells,separator:false};continue;}
   if(cells.every(cell=>/^:?-{3,}:?$/.test(cell))){if(cells.length!==table.headers.length)malformed=true;table.separator=true;continue;}
   if(!table.separator||cells.length!==table.headers.length||cells.every(cell=>!cell)){malformed=true;continue;}
   const text=cells.map((cell,i)=>i?`${table.headers[i]}: ${cell}`:cell).join('; ');let itemCategory=category,itemLabel=categoryLabel;
   if(inbox){const column=table.headers.findIndex(h=>/^(?:category|priority|triage|type)$/i.test(h));if(column>=0){itemLabel=cells[column];itemCategory=inboxCategory(itemLabel);}}
   const categories=inbox?inboxItemCategories(text,itemCategory,itemLabel):[];if(inbox)itemCategory=categories[0];
   if(text.length>MAX_ITEM)truncated=true;
   if(items.length<MAX_ITEMS)items.push({text:shorten(text,MAX_ITEM),...(itemCategory?{category:itemCategory}:{}),...(categories.length>1?{categories}:{}),...(itemLabel?{categoryLabel:itemLabel}:{})});else truncated=true;
   continue;
  }
  if(table){if(!table.separator)malformed=true;table=null;}
  const stripped=trim.replace(/^\*\*(.*?)(?:\*\*)/, '$1');
  const ranked=/^(\d{1,2})[.)]\s+(.+)$/.exec(stripped),bullet=/^([-*+])\s+(.+)$/.exec(trim);
  if(ranked&&/^\S/.test(line)){begin(ranked[2],Number(ranked[1]));continue;}
  if(bullet&&/^\S/.test(line)){begin(bullet[2]);continue;}
  const boldLabel=/^\*\*([^*]+?)\*\*\s*$/.exec(trim);
  if(boldLabel&&boldLabel[1].length<120){setLabel(boldLabel[1]);continue;}
  const inlineBold=/^\*\*([^*]{1,120})\*\*\s+(.+)$/.exec(trim);
  if(inlineBold&&(inbox&&inboxCategory(inlineBold[1])||/:$/.test(inlineBold[1]))){setLabel(inlineBold[1]);begin(inlineBold[2]);continue;}
  // An inline explicit triage label remains associated with its own content.
  const explicitLabel=inbox?/^(?:\*\*)?([^:]{1,65}):(?:\*\*)?\s*(.+)$/.exec(trim):null;
  if(explicitLabel&&inboxCategory(explicitLabel[1])){setLabel(explicitLabel[1]);begin(explicitLabel[2]);continue;}
  if(!current)begin(trim);else current.parts.push(trim);
 }
 if(table&&!table.separator)malformed=true;flush();
 return {items,malformed,truncated};
}
export function parseBriefSections(raw){
 const {lines,nodes}=nodesFor(raw),result={};
 for(const [id,def] of Object.entries(definitions)){
  const empty=status=>({label:def.label,status,items:[],text:'',ordered:false,truncated:false});
  const parents=nodes.filter(n=>n.level===2&&def.parent.test(n.title));
  if(!parents.length){result[id]=empty('missing');continue;}
  if(parents.length!==1){result[id]=empty('malformed');continue;}
  const parent=parents[0],matches=def.child?nodes.filter(n=>n.parent===parent&&def.child.test(n.title)):[parent];
  if(!matches.length){result[id]=empty('missing');continue;}
  if(matches.length!==1){result[id]=empty('malformed');continue;}
  const node=matches[0],end=def.ownBody?(nodes.find(n=>n.parent===node)?.start-1||node.end):node.end;
  const body=lines.slice(node.start,end).join('\n');
  if(body.length>64000){result[id]=empty('malformed');continue;}
  const parsed=parseItems(body,{inbox:id==='inbox'});
  if(parsed.malformed){result[id]=empty('malformed');continue;}
  const ordered=parsed.items.length>0&&parsed.items.every((item,index)=>item.rank===index+1);
  const text=parsed.items.map(i=>`${i.categoryLabel?i.categoryLabel+': ':''}${i.text}`).join('\n');
  result[id]={label:def.label,status:parsed.items.length?'available':'empty',items:parsed.items,text:shorten(text,MAX_TEXT),ordered,truncated:parsed.truncated||text.length>MAX_TEXT};
 }
 return result;
}
export function briefSectionAnswer(section,request){
 const category=request.category;
 if(section.status!=='available')return {reply:`Today's saved morning brief ${section.status==='malformed'?'does not have a readable':section.status==='empty'?'has an empty':'does not include a'} ${section.label} section.`,count:0};
 let items=section.items;
 if(request.section==='inbox'&&category&&category!=='summary'){
  items=items.filter(i=>i.category===category||i.categories?.includes(category));
  if(!items.length)return {reply:`Today's saved morning brief does not explicitly label any ${category==='reply'?'needs-reply':category} items. I can't tell from this saved section whether there are none.`,count:0};
 }else if(request.section==='inbox'){
  // Overview preserves the report's named groups instead of reading three
  // entries from the first category and hiding the other categories entirely.
  const grouped=new Map();for(const item of items){const label=item.categoryLabel||'Inbox summary';if(!grouped.has(label))grouped.set(label,[]);grouped.get(label).push(item);}
  items=[...grouped].map(([label,group])=>({text:`${label}: ${group.map(i=>i.text).join(' ')}`}));
 }
 const offset=request.offset||0,count=request.count??Math.min(3,Math.max(0,items.length-offset),5-offset),selected=items.slice(offset,offset+count);
 if(!selected.length||request.count!==undefined&&selected.length<count)return {reply:`Today's saved ${section.label} section does not include ${request.count>1?'that many entries':'that numbered entry'}.`,count:0};
 const prefix=`From today's saved morning brief, ${section.label}${category&&category!=='summary'?' — '+(category==='reply'?'needs reply':category):''}: `;
 const limit=Math.floor((840-prefix.length)/selected.length)-5;
 return {reply:prefix+selected.map((item,index)=>`${offset+index+1}. ${shorten(item.text,limit)}`).join('; ')+'.',count:selected.length};
}
export function sectionReply(section,request){return briefSectionAnswer(section,request).reply;}
