import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const {parseBrief}=await createJiti(import.meta.url).import('../src/lib/morningBrief.ts');
const parse=body=>parseBrief('inbox/research/morning-intel/2026-09-15-intel.md',body);

test('ranked opportunity titles retain their order without counting nested supporting fields',()=>{
 const report=parse(`## So What — Content Plan
A short introduction before the platform sections.
### YouTube (ranked)
1. **"First useful idea." (A comparison)**
   - **Hook:** A spoken opening.
   - **Rides:** Supporting story.
   - **Franchise:** Existing series.
   - **Urgency:** This week.
2. **"Second useful idea"**
   - **Hook:** Another opening.
   - **Evidence:** More detail.
3. **"Third useful idea"**
   - **Format:** A demonstration.
4. **"Fourth useful idea"** Extra context.
5. **"Fifth useful idea"**
### LinkedIn
1. **A separate LinkedIn adaptation**
### Shorts / carousels
- **Short:** An excerpt.
## Source Status
- **A source label**
`);
 assert.deepEqual(report.contentOpportunities,['First useful idea. (A comparison)','Second useful idea','Third useful idea','Fourth useful idea','Fifth useful idea']);
 assert.deepEqual(report.contentOpportunities.slice(0,3),['First useful idea. (A comparison)','Second useful idea','Third useful idea']);
});

test('legacy bulleted opportunities ignore deeper numbered explanations and generic bold field labels',()=>{
 const report=parse(`## Content Opportunities
- **[A useful walkthrough](https://example.com/a)** — More description.
  1. **A supporting step**
  2. **Another step**
- **Why now:** Evidence for the preceding idea.
- **Second useful walkthrough** — More description.
  - **Hook:** An opening.
- **Third useful walkthrough**
`);
 assert.deepEqual(report.contentOpportunities,['A useful walkthrough','Second useful walkthrough','Third useful walkthrough']);
});

test('plain ranked titles, parenthesis numbering, quoted bullets and duplicates stay readable',()=>{
 assert.deepEqual(parse('## Content Opportunities\n1) First idea\n2) [Second idea](https://example.com)\n3) Third idea').contentOpportunities,['First idea','Second idea','Third idea']);
 assert.deepEqual(parse('## Content Opportunities\n- “First idea”\n- "Second idea"\n- “First idea”').contentOpportunities,['First idea','Second idea']);
});

test('flush-left supporting bullets are not promoted over a ranked list',()=>{
 assert.deepEqual(parse('## Content Opportunities\n1. **First idea**\n- **Hook:** Example\n2. **Second idea**\n- **Rides:** Source\n3. **Third idea**').contentOpportunities,['First idea','Second idea','Third idea']);
});

test('fenced examples are ignored and an absent idea list remains empty',()=>{
 assert.deepEqual(parse('## Content Opportunities\n```md\n1. **An example, not an idea**\n```\n1. **Actual idea**').contentOpportunities,['Actual idea']);
 assert.deepEqual(parse('## Content Opportunities\nNo supported opportunities today.').contentOpportunities,[]);
});

test('BOM and CRLF briefs retain metadata and remove display-only Markdown from the top story',()=>{
 const report=parse('\uFEFF---\r\ndate: 2026-09-15\r\n---\r\n## Top Story\r\n**The main story.** Read [the source](https://example.com).\r\n\r\nMore detail.\r\n## Content Opportunities\r\n1. **Useful idea**\r\n');
 assert.equal(report.date,'2026-09-15');assert.equal(report.topStory,'The main story. Read the source.');assert.deepEqual(report.contentOpportunities,['Useful idea']);
});
