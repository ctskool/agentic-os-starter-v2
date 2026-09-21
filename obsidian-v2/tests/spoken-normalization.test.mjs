import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const {normalizeForSpeech, scrubRunSummary} = await createJiti(import.meta.url).import('../shared/spoken-text.ts');
const normalize = text => normalizeForSpeech(scrubRunSummary(text));

test('spoken dollars preserve cents and the full ungrouped amount', () => {
 for (const [input, output] of [
  ['$0.75', 'seventy five cents'], ['$.75', 'seventy five cents'], ['$0.01', 'one cent'],
  ['$4200.50', 'four thousand two hundred dollars and fifty cents'],
  ['$4,200.50', 'four thousand two hundred dollars and fifty cents'], ['$1.01', 'one dollar and one cent'],
  ['$0.00', 'zero dollars'], ['$1.00', 'one dollar'], ['$0.00025', 'zero point zero zero zero two five dollars'],
  ['-$0.75', 'minus seventy five cents'], ['$-4,200.50', 'minus four thousand two hundred dollars and fifty cents'],
 ]) assert.equal(normalize(input), output);
});

test('large cash values never silently lose precision through JavaScript numbers', () => {
 assert.equal(normalize('$9007199254740993'), 'nine zero zero seven one nine nine two five four seven four zero nine nine three dollars');
 assert.equal(normalize('$200M and $1.25B'), 'two hundred million dollars and one point two five billion dollars');
 assert.equal(normalize('$12345.6789'), 'twelve thousand three hundred forty five point six seven eight nine dollars');
});

test('counts, ports, tickets and long numeric identifiers are exact by default', () => {
 const input = 'Port 3219, ticket 123456, 14606 views, 1437.5 milliseconds, ID 9007199254740993, and 2026.';
 assert.equal(normalize(input), input);
 assert.equal(normalize('14,166 views and 1,437,000 subscribers.'), '14166 views and 1437000 subscribers.');
 assert.equal(normalize('ID abc123456, 0x123456, release v0.3.39, user_id and build 2026-09-14-preview.'), 'ID abc123456, 0x123456, release v0.3.39, user_id and build 2026-09-14-preview.');
});

test('times, explicit media durations and ratios do not share a guessed clock conversion', () => {
 assert.equal(normalize('Duration 01:30; elapsed 01:02:03.'), 'Duration one minute and thirty seconds; elapsed one hour and two minutes and three seconds.');
 assert.equal(normalize('The clip is 01:30 (mm:ss).'), 'The clip is one minute and thirty seconds.');
 assert.equal(normalize('At 13:00, then at 9:05 and 1:00 PM.'), 'At 1 PM, then at 9 oh 5 and 1 PM.');
 assert.equal(normalize('Aspect ratio 16:9, and 01:30 ratio.'), 'Aspect ratio 16 to 9, and 01 to 30 ratio.');
 assert.equal(normalize('The unlabeled value is 01:30 or 16:9.'), 'The unlabeled value is 01:30 or 16:9.');
 assert.equal(normalize('Invalid time 29:30 PM.'), 'Invalid time 29:30 PM.');
});

test('unambiguous ISO dates become natural while ambiguous and invalid dates remain literal', () => {
 assert.equal(normalize('On 2026-09-14, use the 2024-02-29 entry.'), 'On September 14, 2026, use the February 29, 2024 entry.');
 assert.equal(normalize('Dates 09/10/2026 and 2026-02-30 are unchanged.'), 'Dates 09/10/2026 and 2026-02-30 are unchanged.');
});

test('known model versions and unambiguous acronyms are pronounceable without rewriting unknown names', () => {
 assert.equal(normalize('GPT-5.6-Luna uses the CLI and API for AI, with a GPU.'), 'G P T five point six Luna uses the C L I and A P I for A I, with a G P U.');
 assert.equal(normalize('gpt-6-astra, Claude Code, Haiku, Qwen3 and v0.3.39.'), 'G P T six Astra, Claude Code, Haiku, Qwen3 and v0.3.39.');
 assert.equal(normalize('Download the PDF; 120ms and 2GB.'), 'Download the P D F; 120 milliseconds and 2 gigabytes.');
 assert.equal(normalize('The MCP tool reports 2x performance and a 5–10% improvement. Keep variable2x and 16:9.'), 'The M C P tool reports 2 times performance and a 5 to 10 percent improvement. Keep variable2x and 16:9.');
});

test('operators, warnings and negation survive Markdown and emoji cleanup', () => {
 assert.equal(normalize('⚠️ Do **not** proceed: x != 0, x <= 2, y >= -1, 3 * 4, 8 ÷ 2, and 5 ± 0.2.'), 'Warning. Do not proceed: x does not equal 0, x is at most 2, y is at least -1, 3 times 4, 8 divided by 2, and 5 plus or minus 0.2.');
 assert.equal(normalize('It is -5°C with 40% humidity. x < 3 and y > 0.'), 'It is -5 degrees Celsius with 40 percent humidity. x is less than 3 and y is greater than 0.');
 assert.equal(normalize('❌ Not saved. 🚀 A draft exists. ✅ Checked.'), 'No. Not saved. A draft exists. Check. Checked.');
 assert.equal(normalize('Number → section → word → letter.'), 'Number → section → word → letter.');
});

test('Obsidian and HTML markup keep the readable words including joined inline words', () => {
 assert.equal(normalize('See [[reports/brief#Findings|today’s findings]] and [[News.md]].'), 'See today’s findings and News.');
 assert.equal(normalize('<p>This is <strong>not</strong> verified &amp; remains un<em>confirmed</em>.</p>'), 'This is not verified & remains unconfirmed.');
 assert.equal(normalize('<!-- hidden --><style>.x{color:red}</style><script>alert(1)</script>Keep <span>the warning</span>.'), 'Keep the warning.');
 assert.equal(normalize('x &lt; 3; y &gt; 2; don&#39;t publish.'), "x is less than 3; y is greater than 2; don't publish.");
});

test('citation chrome is omitted while arrays, choice labels and meaningful numeric content survive', () => {
 assert.equal(normalize('The source remains uncertain [1][2]. Another claim<sup class="reference">3</sup> is unverified.[^note]'), 'The source remains uncertain. Another claim is unverified.');
 assert.equal(normalize('Vector [1, 2], index [1]. Option [2]. [3]'), 'Vector [1, 2], index [1]. Option [2]. [3]');
 assert.equal(normalize('This is unchanged【1†source】, pending verification.'), 'This is unchanged, pending verification.');
 assert.equal(normalize('x[1] and x<sup>2</sup> are mathematical expressions. Choose option: [2].'), 'x[1] and x to the power of 2 are mathematical expressions. Choose option: [2].');
});

test('normalizing twice in client and bridge is stable and does not modify the written input', () => {
 const cases = [
  '$0.75, $4200.50, $1.25B, -$1.01 and $0.00025.',
  '⚠️ The **claim** in [[brief|the brief]] is not verified [1][2].',
  'At 13:00 on 2026-09-14, gpt-5.6-luna uses the CLI.',
  'Duration 01:30; ratio 16:9; port 3219; ticket 123456; release v0.3.39.',
  'x != 3; y &lt; 2; value 5 ± 0.1, and 3 * 4.',
  '<p>The result remains un<em>confirmed</em>.<sup>1</sup></p>',
 ];
 for (const input of cases) {
  const original = input, first = normalize(input);
  assert.equal(normalize(first), first, input);
  assert.equal(input, original);
 }
});
