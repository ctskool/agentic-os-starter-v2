import fs from 'node:fs';
import {vaultPath} from './core.mjs';
import {localDate} from './brief-voice.mjs';
import {TIME_ZONE} from '../shared/timezone.mjs';

// On a call, a question about the calendar that the saved notes can't answer becomes a quick read of the calendar
// itself, by a worker that has the Google Calendar connector, instead of a reply that can only offer Plan Tomorrow.
// (2026-11-26: "do I have anything on my schedule for tomorrow?" got "my snapshot only has today's calendar".)
// Only questions qualify: adding, moving or cancelling events, and opening the calendar, go their usual way.

const CHANGE=/^(?:(?:hey|ok(?:ay)?|so|um|uh|jarvis|please|actually)[,\s]+)*(?:(?:can|could|would|will) you\s+|please\s+|go ahead and\s+)?(?:add|put|book|move|cancel|delete|remove|reschedule|create|set up|invite|block(?: off)?|schedule|clear|make|open|pull up|bring up|show me my calendar\b)/i;
const ASKS=/\b(?:what(?:'s| is| do| does| have)?|whats|do i|does|did i|am i|is there|are there|any(?:thing)?|when|how (?:busy|much|many)|check|look(?: at)?|see if|tell me|walk me through|run me through)\b|\?/i;
// "Any AI events this week?" is news, and "is that tool free?" is about price: only the user's own events count.
const NAMED=/\b(?:calendar|meetings?|appointments?|my events)\b/i;
const DAYS='today|tonight|tomorrow|this|next|later|monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const LOOSE=new RegExp(`\\b(?:my schedule|on the schedule|my plans|schedule (?:for |on )?(?:${DAYS})|(?:am i|are we|i'm|i am) (?:\\w+ ){0,2}(?:free|busy|booked))\\b`,'i');
const OTHER_DAY=/\b(?:tomorrow|yesterday|tonight|this (?:week|weekend)|next (?:week|weekend|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:on |this )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|the (?:\d{1,2}|first|second|third|\w+teenth|twentieth|thirtieth)(?:st|nd|rd|th)?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}|later this week|rest of the week|over the weekend)\b/i;

export function calendarQuestion(transcript){
 const text=String(transcript||'').replace(/[’]/g,"'").replace(/\s+/g,' ').trim();
 if(!text||text.split(' ').length>30||CHANGE.test(text)||!ASKS.test(text))return null;
 if(NAMED.test(text))return {named:true,otherDay:OTHER_DAY.test(text)};
 if(LOOSE.test(text))return {named:false,otherDay:OTHER_DAY.test(text)};
 return null;
}

// Today's own note answers "what's on my schedule today" at once; anything it can't answer goes to the calendar.
function todayHasSchedule(root,now){
 try{
  const text=fs.readFileSync(vaultPath(root,`daily-notes/${localDate(now)}.md`),'utf8');
  const section=/^## Schedule[^\r\n]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1]||'';
  return /^\s*-\s+\S/m.test(section);
 }catch{return false}
}

export function calendarCheck(root,transcript,{now=new Date()}={}){
 const question=calendarQuestion(transcript);
 if(!question)return null;
 if(!question.named&&!question.otherDay&&todayHasSchedule(root,now))return null;
 const today=now.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:TIME_ZONE});
 const prompt=`Check the user's Google Calendar and answer this question from a live voice call: "${String(transcript).trim()}"

Today is ${today} (${TIME_ZONE}). Use the connected Google Calendar tools (in Claude Code, load them with tool search; their names contain Google_Calendar). Only read: do not create, change or delete events, and do not write any files.

Answer in one or two short sentences that will be read aloud: all-day items first, then times in plain words ("ten a.m."), and say so plainly if the day is empty. If the calendar can't be read, say that in one sentence.`;
 return {prompt,title:'Calendar check'};
}
