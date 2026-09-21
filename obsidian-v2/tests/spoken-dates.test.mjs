import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSpokenDate,describeDate,localParts,shiftIso} from '../runner/spoken-dates.mjs';

// 2026-09-16 is a Wednesday in America/Chicago (17:00Z = noon local).
const now=new Date('2026-09-16T17:00:00Z');
const day=(text,date,rest)=>{const parsed=parseSpokenDate(text,{now});assert.ok(parsed,text);assert.equal(parsed.kind,'day',text);assert.equal(parsed.date,date,text);if(rest!==undefined)assert.equal(parsed.rest,rest,text)};

test('relative days resolve against the local calendar day',()=>{
 assert.equal(localParts(now).iso,'2026-09-16');assert.equal(localParts(now).weekday,3);
 day('the morning intel brief from this morning','2026-09-16','the morning intel brief');
 day("today's brief",'2026-09-16','brief');
 day("yesterday's intel",'2026-09-15','intel');
 day('the note from yesterday morning','2026-09-15','the note');
 day('the day before yesterday','2026-09-14','');
 day('three days ago','2026-09-13');
 day('a couple of days ago','2026-09-14');
 day('2 weeks ago','2026-09-02');
 day("tomorrow's note",'2026-09-17','note');
});

test('weekday names mean the most recent occurrence, with last and this qualifiers',()=>{
 day("monday's intel",'2026-09-14','intel');
 day('the intel from last monday','2026-09-14','the intel');
 day('friday','2026-09-11');
 day('wednesday','2026-09-16');
 day('this wednesday','2026-09-16');
 day('last wednesday','2026-09-09');
 day('the brief from tues','2026-09-15','the brief');
});

test('explicit dates accept month names, numeric forms and bare day numbers',()=>{
 day('the intel from september 10','2026-09-10','the intel');
 day('sept 10th','2026-09-10');
 day('the 10th of september','2026-09-10');
 day('the brief from 9/10','2026-09-10','the brief');
 day('9/10/25','2025-09-10');
 day('2026-09-12','2026-09-12');
 day('the note from the 12th','2026-09-12','the note');
 day('the 20th','2026-08-20');
 day('december 25','2025-12-25');
 const january=new Date('2026-01-02T17:00:00Z');
 assert.equal(parseSpokenDate('the 30th',{now:january}).date,'2025-12-30');
});

test('weeks resolve to Monday-to-Sunday ranges',()=>{
 const last=parseSpokenDate('the weekly review from last week',{now});
 assert.deepEqual([last.kind,last.from,last.to,last.rest],['range','2026-09-07','2026-09-13','the weekly review']);
 const current=parseSpokenDate("this week's review",{now});
 assert.deepEqual([current.kind,current.from,current.to],['range','2026-09-14','2026-09-16']);
});

test('phrases without a date return null and labels read naturally',()=>{
 for(const text of ['the skoot playbook','open my proposal','morning intel','the latest brief','may I see it'])assert.equal(parseSpokenDate(text,{now}),null,text);
 assert.equal(describeDate('2026-09-16','2026-09-16'),'today');
 assert.equal(describeDate('2026-09-15','2026-09-16'),'yesterday');
 assert.equal(describeDate('2026-09-10','2026-09-16'),'Thursday, September 10');
 assert.equal(describeDate('2025-12-25','2026-09-16'),'Thursday, December 25, 2025');
 assert.equal(shiftIso('2026-03-01',-1),'2026-02-28');
});
