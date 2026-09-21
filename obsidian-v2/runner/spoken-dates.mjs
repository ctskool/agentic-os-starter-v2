// Spoken date phrases for "open X from <when>" requests. Pure and testable:
// no filesystem, no model. Dates are calendar days in the vault's local zone,
// matching the YYYY-MM-DD prefixes every report and daily note already carries.

import {TIME_ZONE} from '../shared/timezone.mjs';
const DAYS=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const DAY_ALIASES={sun:0,sunday:0,mon:1,monday:1,tue:2,tues:2,tuesday:2,wed:3,weds:3,wednesday:3,thu:4,thur:4,thurs:4,thursday:4,fri:5,friday:5,sat:6,saturday:6};
const MONTH_ALIASES={jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12};
const SMALL={one:1,a:1,an:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,couple:2,few:3};
const DAY_PATTERN='sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?';
const MONTH_PATTERN='jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const LEAD='(?:\\b(?:from|for|on|of|dated|back on)\\s+)?';

export function localParts(now=new Date(),timeZone=TIME_ZONE){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'}).formatToParts(now).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
 const weekday=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday);
 return {year:Number(parts.year),month:Number(parts.month),day:Number(parts.day),weekday,iso:`${parts.year}-${parts.month}-${parts.day}`};
}
export const isoDate=(y,m,d)=>`${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
export function shiftIso(iso,days){const [y,m,d]=iso.split('-').map(Number);const t=new Date(Date.UTC(y,m-1,d+days));return isoDate(t.getUTCFullYear(),t.getUTCMonth()+1,t.getUTCDate())}
export function weekdayOf(iso){const [y,m,d]=iso.split('-').map(Number);return new Date(Date.UTC(y,m-1,d)).getUTCDay()}
export function describeDate(iso,today){
 if(!iso)return '';
 if(iso===today)return 'today';
 if(iso===shiftIso(today,-1))return 'yesterday';
 const [y,m,d]=iso.split('-').map(Number),date=new Date(Date.UTC(y,m-1,d));
 const text=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'long',month:'long',day:'numeric'}).format(date);
 return y===Number(today.slice(0,4))?text:`${text}, ${y}`;
}
const validDay=(y,m,d)=>m>=1&&m<=12&&d>=1&&d<=new Date(Date.UTC(y,m,0)).getUTCDate();
const number=value=>{if(value===undefined)return null;const n=Number(value);return Number.isFinite(n)?n:SMALL[value]??null};

// Returns null when no date phrase is present. Otherwise a day or a range plus
// the utterance with that phrase removed, so the remaining words name the target.
export function parseSpokenDate(text,{now=new Date(),timeZone=TIME_ZONE}={}){
 const today=localParts(now,timeZone),source=String(text||'').normalize('NFKC').replace(/[’‘]/g,"'");
 const lower=source.toLowerCase();
 const found=(kind,match,value)=>({kind,...value,matched:match[0].trim(),rest:(lower.slice(0,match.index)+' '+lower.slice(match.index+match[0].length)).replace(/\s+/g,' ').trim()});
 const day=(match,iso)=>found('day',match,{date:iso,label:describeDate(iso,today.iso)});
 let m;
 if((m=new RegExp(`${LEAD}\\b(?:this morning(?:'s)?|today(?:'s)?|todays|earlier today|tonight)\\b`).exec(lower)))return day(m,today.iso);
 if((m=new RegExp(`${LEAD}\\b(?:the\\s+)?day before yesterday(?:'s)?\\b`).exec(lower)))return day(m,shiftIso(today.iso,-2));
 if((m=new RegExp(`${LEAD}\\byesterday(?:'s)?(?:\\s+morning)?\\b`).exec(lower)))return day(m,shiftIso(today.iso,-1));
 if((m=new RegExp(`${LEAD}\\btomorrow(?:'s)?\\b`).exec(lower)))return day(m,shiftIso(today.iso,1));
 if((m=new RegExp(`${LEAD}\\b(\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|a|an|couple(?: of)?|few)\\s+days?\\s+(?:ago|back)\\b`).exec(lower))){const n=number(m[1].replace(/ of$/,''));if(n!==null)return day(m,shiftIso(today.iso,-n))}
 if((m=new RegExp(`${LEAD}\\b(\\d{1,2}|one|two|three|four|a|an|couple(?: of)?|few)\\s+weeks?\\s+(?:ago|back)\\b`).exec(lower))){const n=number(m[1].replace(/ of$/,''));if(n!==null)return day(m,shiftIso(today.iso,-7*n))}
 if((m=new RegExp(`${LEAD}\\b(last|this|past)\\s+week(?:'s)?\\b`).exec(lower))){
  const monday=shiftIso(today.iso,-((today.weekday+6)%7));
  if(m[1]==='this')return found('range',m,{from:monday,to:today.iso,label:'this week'});
  return found('range',m,{from:shiftIso(monday,-7),to:shiftIso(monday,-1),label:'last week'});
 }
 if((m=new RegExp(`${LEAD}\\b(?:(last|this|past)\\s+)?(${DAY_PATTERN})(?:'s)?\\b(?:\\s+morning)?`).exec(lower))){
  const target=DAY_ALIASES[m[2]];
  if(target!==undefined){
   let back=(today.weekday-target+7)%7;
   if(m[1]==='last'&&back===0)back=7;
   return day(m,shiftIso(today.iso,-back));
  }
 }
 if((m=new RegExp(`${LEAD}\\b(\\d{4})-(\\d{2})-(\\d{2})\\b`).exec(lower))){const [y,mo,d]=[m[1],m[2],m[3]].map(Number);if(validDay(y,mo,d))return day(m,isoDate(y,mo,d))}
 if((m=new RegExp(`${LEAD}\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`).exec(lower))||(m=new RegExp(`${LEAD}\\b(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_PATTERN})\\b(?:,?\\s+(\\d{4}))?`).exec(lower))){
  const monthWord=MONTH_ALIASES[m[1]]?m[1]:m[2],dayWord=MONTH_ALIASES[m[1]]?m[2]:m[1],year=m[3];
  const mo=MONTH_ALIASES[monthWord],d=Number(dayWord);
  if(mo&&validDay(year?Number(year):today.year,mo,d)){
   let y=year?Number(year):today.year;
   if(!year&&isoDate(y,mo,d)>today.iso)y-=1;
   return day(m,isoDate(y,mo,d));
  }
 }
 if((m=new RegExp(`${LEAD}\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\b`).exec(lower))){
  const mo=Number(m[1]),d=Number(m[2]);let y=m[3]?Number(m[3].length===2?'20'+m[3]:m[3]):today.year;
  if(validDay(y,mo,d)){if(!m[3]&&isoDate(y,mo,d)>today.iso)y-=1;return day(m,isoDate(y,mo,d))}
 }
 if((m=new RegExp(`${LEAD}\\bthe\\s+(\\d{1,2})(?:st|nd|rd|th)\\b`).exec(lower))){
  const d=Number(m[1]);let y=today.year,mo=today.month;
  if(d>today.day){mo-=1;if(mo<1){mo=12;y-=1}}
  if(validDay(y,mo,d))return day(m,isoDate(y,mo,d));
 }
 return null;
}
export const dayNames=DAYS;
