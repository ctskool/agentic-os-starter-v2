import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

const { parseReview, reviewPlainText, findLatestReview, readLatestReview } = await createJiti(import.meta.url).import('../src/lib/ytReview.ts');
const dir = 'inbox/reports/yt-reviews';
const path = `${dir}/2026-09-15-review.md`;
const fixture = `---
date: 2026-09-15
window: "2026-09-08 through 2026-09-14 (America/Chicago)"
channel: "Example Channel"
---
# Weekly review
## TL;DR
- **Four uploads:** mixed results.
- The new video is still climbing.

## Uploads this week
| Video | Views | vs Baseline | Likes | Comments | Verdict |
|---|---:|---:|---:|---:|---|
| [Motion design](https://www.youtube.com/watch?v=exampleone) | 23,351 | 35.4% | 165 | 7 | Climbing |
| **[A better workflow](https://www.youtube.com/watch?v=exampletwo)** | 99,866 | 151.5% | 899 | 82 | Hit |
| A web design workflow | 25,737 | 39.1% | 327 | 20 | Miss |
| Motion design follow-up | 57,073 | 86.6% | 671 | 12 | Steady |

**Baseline medians, n = 10:** 65,899.5 views; 638 likes; **1.087% engagement**, calculated per video.

### Publication and duration reference
| Video | Published | Duration |
|---|---:|---:|
| Motion design | September 14 | 12:34 |

## Top performer — [A better workflow](https://example.com/video)
**Why it worked:** A useful promise with a clear outcome.

## Underperformer — A web design workflow
The packaging was too broad.

## Channel-wide signal
The practical workflow videos are strongest.

Public totals are snapshots, not gains within the week.

The sample remains small.

## Recommended next 7 days
1. **Tuesday:** Publish a concrete workflow.
   Show the result early.
2. **Thursday:** Test a clearer title.
3. **Saturday:** Review the new upload.

These are editorial suggestions, not predictions.
`;

test('reads aligned upload tables, linked titles and decimal baseline medians', () => {
  const result = parseReview(path, fixture);
  assert.equal(result.uploads.length, 4);
  assert.deepEqual(result.uploads.map(row => row.verdict), ['Climbing', 'Hit', 'Miss', 'Steady']);
  assert.equal(result.uploads[1].title, 'A better workflow');
  assert.equal(result.uploads[1].views, 99866);
  assert.equal(result.uploads[1].vsBaselinePct, 151.5);
  assert.equal(result.baselineViews, 65899.5);
  assert.equal(result.baselineLikes, 638);
  assert.equal(result.topPerformer.title, 'A better workflow');
  assert.equal(result.channel, 'Example Channel');
  assert.equal(result.window, '2026-09-08 through 2026-09-14 (America/Chicago)');
});

test('reads paragraph signals and numbered recommendations with continuations', () => {
  const result = parseReview(path, fixture);
  assert.equal(result.channelSignal.length, 3);
  assert.equal(result.recommendations.length, 3);
  assert.equal(result.recommendations[0], 'Tuesday: Publish a concrete workflow. Show the result early.');
  assert.equal(result.tldr[0], 'Four uploads: mixed results.');
  assert.ok(result.recommendations.every(item => !item.includes('editorial suggestions')));
});

test('keeps the original plain-table and long-form baseline format working', () => {
  const result = parseReview(path, `## Uploads this week
| Video | Views | vs Baseline | Likes | Comments | Verdict |
|---|---|---|---|---|---|
| Original video | 34,000 | 74% | 340 | 0 | Climbing (<24h) |

(Long-form only. Baseline: median of last 10 long-form uploads = 45,902 views, 456 likes.)

## Channel-wide signal
- Keep the practical format.
## Recommended next 7 days
- Make another tutorial.
`);
  assert.equal(result.uploads.length, 1);
  assert.equal(result.uploads[0].verdict, 'Climbing');
  assert.equal(result.uploads[0].comments, 0);
  assert.equal(result.baselineViews, 45902);
  assert.equal(result.baselineLikes, 456);
  assert.deepEqual(result.channelSignal, ['Keep the practical format.']);
  assert.deepEqual(result.recommendations, ['Make another tutorial.']);
});

test('supports reordered columns, optional outer pipes and escaped or inline-code pipes', () => {
  const result = parseReview(path, `## Uploads this week
Views | Status | Title | Likes
---: | :---: | :--- | ---:
12.5K | Steady | A \\| B | 42
1.2M | Hit | \`C|D\` explained | 100
0 | Unknown | [Nested link](https://example.com/a_(b)) | 0
`);
  assert.deepEqual(result.uploads.map(row => row.title), ['A | B', 'C|D explained', 'Nested link']);
  assert.deepEqual(result.uploads.map(row => row.views), [12500, 1200000, 0]);
  assert.equal(result.uploads[2].likes, 0);
  assert.equal(result.uploads[0].comments, null);
  assert.equal(result.baselineViews, null);
});

test('missing metrics stay unknown rather than turning into zero', () => {
  const result = parseReview(path, `## Uploads this week
| Video | Views | vs Baseline | Likes | Comments | Verdict |
|:---|---:|---:|---:|---:|:---:|
| Hidden counts | — | N/A | unavailable | - | Pending |
| Real zero | 0 | 0% | 0 | 0 | Miss |
`);
  assert.deepEqual(result.uploads[0], { title: 'Hidden counts', views: null, vsBaselinePct: null, likes: null, comments: null, verdict: 'Unknown' });
  assert.deepEqual(result.uploads[1], { title: 'Real zero', views: 0, vsBaselinePct: 0, likes: 0, comments: 0, verdict: 'Miss' });
  assert.equal(result.baselineLikes, null);
});

test('accepts BOM, CRLF, single-quoted frontmatter and case-insensitive headings', () => {
  const raw = fixture.replace('channel: "Example Channel"', "channel: 'Example''s Channel'").replace('## Uploads this week', '## UPLOADS THIS WEEK ##').replace('## TL;DR', '## tl;dr').replaceAll('\n', '\r\n');
  const result = parseReview(path, '\uFEFF' + raw);
  assert.equal(result.date, '2026-09-15');
  assert.equal(result.channel, "Example's Channel");
  assert.equal(result.uploads.length, 4);
  assert.equal(result.tldr.length, 2);
});

test('accepts labeled baseline metrics and excludes fenced pseudo recommendations', () => {
  const result = parseReview(path, `## Baseline
Views median: 12,345.5; likes: 123.5.

## Recommended next 7 days
~~~text
1. This is a quoted example.
~~~
1) **Try this** next.
`);
  assert.equal(result.baselineViews, 12345.5);
  assert.equal(result.baselineLikes, 123.5);
  assert.deepEqual(result.recommendations, ['Try this next.']);
});

test('plain-text summaries remove Markdown and decode entities without exposing tags', () => {
  assert.equal(reviewPlainText('**[A &amp; B](https://example.com/a_(b))** with `code`<br>and *emphasis* &#39;ok&#39;.'), "A & B with code and emphasis 'ok'.");
  assert.equal(reviewPlainText('[Reference][one] and ![image alt](https://example.com/image.png)'), 'Reference and image alt');
});

function fakeApp(files, options = {}) {
  return { vault: {
    adapter: {
      exists: async () => options.exists ?? true,
      list: async () => ({ files, folders: [] }),
      ...(options.stat ? { stat: options.stat } : {}),
      read: options.read ?? (async () => fixture),
    },
    ...(options.cached ? { getAbstractFileByPath: options.cached } : {}),
  } };
}

test('selects the newest actual mtime instead of random same-day filename suffixes', async () => {
  const older = `${dir}/2026-09-15-review-zzzz.md`;
  const newer = `${dir}/2026-09-15-review-aaaa.md`;
  const mtimes = { [older]: Date.parse('2026-09-15T15:00:00Z'), [newer]: Date.parse('2026-09-15T16:00:00Z') };
  const app = fakeApp([older, newer, `${dir}/notes.json`], { stat: async file => ({ type: 'file', mtime: mtimes[file] }) });
  assert.equal(await findLatestReview(app), newer);
  assert.equal((await readLatestReview(app)).path, newer);
});

test('uses cached file stats when adapter stat is unavailable', async () => {
  const older = `${dir}/2026-09-15-zzzz.md`, newer = `${dir}/2026-09-15-aaaa.md`;
  const app = fakeApp([older, newer], { cached: file => ({ stat: { mtime: Date.parse(file === newer ? '2026-09-15T16:00:00Z' : '2026-09-15T15:00:00Z') } }) });
  assert.equal(await findLatestReview(app), newer);
});

test('has a deterministic filename/date fallback when stats are unavailable or tied', async () => {
  const files = [`${dir}/2026-09-14-zzzz.md`, `${dir}/2026-09-15-aaaa.md`, `${dir}/2026-09-15-zzzz.md`];
  assert.equal(await findLatestReview(fakeApp(files)), files[2]);
  assert.equal(await findLatestReview(fakeApp([...files].reverse(), { stat: async () => { throw new Error('No stat'); } })), files[2]);
  assert.equal(await findLatestReview(fakeApp(files, { stat: async () => ({ type: 'file', mtime: 1234 }) })), files[2]);
});

test('returns null for absent or empty report directories', async () => {
  assert.equal(await findLatestReview(fakeApp([], { exists: false })), null);
  assert.equal(await readLatestReview(fakeApp([`${dir}/notes.json`])), null);
});
