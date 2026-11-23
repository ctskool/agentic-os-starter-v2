import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const namePattern=/^[a-z0-9][a-z0-9-]{0,63}$/;
const invoke="(?:(?:can(?:['’]t)?|could|would|will) you\\s+)?(?:please\\s+)?(?:run|start|execute|invoke|use|do)\\s+(?:the\\s+)?";
const spokenPrefix=new RegExp('^(?:'+invoke+')?slash(?: (?:command|skill))?\\s+','i');
const spokenSuffix=new RegExp('^'+invoke+'([a-z0-9][a-z0-9 -]{0,63}?)\\s+slash\\s+(?:command|skill|thing)\\b','i');
const spokenAside=new RegExp('^'+invoke+'(?:[^.!?\\n,]+,)+\\s*(?:the\\s+)?slash\\s+','i');
const literal=new RegExp('^(?:'+invoke+')?/([a-z0-9][a-z0-9-]{0,63})(?=\\s|[.!?,]*$)','i');
const argumentLead=/^(?:for|with|on|in|about|using|from|to|at)$/i;
const disfluency=/(?<!\S)(?:(?:umm?|uhh?|erm|hmm)(?=\s|,|$)\s*,?|(?:like|you know|so|okay|ok|hey|jarvis)\s*,)/gi;
const trailingCourtesy=/(?:(?:^|[\s,]+)(?:for me|please|real quick|now|thing))+[,.!?]*$/i;
const cleanArgs=text=>text.trim().replace(trailingCourtesy,'').trimEnd();
const exists=file=>{try{return fs.statSync(file).isFile()}catch{return false}};

export function skillExists(provider,root,name,{home=os.homedir(),codexHome=process.env.CODEX_HOME}={}){
 if(!namePattern.test(name))return false;
 const claudeDirs=[path.join(root,'.claude'),path.join(home,'.claude')];
 const codexDir=codexHome||path.join(home,'.codex');
 const files=provider==='claude'?claudeDirs.flatMap(dir=>[
  path.join(dir,'skills',name,'SKILL.md'),path.join(dir,'commands',name+'.md')
 ]):[
  path.join(codexDir,'skills',name,'SKILL.md'),path.join(home,'.agents','skills',name,'SKILL.md'),path.join(codexDir,'prompts',name+'.md')
 ];
 return files.some(exists);
}

export function spokenSlashSkill(text,{hasSkill}){
 text=text.replace(disfluency,' ').replace(/\s+/g,' ').trim().replace(/^please(?:,\s*|\s+)/i,'');
 const exact=literal.exec(text);
 const suffix=spokenSuffix.exec(text);
 const prefix=spokenPrefix.exec(text)||spokenAside.exec(text);
 if(!exact&&!suffix&&!prefix)return null;
 if(exact){
  const name=exact[1].toLowerCase(),args=cleanArgs(text.slice(exact[0].length).replace(/^[.!?]+$/,''));
  return {name,args,found:hasSkill(name)};
 }
 const tail=text.slice((suffix||prefix)[0].length).replace(/^[,\s]+/,'').trim();
 const input=suffix?suffix[1]:tail;
 const parts=[];
 let nameChars=0;
 for(const match of input.matchAll(/(?:^|\s+)([a-z0-9][a-z0-9-]*)(?=\s|[,.!?]*$)/gi)){
  if(match.index!==(parts.at(-1)?.end??0)||!namePattern.test(match[1])||parts.length&&argumentLead.test(match[1]))break;
  nameChars+=match[1].length;
  if(nameChars>64)break;
  parts.push({word:match[1].toLowerCase(),end:match.index+match[0].length});
 }
 if(!parts.length)return null;
 const argsAt=end=>cleanArgs(suffix?tail.replace(/^[.!?]+$/,''):tail.slice(end).replace(/^\s*,\s*/,'').replace(/^\s+(?:slash\s+)?(?:command|skill|thing)\b/i,'').replace(/^[.!?]+$/,''));
 for(let length=parts.length;length>0;length--){
  if(suffix&&length!==parts.length)break;
  for(const separator of length===1?['']:['-','']){
   const name=parts.slice(0,length).map(part=>part.word).join(separator);
   if(namePattern.test(name)&&hasSkill(name))return {name,args:argsAt(parts[length-1].end),found:true};
  }
 }
 const firstArg=argsAt(parts[0].end).split(/\s+/)[0];
 if(!suffix&&/^slash\s+/i.test(prefix[0])&&!/^slash (?:command|skill)\s+/i.test(prefix[0])&&parts.length>1&&firstArg&&!argumentLead.test(firstArg))return null;
 const name=suffix?parts.map(part=>part.word).join('-'):parts[0].word;
 return {name,args:argsAt(parts[0].end),found:false};
}
