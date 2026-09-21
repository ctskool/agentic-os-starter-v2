import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {getBriefCatalog,inspectBriefRequest,readBriefLookupReply,localDate} from '../runner/brief-voice.mjs';

const now=new Date(2026,8,12,12),date=localDate(now);
const report=title=>`## TL;DR\n- Private invoice from client.\n- Inbox: top story: private correspondence.\n\n## Top Story\n${title}\n\n## Headlines\n- Second public headline.\n- Third public headline.\n\n## AI News\n- Embargoed product launch, private.\n\n## Hacker News Pulse\n| Story | Points | Comments |\n|---|---|---|\n| Points leader | 100 | 1 |\n| Discussion leader | 5 | 90 |\n| Third item | 3 | 20 |\n\n## Inbox\nPrivate task.`;
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-brief-catalog-')),directory=path.join(root,'inbox/research/morning-intel');fs.mkdirSync(directory,{recursive:true});
 const file=path.join(directory,`${date}-intel.md`),write=(body,name=`${date}-intel.md`)=>{const f=path.join(directory,name);fs.writeFileSync(f,body);return f;};
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,directory,file,write};
}
test('natural briefing slots accept varied openings, plurals, counts and ordinal followups',()=>{
 for(const text of [
  'Could you quickly tell me what topped today’s AI headlines?',
  'I was wondering which AI story led the news this morning?',
  'Give me the main AI story from this morning.',
  'What was today’s leading headline?',
  'Hey, please remind me of the biggest news for today.',
 ])assert.deepEqual(inspectBriefRequest(text),{kind:'lookup',plan:[{source:'brief',rank:'points'}]},text);
 assert.deepEqual(inspectBriefRequest('Read me today’s top three HN stories.'),{kind:'lookup',plan:[{source:'hn',rank:'points',count:3}]});
 assert.deepEqual(inspectBriefRequest('Can you list the AI headlines this morning?'),{kind:'lookup',plan:[{source:'brief',rank:'points',count:3}]});
 const previous={date,briefSource:`inbox/research/morning-intel/${date}-intel.md`,plan:[{source:'hn',rank:'comments'}]};
 const second=inspectBriefRequest('And the second story?',{previous});assert.equal(second.kind,'lookup');assert.deepEqual(second.plan,[{source:'hn',rank:'comments',offset:1}]);
 const about=inspectBriefRequest('What about the second story?',{previous});assert.equal(about.kind,'lookup');assert.deepEqual(about.plan,second.plan);
 assert.notEqual(inspectBriefRequest('And the second story?').kind,'lookup');
 assert.notEqual(inspectBriefRequest('And the second story?',{previous:{...previous,briefSource:'../../private.md'}}).kind,'lookup');
});
test('unsupported constraints and compound work never become partial saved-news answers',()=>{
 for(const text of [
  'What topped the AI headlines today and write an outline?',
  'What are the latest AI headlines today?',
  'Tell me the top AI story after the morning brief.',
  'Give me the top HN story about Rust today.',
  'Give me today’s top HN story, excluding politics.',
  'Read the headlines for September 11.',
  'What was today’s leading headline and the score of the Bears game?',
  'What was the biggest AI news today but not OpenAI?',
 ])assert.notEqual(inspectBriefRequest(text).kind,'lookup',text);
 assert.equal(inspectBriefRequest('Give me the gist of the news in my morning brief.').kind,'ambiguous');
 assert.equal(inspectBriefRequest('What did my morning briefing say?').kind,'ambiguous');
 assert.equal(inspectBriefRequest('Read my morning intel').kind,'outside');
 assert.equal(inspectBriefRequest('Read my morning intel').guarded,undefined);
 assert.equal(inspectBriefRequest('Why does the leading story in today’s morning brief matter?').kind,'ambiguous');
 assert.equal(inspectBriefRequest('What was the top Python HN story today?').guarded,true);
});
test('catalog retains only bounded public briefing facts, preserving distinct rankings',t=>{
 const f=fixture(t);f.write(report('Public lead.'));
 const catalog=getBriefCatalog(f.root,now);assert.equal(catalog.status,'current');assert.equal(catalog.headline,'Public lead.');assert.equal(catalog.headlines.length,3);
 assert.doesNotMatch(JSON.stringify(catalog),/private|invoice|embargoed/i);
 assert.match(getBriefCatalog(f.root,now,{includeSummary:true}).summary,/Private invoice/);
 assert.doesNotMatch(JSON.stringify(getBriefCatalog(f.root,now)),/private|invoice|embargoed/i,'whole-brief opt-in never leaks into later public news lookups');
 const answer=readBriefLookupReply(f.root,[{source:'hn',rank:'comments',offset:1}],now);assert.match(answer.reply,/2\. Third item/);assert.deepEqual(answer.lookup,{date,briefSource:`inbox/research/morning-intel/${date}-intel.md`,plan:[{source:'hn',rank:'comments',offset:1}]});
 assert.match(readBriefLookupReply(f.root,[{source:'brief',rank:'points',count:3}],now).reply,/Public lead.*Second public.*Third public/);
 assert.match(readBriefLookupReply(f.root,[{source:'brief',rank:'points',count:5}],now).reply,/doesn't include that many/);
 const copy=getBriefCatalog(f.root,now);copy.headlines.push('Injected');assert.equal(getBriefCatalog(f.root,now).headlines.length,3);
});
test('warm catalog reuses discovery and parsed facts and invalidates on edit/create/delete/day rollover',t=>{
 const f=fixture(t);f.write(report('First headline.'));
 let reads=0,lists=0;const read=fs.readFileSync,list=fs.readdirSync;
 fs.readFileSync=function(file,...args){if(file===f.file)reads++;return read.call(this,file,...args);};
 fs.readdirSync=function(file,...args){if(file===f.directory)lists++;return list.call(this,file,...args);};
 t.after(()=>{fs.readFileSync=read;fs.readdirSync=list;});
 assert.equal(getBriefCatalog(f.root,now).headline,'First headline.');
 assert.equal(getBriefCatalog(f.root,now).headline,'First headline.');assert.equal(reads,1);assert.equal(lists,1);
 f.write(report('An updated headline.'));assert.equal(getBriefCatalog(f.root,now).headline,'An updated headline.');assert.equal(reads,2);
 const newer=f.write(report('New report headline.'),`${date}-new.md`);const future=new Date(Date.now()+1000);fs.utimesSync(newer,future,future);
 assert.equal(getBriefCatalog(f.root,now).headline,'New report headline.');
 fs.unlinkSync(newer);assert.equal(getBriefCatalog(f.root,now).headline,'An updated headline.');
 const next=new Date(2026,8,13,12);assert.equal(getBriefCatalog(f.root,next).status,'stale');assert.equal(getBriefCatalog(f.root,next).headline,'');
 f.write(report('Next day headline.'),'2026-09-13-intel.md');assert.equal(getBriefCatalog(f.root,next).headline,'Next day headline.');
 fs.unlinkSync(f.file);assert.equal(getBriefCatalog(f.root,now).status,'missing');
});
test('missing folders become discoverable without a timer and same-size edits invalidate',t=>{
 const f=fixture(t);fs.rmdirSync(f.directory);assert.equal(getBriefCatalog(f.root,now).status,'missing');fs.mkdirSync(f.directory,{recursive:true});
 f.write(report('Alpha'));assert.equal(getBriefCatalog(f.root,now).headline,'Alpha');const before=fs.statSync(f.file);
 f.write(report('Bravo'));fs.utimesSync(f.file,before.atime,before.mtime);assert.equal(getBriefCatalog(f.root,now).headline,'Bravo');
});
