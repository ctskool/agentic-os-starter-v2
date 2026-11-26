// Today's and tomorrow's calendar, read in the background so a Live call starts already knowing them
// (Chase, 2026-11-26: "the calendar … should be automatically loaded with that day's events and the next day's").
//
// Only a Claude or Codex worker can read Google Calendar (its connector lives in the CLI), and that takes about
// fifteen seconds, longer than a call can wait before it opens. So a short worker reads both days about once an
// hour from 7 a.m. to 10 p.m. while the services run, and saves them to system/v2/calendar.json. A call reads that
// file at once and says how old it is; "check my calendar" still reads it fresh (calendar-check.mjs).
//
// It runs only for members who use Live (an OpenAI key is set up) and who leave the Calendar section on
// (`node aos.mjs live-context section calendar off` stops both the reading and the sending).
import fs from 'node:fs';
import crypto from 'node:crypto';
import {ROOT} from '../shared/contract.mjs';
import {TIME_ZONE} from '../shared/timezone.mjs';
import {vaultPath,writeJson} from './core.mjs';
import {localDate} from './brief-voice.mjs';

export const CALENDAR_FILE=`${ROOT}/calendar.json`;
export const CALENDAR_REFRESH_MS=60*60*1000;
export const CALENDAR_HOURS=Object.freeze({from:7,to:22});
const MAX_EVENTS=40,MAX_TITLE=120,TIME=/^(?:[01]\d|2[0-3]):[0-5]\d$/;

const dayAfter=date=>{const [y,m,d]=date.split('-').map(Number);return localDate(new Date(y,m-1,d+1,12))};
const spokenDay=date=>{const [y,m,d]=date.split('-').map(Number);return new Date(y,m-1,d,12).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})};

export function readCalendarSnapshot(root){
 try{
  const file=vaultPath(root,CALENDAR_FILE),info=fs.statSync(file,{throwIfNoEntry:false});
  if(!info?.isFile()||info.size>200000)return null;
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  return data&&typeof data==='object'&&!Array.isArray(data)?data:null;
 }catch{return null}
}

// The worker's answer is data. Keep only well-formed days and events, and never more than a call needs.
export function cleanCalendarDays(value,dates){
 const days=Array.isArray(value?.days)?value.days:null;
 if(!days)throw new Error('The calendar answer had no days.');
 return dates.map(date=>{
  const day=days.find(item=>item?.date===date);
  if(!day||!Array.isArray(day.events))throw new Error(`The calendar answer did not cover ${date}.`);
  const events=day.events.slice(0,MAX_EVENTS).map(event=>{
   const title=String(event?.title??'').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,MAX_TITLE)||'(no title)';
   const allDay=event?.allDay===true||!TIME.test(String(event?.start??''));
   return allDay?{allDay:true,title}:{allDay:false,start:event.start,...(TIME.test(String(event?.end??''))?{end:event.end}:{}),title};
  }).sort((a,b)=>a.allDay===b.allDay?String(a.start||'').localeCompare(String(b.start||'')):a.allDay?-1:1);
  return {date,events};
 });
}
function firstJson(text){
 const source=String(text||''),start=source.indexOf('{'),end=source.lastIndexOf('}');
 if(start<0||end<start)throw new Error('The calendar answer was not JSON.');
 return JSON.parse(source.slice(start,end+1));
}

export function calendarPrompt(dates,timeZone=TIME_ZONE){
 return `Read the user's Google Calendar for two days in ${timeZone}: ${dates[0]} (today, ${spokenDay(dates[0])}) and ${dates[1]} (tomorrow, ${spokenDay(dates[1])}).
Use the connected Google Calendar tools (in Claude Code, load them with tool search; their names contain Google_Calendar). Read the user's own calendars, not holiday or other subscribed ones. Only read: do not create, change or delete events, and do not write any files.

Return status "ok", a one-line summary, and as markdown ONLY this JSON, with nothing before or after it:
{"days":[{"date":"${dates[0]}","events":[{"start":"HH:MM","end":"HH:MM","allDay":false,"title":"..."}]},{"date":"${dates[1]}","events":[]}]}
Times are 24-hour local times. For an all-day event use {"allDay":true,"title":"..."}. An empty day has "events":[]. Titles exactly as on the calendar.
If the calendar can't be read, return status "blocked" and say why in the summary.`;
}

// One read. `execute` is the adapter's executeCli; `job` names the provider and model it runs with.
export async function refreshCalendar(root,{execute,provider,model,now=new Date(),signal,timeoutMs=180000}={}){
 const dates=[localDate(now),dayAfter(localDate(now))];
 const previous=readCalendarSnapshot(root)||{};
 const attempt=now.toISOString();
 try{
  const result=await execute(root,{id:crypto.randomUUID(),provider,model,skill:'calendar-snapshot',ts:attempt},calendarPrompt(dates),{signal,timeoutMs});
  if(result?.status==='blocked')throw new Error(String(result.summary||'The calendar could not be read.').slice(0,300));
  const days=cleanCalendarDays(firstJson(result?.text),dates);
  const saved={version:1,fetchedAt:attempt,provider,timeZone:TIME_ZONE,days,lastAttemptAt:attempt,error:null};
  writeJson(root,CALENDAR_FILE,saved);
  return saved;
 }catch(error){
  // Keep the last good reading; record the failure so the next try waits its hour instead of retrying at once.
  const saved={...previous,version:1,lastAttemptAt:attempt,error:String(error?.message||error).slice(0,300)};
  try{writeJson(root,CALENDAR_FILE,saved)}catch{}
  throw error;
 }
}

// Whether the clock says it's time: inside the hours, and the last attempt is an hour old or from another day.
export function calendarDue(snapshot,now=new Date()){
 const hour=now.getHours();
 if(hour<CALENDAR_HOURS.from||hour>=CALENDAR_HOURS.to)return false;
 const last=Date.parse(snapshot?.lastAttemptAt||snapshot?.fetchedAt||'');
 if(!Number.isFinite(last))return true;
 return localDate(new Date(last))!==localDate(now)||now-last>=CALENDAR_REFRESH_MS;
}

const clock=time=>{const [h,m]=time.split(':').map(Number);const hour=h%12||12;return `${hour}${m?':'+String(m).padStart(2,'0'):''} ${h<12?'a.m.':'p.m.'}`};
// The lines a call starts with. Days already past are dropped; a reading from before yesterday is not used.
export function calendarLines(snapshot,now=new Date()){
 const fetched=Date.parse(snapshot?.fetchedAt||'');
 if(!Number.isFinite(fetched)||!Array.isArray(snapshot?.days))return null;
 const today=localDate(now),tomorrow=dayAfter(today);
 const days=snapshot.days.filter(day=>day?.date===today||day?.date===tomorrow);
 if(!days.length)return null;
 const read=new Date(fetched),when=localDate(read)===today?read.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):`${spokenDay(localDate(read))}, ${read.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}`;
 const lines=days.map(day=>{
  const name=day.date===today?'Today':'Tomorrow';
  const items=(day.events||[]).map(event=>event.allDay?`all day: ${event.title}`:`${clock(event.start)}${event.end?' to '+clock(event.end):''}: ${event.title}`);
  return `${name} (${spokenDay(day.date)}): ${items.length?items.join('; '):'nothing on the calendar'}`;
 });
 if(!days.some(day=>day.date===tomorrow))lines.push('Tomorrow: not read yet.');
 return {when,lines};
}
