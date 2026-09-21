import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {getBriefCatalog,readBriefLookupReply,readBriefReply,localDate} from '../runner/brief-voice.mjs';

const now=new Date(2026,8,21,12),date=localDate(now);
const PRIVATE=['Private sponsor deal expires today','$4,500','Stripe payout','Embargoed launch','Private task'];
const brief=topStory=>`# Morning Intel\n\n## TL;DR\n\n- **The model is the whole story.**\n- Private sponsor deal expires today; the rate was $4,500.\n- A Stripe payout lands today.\n\n---\n\n## Top Story\n\n${topStory}\n\n---\n\n## AI News (last 24h)\n\n- Embargoed launch, private.\n\n## Hacker News Pulse\n| Story | Points | Comments |\n|---|---|---|\n| Points leader | 100 | 1 |\n\n## Inbox\nPrivate task.`;
const story=['**The model that refuses to write text.**',
 'The lab came out of stealth on Monday with $40M in funding and a model that does not generate tokens at all. You hand it program state plus typed questions; it answers them in one parallel pass. A third sentence that should not be spoken in the quick answer.',
 'The headline numbers: **40x faster** than frontier models, per [the launch post](https://example.com/launch), and it cannot emit a type error.',
 '**Why this matters to you specifically:** the integration has been live since yesterday.',
 'Sources: [One](https://example.com/1) · [Two](https://example.com/2)',
 'A paragraph after the sources that must never be read.'].join('\n\n');
function fixture(t,body){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-brief-detail-')),directory=path.join(root,'inbox/research/morning-intel');fs.mkdirSync(directory,{recursive:true});
 fs.writeFileSync(path.join(directory,`${date}-intel.md`),body);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
const ask=root=>readBriefLookupReply(root,[{source:'brief',rank:'points'}],now).reply;

test('the headline is unchanged, and the story under it becomes public detail up to the Sources line',t=>{
 const root=fixture(t,brief(story)),catalog=getBriefCatalog(root,now);
 assert.equal(catalog.headline,'The model that refuses to write text.');
 assert.equal(catalog.topStoryDetail.length,3);
 assert.match(catalog.topStoryDetail[0],/^The lab came out of stealth/);
 assert.equal(catalog.topStoryDetail[1],'The headline numbers: 40x faster than frontier models, per the launch post, and it cannot emit a type error.','markdown and links are spoken text');
 assert.match(catalog.topStoryDetail[2],/^Why this matters to you specifically:/);
 const everything=JSON.stringify(catalog);
 assert.doesNotMatch(everything,/Sources|example\.com|must never be read/);
 for(const secret of PRIVATE)assert.ok(!everything.includes(secret),secret);
 // The whole-brief route already carries a bounded summary; it keeps its old size and gets no extra detail.
 assert.deepEqual(getBriefCatalog(root,now,{includeSummary:true}).topStoryDetail,[]);assert.equal(getBriefCatalog(root,now).topStoryDetail.length,3);
});

test('the detail is bounded: at most eight paragraphs, 700 characters each, 3,000 in total, and a rule ends it',t=>{
 const long=['**Headline.**',...Array.from({length:12},(_,i)=>`Paragraph ${i+1} `+'word '.repeat(200))].join('\n\n');
 const detail=getBriefCatalog(fixture(t,brief(long)),now).topStoryDetail;
 assert.ok(detail.length>=1&&detail.length<=8);assert.ok(detail.every(text=>text.length<=700));assert.ok(detail.join('').length<=3000);
 const ruled=getBriefCatalog(fixture(t,brief('**Headline.**\n\nFirst paragraph.\n\n***\n\nAfter the rule.')),now).topStoryDetail;
 assert.deepEqual(ruled,['First paragraph.']);
 // Copies are independent: a caller cannot poison the cache.
 const root=fixture(t,brief(story));getBriefCatalog(root,now).topStoryDetail.push('Injected');assert.equal(getBriefCatalog(root,now).topStoryDetail.length,3);
});

test('the quick answer is the headline plus the first one or two sentences of the story, inside the spoken limit',t=>{
 const reply=ask(fixture(t,brief(story)));
 assert.equal(reply,"From today's morning brief: The model that refuses to write text. The lab came out of stealth on Monday with $40M in funding and a model that does not generate tokens at all. You hand it program state plus typed questions; it answers them in one parallel pass.");
 assert.ok(reply.length<=650);assert.doesNotMatch(reply,/third sentence/i);
 assert.equal(readBriefReply(fixture(t,brief(story)),now).reply,reply);
 // A headline without closing punctuation gets a full stop before the story continues.
 assert.match(ask(fixture(t,brief('**A bare headline**\n\nThe story starts here. And goes on.'))),/^From today's morning brief: A bare headline\. The story starts here\. And goes on\.$/);
});

test('a brief without story paragraphs, or whose headline already is a paragraph, answers exactly as before',t=>{
 assert.equal(ask(fixture(t,brief('Public lead.'))),"From today's morning brief: Public lead.");
 const paragraph='A lead that is already a paragraph. '+'It keeps going with detail. '.repeat(12);
 const reply=ask(fixture(t,brief(paragraph.trim()+'\n\nSecond paragraph that stays out of the quick answer.')));
 assert.equal(reply,`From today's morning brief: ${paragraph.trim()}`);assert.doesNotMatch(reply,/Second paragraph/);
 // Two lookups in one sentence share the speech budget; the story's lead only appears when it fits.
 const both=readBriefLookupReply(fixture(t,brief(story)),[{source:'brief',rank:'points'},{source:'hn',rank:'points'}],now).reply;
 assert.ok(both.length<=820,String(both.length));assert.match(both,/The model that refuses to write text\./);assert.match(both,/Points leader/);
});

test('a missing or stale brief carries an empty detail list and the same reply as before',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aos-brief-detail-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const catalog=getBriefCatalog(root,now);
 assert.deepEqual(catalog.topStoryDetail,[]);assert.match(catalog.reply,/I don't have today's morning brief yet\./);
});

test('nothing private rides along: comments across paragraphs, text after Sources or a rule inside a paragraph, deeper headings',t=>{
 const detail=body=>getBriefCatalog(fixture(t,brief(body)),now),leak=/PRIVATE/;
 // Codex's reproductions.
 const commented=detail('**Headline.**\n\nPublic story.\n\n<!-- internal only\n\nPRIVATE PAYOUT\n\n-->\n\nStill public.');
 assert.deepEqual(commented.topStoryDetail,['Public story.','Still public.']);
 const inline=detail('**Headline.**\n\nPublic prose.\nSources: [link](https://example.com)\nPRIVATE AFTER SOURCES');
 assert.deepEqual(inline.topStoryDetail,['Public prose.']);
 const ruled=detail('**Headline.**\n\nPublic prose.\n---\nPRIVATE AFTER RULE');
 // A dash line directly under text is a setext heading in markdown, so that text goes too: losing a line is the safe side.
 assert.deepEqual(ruled.topStoryDetail,[]);
 const deeper=detail('**Headline.**\n\nPublic prose.\n\n#### Inbox\nPRIVATE INBOX ITEM\n\nMore PRIVATE text.');
 assert.deepEqual(deeper.topStoryDetail,['Public prose.']);
 const unclosed=detail('**Headline.**\n\nPublic prose.\n\n<!-- never closed\n\nPRIVATE FOREVER');
 assert.deepEqual(unclosed.topStoryDetail,['Public prose.']);
 const bold=detail('**Headline.**\n\nPublic prose.\n\n**Sources:** PRIVATE-looking links\n\nPRIVATE AFTER BOLD SOURCES');
 assert.deepEqual(bold.topStoryDetail,['Public prose.']);
 for(const catalog of [commented,inline,ruled,deeper,unclosed,bold]){assert.doesNotMatch(JSON.stringify(catalog),leak);assert.equal(catalog.headline,'Headline.')}
 for(const body of ['**Headline.**\n\nPublic prose.\nSources: x\nPRIVATE','**Headline.**\n\n<!-- a\n\nPRIVATE\n\n-->\n\nPublic prose.'])assert.doesNotMatch(ask(fixture(t,brief(body))),leak);
});

test('round 2: a comment opened in the headline, spaced rules, marked or invisible Sources lines, setext headings, tables',t=>{
 const catalog=body=>getBriefCatalog(fixture(t,brief(body)),now),leak=/PRIVATE/;
 const cases={
  commentFromHeadline:['**Headline.** <!--\n\nPRIVATE PAYOUT\n\n-->\n\nPublic prose.',['Public prose.']],
  unclosedFromHeadline:['**Headline.** <!--\n\nPRIVATE PAYOUT',[]],
  spacedStars:['**Headline.**\n\nPublic prose.\n* * *\nPRIVATE',['Public prose.']],
  spacedDashes:['**Headline.**\n\nPublic prose.\n\n- - -\n\nPRIVATE',['Public prose.']],
  spacedUnderscores:['**Headline.**\n\nPublic prose.\n_ _ _\nPRIVATE',['Public prose.']],
  listSources:['**Headline.**\n\nPublic prose.\n- Sources: x\nPRIVATE',['Public prose.']],
  quotedSources:['**Headline.**\n\nPublic prose.\n> Sources: x\nPRIVATE',['Public prose.']],
  numberedSources:['**Headline.**\n\nPublic prose.\n1. **Sources:** x\nPRIVATE',['Public prose.']],
  zeroWidthSources:['**Headline.**\n\nPublic prose.\n\u200bSources: x\nPRIVATE',['Public prose.']],
  setextEquals:['**Headline.**\n\nPublic prose.\n\nInbox PRIVATE heading\n=====\nPRIVATE body',['Public prose.']],
  setextDashes:['**Headline.**\n\nPublic prose.\n\nInbox PRIVATE heading\n-----\nPRIVATE body',['Public prose.']],
  table:['**Headline.**\n\nPublic prose.\n\n| Sources | PRIVATE |\n|---|---|\n| a | PRIVATE |',['Public prose.']],
  crlf:['**Headline.**\r\n\r\nPublic prose.\r\nSources: x\r\nPRIVATE',['Public prose.']],
  sourcesInHeadlineParagraph:['**Headline.**\nSources: x\nPRIVATE\n\nPRIVATE second paragraph',[]],
 };
 for(const [name,[body,expected]] of Object.entries(cases)){
  const result=catalog(body);
  assert.deepEqual(result.topStoryDetail,expected,name);assert.equal(result.headline,'Headline.',name);assert.doesNotMatch(JSON.stringify(result),leak,name);
  assert.doesNotMatch(ask(fixture(t,brief(body))),leak,name);
 }
 // An ordinary story is untouched by all of this.
 assert.equal(catalog(story).topStoryDetail.length,3);
});

test('round 3: a headline that merely starts with the word Source is a headline, and an emptied section never falls back to TL;DR',t=>{
 const tldr='# Morning Intel\n\n## TL;DR\n\n- **Top story:** PRIVATE sponsor payout.\n\n## Top Story\n\n';
 const write=body=>fixture(t,tldr+body+'\n\n## AI News\n\n- Other.');
 const open=write('**Source code for the new model is now public.**\n\nSources say the weights follow next week. Source maps are included.\n\nSources: [a](https://example.com)\n\nPRIVATE after sources');
 const catalog=getBriefCatalog(open,now);
 assert.equal(catalog.headline,'Source code for the new model is now public.');
 assert.deepEqual(catalog.topStoryDetail,['Sources say the weights follow next week. Source maps are included.']);
 assert.doesNotMatch(ask(open),/PRIVATE/);assert.match(ask(open),/Source code for the new model is now public\. Sources say the weights follow next week\./);
 // Labels in their usual spellings still end the story.
 for(const label of ['Sources:','Source:','**Sources:**','Sources — a, b','Sources','sources :']){
  const result=getBriefCatalog(write('**Headline.**\n\nPublic prose.\n\n'+label+' x\n\nPRIVATE'.replace(' x',label==='Sources'?'':' x')),now);
  assert.deepEqual(result.topStoryDetail,['Public prose.'],label);assert.doesNotMatch(JSON.stringify(result),/PRIVATE/,label);
 }
 // A Top Story section that cleans to nothing: no headline, and TL;DR is NOT consulted.
 for(const emptied of ['<!-- PRIVATE note only -->','---','Sources: x\n\nPRIVATE','| a | b |']){
  const result=getBriefCatalog(write(emptied),now);assert.equal(result.headline,'',emptied);assert.doesNotMatch(JSON.stringify(result),/PRIVATE/,emptied);
  assert.equal(ask(write(emptied)),"Today's morning brief doesn't identify a top story. Please open the brief for the full headlines.",emptied);
 }
 // A brief with NO Top Story section keeps today's TL;DR fallback, unchanged.
 const none=fixture(t,'## TL;DR\n\n- **Top story:** A public lead from the summary.\n\n## AI News\n\n- Other.');
 assert.equal(getBriefCatalog(none,now).headline,'Top story: A public lead from the summary.');
});

test('round 4: emphasis closed before the colon, other label words, and an empty Top Story heading',t=>{
 const tldr='# Morning Intel\n\n## TL;DR\n\n- **Top story:** PRIVATE sponsor payout.\n\n';
 const write=section=>fixture(t,tldr+section+'\n\n## AI News\n\n- Other.');
 for(const label of ['**Sources**: x','*Sources*: x','__Sources__: x','`Sources`: x','**Sources** : x','* **Sources**: x','> *Source*: x','References: x','**Links:** x','Citations (3): x','Sources (12): x']){
  const root=write('## Top Story\n\n**Headline.**\n\nPublic prose.\n'+label+'\nPRIVATE after the label'),result=getBriefCatalog(root,now);
  assert.deepEqual(result.topStoryDetail,['Public prose.'],label);assert.equal(result.headline,'Headline.',label);assert.doesNotMatch(JSON.stringify(result),/PRIVATE/,label);assert.doesNotMatch(ask(root),/PRIVATE/,label);
 }
 // Prose that merely starts with such a word is still prose.
 const prose=getBriefCatalog(write('## Top Story\n\n**Headline.**\n\nLinks between the two labs go back years. References to the older paper are everywhere.'),now);
 assert.deepEqual(prose.topStoryDetail,['Links between the two labs go back years. References to the older paper are everywhere.']);
 // An EMPTY Top Story heading also blocks the TL;DR fallback.
 for(const empty of ['## Top Story','## Top Story\n','### Top Story\n\n']){
  const root=write(empty),result=getBriefCatalog(root,now);
  assert.equal(result.headline,'',JSON.stringify(empty));assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);assert.match(ask(root),/doesn't identify a top story/);
 }
});
