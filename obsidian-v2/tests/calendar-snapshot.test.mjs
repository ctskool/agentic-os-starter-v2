import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {cleanCalendarDays,calendarDue,calendarLines,refreshCalendar,readCalendarSnapshot,calendarPrompt,CALENDAR_FILE} from '../runner/calendar-snapshot.mjs';
import {localDate} from '../runner/brief-voice.mjs';

const at=(h,m=0,day=26)=>new Date(2026,10,day,h,m);
const vault=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'calendar-snapshot-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root};

test('the worker’s answer is kept only as clean days and events, all-day items first', () => {
 const days=cleanCalendarDays({days:[
  {date:'2026-11-27',events:[{start:'16:00',end:'16:15',title:'Skool Email'},{allDay:true,title:'Black Friday'}]},
  {date:'2026-11-26',events:[{start:'25:00',title:'Odd time'},{start:'09:00',title:'  Record\n video  '},{title:''}]},
 ]},['2026-11-26','2026-11-27']);
 assert.deepEqual(days,[
  {date:'2026-11-26',events:[{allDay:true,title:'Odd time'},{allDay:true,title:'(no title)'},{allDay:false,start:'09:00',title:'Record video'}]},
  {date:'2026-11-27',events:[{allDay:true,title:'Black Friday'},{allDay:false,start:'16:00',end:'16:15',title:'Skool Email'}]},
 ]);
 assert.throws(()=>cleanCalendarDays({days:[{date:'2026-11-26',events:[]}]},['2026-11-26','2026-11-27']),/did not cover 2026-11-27/);
 assert.throws(()=>cleanCalendarDays({},['2026-11-26']),/no days/);
});

test('a read is due once an hour between 7 a.m. and 10 p.m., and again on a new day', () => {
 assert.equal(calendarDue(null,at(6,59)),false);
 assert.equal(calendarDue(null,at(7)),true);
 assert.equal(calendarDue(null,at(22)),false);
 const read={lastAttemptAt:at(9).toISOString()};
 assert.equal(calendarDue(read,at(9,59)),false);
 assert.equal(calendarDue(read,at(10)),true);
 assert.equal(calendarDue({lastAttemptAt:at(21,30,25).toISOString()},at(7,5)),true,'yesterday evening’s read is redone in the morning');
});

test('a call reads today and tomorrow in words, drops days already past, and says when it was read', () => {
 const snapshot={fetchedAt:at(14,10).toISOString(),days:[
  {date:'2026-11-26',events:[{allDay:false,start:'09:00',end:'10:30',title:'Record'}]},
  {date:'2026-11-27',events:[{allDay:true,title:'Black Friday'},{allDay:false,start:'16:00',end:'16:15',title:'Skool Email'}]},
 ]};
 const same=calendarLines(snapshot,at(15));
 assert.match(same.when,/^2:10\sPM$/);
 assert.deepEqual(same.lines,['Today (Thursday, November 26): 9 a.m. to 10:30 a.m.: Record','Tomorrow (Friday, November 27): all day: Black Friday; 4 p.m. to 4:15 p.m.: Skool Email']);
 const next=calendarLines(snapshot,at(8,0,27));
 assert.deepEqual(next.lines,['Today (Friday, November 27): all day: Black Friday; 4 p.m. to 4:15 p.m.: Skool Email','Tomorrow: not read yet.']);
 assert.match(next.when,/Thursday, November 26/);
 assert.equal(calendarLines(snapshot,at(8,0,29)),null,'nothing current is left');
 assert.equal(calendarLines({days:[]},at(8)),null);
});

test('a read saves both days; a failed one keeps the last good reading and records why', async t => {
 const root=vault(t),now=at(14),dates=[localDate(now),'2026-11-27'];let asked;
 const answer={status:'ok',summary:'Read.',text:'```json\n'+JSON.stringify({days:[{date:dates[0],events:[]},{date:dates[1],events:[{allDay:true,title:'Black Friday'}]}]})+'\n```'};
 const saved=await refreshCalendar(root,{provider:'claude',model:'haiku',now,execute:async(_root,job,prompt)=>{asked={job,prompt};return answer}});
 assert.equal(asked.job.model,'haiku');assert.equal(asked.job.skill,'calendar-snapshot');
 assert.match(asked.prompt,/2026-11-26 \(today, Thursday, November 26\)/);assert.match(asked.prompt,/Only read/);
 assert.deepEqual(readCalendarSnapshot(root).days,saved.days);assert.equal(saved.error,null);
 await assert.rejects(refreshCalendar(root,{provider:'claude',model:'haiku',now:at(15),execute:async()=>({status:'blocked',summary:'No Google Calendar connector.',text:''})}),/No Google Calendar/);
 const after=readCalendarSnapshot(root);
 assert.equal(after.fetchedAt,saved.fetchedAt,'the last good reading stays');assert.deepEqual(after.days,saved.days);
 assert.match(after.error,/No Google Calendar/);assert.equal(after.lastAttemptAt,at(15).toISOString());
 assert.ok(fs.existsSync(path.join(root,CALENDAR_FILE)));
});

test('the prompt asks for the two dates only, read-only, as JSON', () => {
 const prompt=calendarPrompt(['2026-11-26','2026-11-27'],'America/Chicago');
 assert.match(prompt,/America\/Chicago/);assert.match(prompt,/do not create, change or delete events/);assert.match(prompt,/"date":"2026-11-27"/);
});
