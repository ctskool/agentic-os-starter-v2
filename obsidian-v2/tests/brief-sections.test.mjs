import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {getBriefCatalog,readBriefSectionReply} from '../runner/brief-voice.mjs';
import {parseBriefSections} from '../runner/brief-sections.mjs';
const now=new Date(2026,8,12,12),date='2026-09-12';
const report=`## Top Story
Public headline only.

## AI News (last 24h)
### Anthropic / Claude
- ClaudeFixtureOne release.
  - Nested capability belongs to the release.
- ClaudeFixtureTwo update.
### OpenAI / Codex
- CodexFixtureOne release.
- CodexFixtureTwo update.
### Everyone else
- OtherFixtureOne release.

## YouTube Radar
| Title | Channel | Views | Ratio |
|---|---|---|---|
| VideoFixtureOne | MakerOne | 900 | 9.0x |
| VideoFixtureTwo | MakerTwo | 700 | 7.0x |
### Small-Channel Outliers (last 24h)
| Title | Channel | Views | Mult |
|---|---|---|---|
| OutlierFixtureOne | TinyOne | 400 | 20x |
| OutlierFixtureTwo | TinyTwo | 300 | 15x |

## GitHub Radar
**New this week:**
- RepoFixtureOne — 300 stars.
- RepoFixtureTwo — 200 stars.

## Inbox (last 24h)
### Urgent
- UrgentFixtureOne needs attention.
- UrgentFixtureTwo deadline today.
### Needs reply
- ReplyFixtureOne asks a question.
- NegativeReplyFixture has no reply needed.
### Sponsor pitches
- SponsorFixtureOne paid sponsorship inquiry.
### Commitments and real opportunities
- MixedFixtureOne interesting opportunity.
- CueReplyFixture is worth a reply.
- NegativeCueFixture does not require a response. No reply needed.
- AffiliateFixture payment processed.

## So What — Content Plan
### YouTube (ranked)
**1. ContentVideoFixtureOne**

> Hook: FirstHookFixture belongs to video one.

Rides: FirstRationaleFixture belongs to video one.

**2. ContentVideoFixtureTwo**

> Hook: SecondHookFixture belongs to video two.

Rides: SecondRationaleFixture belongs to video two.

### LinkedIn — useful ideas
1. LinkedFixtureOne with a saved outline.
2. LinkedFixtureTwo with another outline.
### Shorts / Carousels
- ShortFixtureOne animation idea.
- CarouselFixtureOne slides idea.

## Source Status
| source | status | note |
|---|---|---|
| hn | ok | 12 saved items |
| mail | partial | mailbox fixture unavailable |
`;
function fixture(t,raw=report){const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-brief-sections-'));const folder=path.join(root,'inbox/research/morning-intel');fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,`${date}-intel.md`);fs.writeFileSync(file,raw);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,file,folder};}
test('opt-in sections preserve provider, parent/child and platform boundaries without leaking into public news',t=>{
 const f=fixture(t);
 for(const [section,yes,no] of [
  ['ai-claude','ClaudeFixtureOne','CodexFixture'],['ai-codex','CodexFixtureOne','ClaudeFixture'],['ai-other','OtherFixtureOne','CodexFixture'],
  ['youtube','VideoFixtureOne','OutlierFixture'],['outliers','OutlierFixtureOne','VideoFixture'],['github','RepoFixtureOne','SponsorFixture'],
  ['content-youtube','ContentVideoFixtureOne','LinkedFixture'],['content-linkedin','LinkedFixtureOne','ContentVideoFixture'],['content-shorts','ShortFixtureOne','LinkedFixture'],['source-status','mail','SponsorFixture'],
 ]){const catalog=getBriefCatalog(f.root,now,{sections:[section]});assert.deepEqual(Object.keys(catalog.sections),[section]);assert.equal(catalog.sections[section].status,'available');assert.match(catalog.sections[section].text,new RegExp(yes));assert.doesNotMatch(catalog.sections[section].text,new RegExp(no));}
 const inbox=getBriefCatalog(f.root,now,{sections:['inbox']});assert.match(inbox.sections.inbox.text,/SponsorFixture/);
 const publicCatalog=getBriefCatalog(f.root,now);assert.equal(publicCatalog.sections,undefined);assert.equal(publicCatalog.parsedSections,undefined);assert.doesNotMatch(JSON.stringify(publicCatalog),/Fixture|FirstHook|Rationale/);assert.equal(publicCatalog.headline,'Public headline only.');
});
test('explicit inbox headings and item recommendations support categories while exclusions and mixed groups remain honest',t=>{
 const f=fixture(t);
 const urgent=readBriefSectionReply(f.root,{section:'inbox',category:'urgent'},now);assert.match(urgent.reply,/UrgentFixtureOne.*UrgentFixtureTwo/);assert.doesNotMatch(urgent.reply,/SponsorFixture|ReplyFixture/);assert.equal(urgent.lookup.count,2);
 const reply=readBriefSectionReply(f.root,{section:'inbox',category:'reply'},now);assert.match(reply.reply,/ReplyFixtureOne.*CueReplyFixture/);assert.doesNotMatch(reply.reply,/NegativeReplyFixture|NegativeCueFixture|AffiliateFixture|MixedFixture/);assert.equal(reply.lookup.count,2);
 const sponsor=readBriefSectionReply(f.root,{section:'inbox',category:'sponsor'},now);assert.match(sponsor.reply,/SponsorFixtureOne/);assert.doesNotMatch(sponsor.reply,/AffiliateFixture|MixedFixture/);
 fs.writeFileSync(f.file,'## Inbox\n### Opportunities / Needs reply\n- MixedOnlyFixture interesting lead.\n\nNo operational alerts.');
 for(const category of ['urgent','reply','sponsor']){const answer=readBriefSectionReply(f.root,{section:'inbox',category},now);assert.match(answer.reply,/does not explicitly label/);assert.doesNotMatch(answer.reply,/MixedOnlyFixture/);}
});
test('ranked content plan keeps hooks and detail with their own saved item',t=>{
 const f=fixture(t),section=getBriefCatalog(f.root,now,{sections:['content-youtube']}).sections['content-youtube'];
 assert.equal(section.ordered,true);assert.equal(section.items.length,2);assert.match(section.items[0].text,/ContentVideoFixtureOne.*FirstHookFixture.*FirstRationaleFixture/);assert.doesNotMatch(section.items[0].text,/SecondHook|ContentVideoFixtureTwo/);
 const second=readBriefSectionReply(f.root,{section:'content-youtube',count:1,offset:1},now);assert.match(second.reply,/2\. ContentVideoFixtureTwo.*SecondHookFixture.*SecondRationaleFixture/);assert.doesNotMatch(second.reply,/FirstHook|ContentVideoFixtureOne/);assert.equal(second.lookup.count,1);assert.equal(second.lookup.offset,1);
});
test('closed threads, reversed urgency and ignored sponsor spam never become action categories',t=>{
 const f=fixture(t,`## Inbox
### Needs reply
- ClosedThreadFixture: Do not respond; the thread is already closed.
- RealReplyFixture: A reply is required.
### Routine
- NewsletterFixture: Urgent? No, this is only a newsletter.
- IgnoredSpamFixture: Ignore all sponsor spam.
### Ignore tier
- ColdPitchFixture: A sponsor pitch with no relevant budget.
### Sponsor opportunities
- GenuineSponsorFixture: Paid sponsorship inquiry.
### Urgent
- GenuineUrgentFixture: Urgent deadline.
`);
 for(const [category,yes,no] of [['reply','RealReplyFixture','ClosedThreadFixture'],['sponsor','GenuineSponsorFixture','IgnoredSpamFixture|ColdPitchFixture'],['urgent','GenuineUrgentFixture','NewsletterFixture']]){
  const result=readBriefSectionReply(f.root,{section:'inbox',category},now);assert.match(result.reply,new RegExp(yes));assert.doesNotMatch(result.reply,new RegExp(no));assert.equal(result.lookup.count,1);
 }
});
test('tables preserve row order and malformed rows never produce partial answers',t=>{
 const f=fixture(t);const youtube=readBriefSectionReply(f.root,{section:'youtube'},now);assert.match(youtube.reply,/VideoFixtureOne.*MakerOne.*900.*VideoFixtureTwo/);assert.equal(youtube.lookup.count,2);
 fs.writeFileSync(f.file,report.replace('| VideoFixtureTwo | MakerTwo | 700 | 7.0x |','| VideoFixtureTwo | missing fields |'));
 assert.equal(getBriefCatalog(f.root,now,{sections:['youtube']}).sections.youtube.status,'malformed');assert.match(readBriefSectionReply(f.root,{section:'youtube'},now).reply,/readable/);
 assert.equal(getBriefCatalog(f.root,now,{sections:['outliers']}).sections.outliers.status,'available');
});
test('missing, empty, duplicate, oversized and fenced sections are explicit',()=>{
 assert.equal(parseBriefSections('## Inbox\n\n---').inbox.status,'empty');assert.equal(parseBriefSections('## Other\nAnything.').inbox.status,'missing');
 assert.equal(parseBriefSections('## Inbox\n- A\n## Inbox\n- B').inbox.status,'malformed');assert.equal(parseBriefSections('## Inbox\n'+'A'.repeat(64001)).inbox.status,'malformed');
 assert.equal(parseBriefSections('```markdown\n## Inbox\n- Fake data\n```\n## Source Status\n- Real status').inbox.status,'missing');
 for(const raw of [
  '## Inbox\n```text\n~~~\n### Urgent\n- FakeInMixedFence\n~~~\n```',
  '## Inbox\n````text\n```\n### Urgent\n- FakeInShortFence\n```\n````',
  '## Inbox\n```text\n```not-a-closer\n### Urgent\n- FakeInInfoCloser\n```',
 ]){const inbox=parseBriefSections(raw).inbox;assert.equal(inbox.status,'empty');assert.deepEqual(inbox.items,[]);}
});
test('section answers keep every requested item inside speech budget and expose truncation',t=>{
 const body='## GitHub Radar\n'+['FirstMarker','SecondMarker','ThirdMarker','FourthMarker','FifthMarker'].map(title=>`- ${title} ${'long detail '.repeat(110)}`).join('\n'),f=fixture(t,body);
 const data=getBriefCatalog(f.root,now,{sections:['github']}).sections.github;assert.equal(data.truncated,true);assert.ok(data.text.length<=4500);
 const answer=readBriefSectionReply(f.root,{section:'github',count:5},now);assert.ok(answer.reply.length<=850);for(const marker of ['FirstMarker','SecondMarker','ThirdMarker','FourthMarker','FifthMarker'])assert.match(answer.reply,new RegExp(marker));
 assert.throws(()=>readBriefSectionReply(f.root,{section:'github',category:'sponsor'},now),/Unsupported/);assert.throws(()=>readBriefSectionReply(f.root,{section:'github',count:6},now),/Unsupported/);
 assert.throws(()=>readBriefSectionReply(f.root,{section:'github',count:3,offset:4},now),/Unsupported/);
 assert.equal(readBriefSectionReply(f.root,{section:'github',offset:4},now).lookup.count,1);
});
test('stale and missing current reports never present previous section content as today',t=>{
 const f=fixture(t);fs.renameSync(f.file,path.join(f.folder,'2026-09-11-intel.md'));const result=readBriefSectionReply(f.root,{section:'inbox',category:'reply'},now);assert.match(result.reply,/don't have today's.*2026-09-11/);assert.doesNotMatch(result.reply,/ReplyFixture/);
});
