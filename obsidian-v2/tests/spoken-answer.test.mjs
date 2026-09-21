import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
import {selectSpokenAnswer, selectCompletionAnswer, SPOKEN_REPLY_STYLE, WORKER_SPOKEN_STYLE} from '../runner/spoken-answer.mjs';
const {completionSpeech} = await createJiti(import.meta.url).import('../shared/speech-text.ts');

test('worker style composes speech in the existing response and defers to exact formats', () => {
 assert.match(WORKER_SPOKEN_STYLE, /Exact-output requests and existing workflow deliverable formats take precedence/);
 assert.match(WORKER_SPOKEN_STYLE, /another tool or model call/);
 assert.match(SPOKEN_REPLY_STYLE, /preserve important uncertainty/);
});

test('long result speaks its conversational opening rather than technical detail', () => {
 const opening = 'I created the cipher graphic. It shows how the references map to a letter, but the historical attribution remains uncertain.';
 const result = opening + '\n\n## Design notes\n\n' + 'The layout places the numbered stages across the page with labels and supporting context. '.repeat(12);
 assert.equal(selectSpokenAnswer(result), opening);
});

test('actual cipher flow remains meaningful input for the existing arrow-to-speech formatter', () => {
 assert.equal(selectSpokenAnswer('## How it works\n\nNumber → book section → word → letter.'), 'Number → book section → word → letter.');
});

test('short answers preserve negation, qualifications, and requested prose list facts', () => {
 const input = 'This does not prove the cipher is solved.\n\n- The first claim is unverified.\n- The second has independent support.\n- The third needs the original source.';
 assert.equal(selectSpokenAnswer(input), 'This does not prove the cipher is solved. The first claim is unverified. The second has independent support. The third needs the original source.');
});

test('reply mode preserves every item and fact from a long saved lookup', () => {
 const lines = Array.from({length: 12}, (_, i) => `${i + 1}. Story ${i + 1} has ${i + 20} points and remains unverified`);
 const output = selectSpokenAnswer('These are from the saved morning brief, not a live ranking.\n\n' + lines.join('\n'), {mode: 'reply'});
 assert.match(output, /^These are from the saved morning brief, not a live ranking\./);
 for (let i = 0; i < lines.length; i++) assert.ok(output.includes(`Story ${i + 1} has ${i + 20} points and remains unverified.`));
});

test('frontmatter, headings, fenced code and tables never become invented prose', () => {
 const input = '\uFEFF---\r\ndate: 2026-09-14\r\nstatus: done\r\n---\r\n# A report\r\n\r\nThe first source supports the claim.\r\n\r\n| Name | Result |\r\n| --- | --- |\r\n| Example | Unverified |\r\n\r\n```js\r\nconsole.log("success")\r\n```\r\n\r\nThe second source does not.';
 const before = input;
 assert.equal(selectSpokenAnswer(input), 'The first source supports the claim. The second source does not.');
 assert.equal(input, before);
});

test('structural-only results use a neutral pointer, not a success claim', () => {
 for (const text of ['```js\nreturn "done";\n```', '| Subject | Result |\n| --- | --- |\n| A | B |', 'Name | Status\n--- | ---\nJob | Done', '# Finished\n\n![Graphic](artifacts/graphic.png)', 'SAVED C:\\vault\\report.md', 'C:\\vault\\graphic.png']) {
  assert.equal(selectSpokenAnswer(text), 'The detailed result is in the written reply.');
 }
});

test('a direct failure late in a long answer is retained beside the opening', () => {
 const opening = 'I prepared a draft graphic.';
 const result = opening + '\n\n' + 'The chart depicts each stage in the historical account. '.repeat(15) + '\n\nHowever, I could not verify the claimed solution.';
 assert.equal(selectSpokenAnswer(result), opening + ' However, I could not verify the claimed solution.');
});

test('an approval requirement late in a long answer is retained', () => {
 const result = 'The draft is ready.\n\n' + 'The labels explain the supporting evidence. '.repeat(20) + '\n\nI need your approval before publishing it.';
 assert.equal(selectSpokenAnswer(result), 'The draft is ready. I need your approval before publishing it.');
});

test('common first-person limitation contractions are retained without interpreting news subjects', () => {
 for (const limitation of ["I don't have access to the source.", "I wasn't able to confirm the claim.", "We aren't certain about its origin.", "I haven’t verified the dates."]) {
  const input = 'I prepared the layout.\n\n' + 'The diagram uses labels for each stage of the process. '.repeat(15) + '\n\n' + limitation;
  assert.equal(selectSpokenAnswer(input), 'I prepared the layout. ' + limitation);
 }
});

test('a first-person failure at the beginning is never replaced with done', () => {
 const first = "I couldn't finish the graphic because the image tool is unavailable.";
 assert.equal(selectSpokenAnswer(first + '\n\n' + 'The intended design includes several stages and explanatory labels. '.repeat(15)), first);
});

test('reported news qualifications retain their actual subject instead of becoming a fabricated task failure', () => {
 const input = 'I created the briefing graphic.\n\n' + 'The report covers several independent research announcements. '.repeat(20) + "\n\nFable couldn't confirm the third historical claim. I found that researchers couldn't reproduce the second result.";
 assert.equal(selectSpokenAnswer(input), "I created the briefing graphic. Fable couldn't confirm the third historical claim. I found that researchers couldn't reproduce the second result.");
});

test('quoted links keep their human labels and code names remain meaningful', () => {
 assert.equal(selectSpokenAnswer('The **draft** uses `renderScene` and cites [the original report](https://example.com/report).'), 'The draft uses renderScene and cites the original report.');
});

test('selection is idempotent and leaves full source content untouched', () => {
 for (const input of ['# Result\n\nA short answer.\n\n- First fact\n- Second fact', 'The draft is ready.\n\n' + 'Supporting evidence appears in the report. '.repeat(20) + '\n\nI cannot verify its attribution.', '```json\n{"status":"ok"}\n```']) {
  const original = input;
  const selected = selectSpokenAnswer(input);
  assert.equal(selectSpokenAnswer(selected), selected);
  assert.equal(input, original);
 }
});

test('an overlong sentence falls back without cutting its final qualification', () => {
 const input = 'This summary ' + 'carefully explains '.repeat(60) + 'the result, but does not establish historical certainty.';
 assert.equal(selectSpokenAnswer(input), 'There are important limitations in the result. Please read the full written reply.');
 assert.equal(selectSpokenAnswer(input, {mode: 'reply'}), input);
});

test('an authoritative workflow write failure overrides optimistic worker speech', () => {
 const record = {workflowCompleted: true, workflowStatus: 'error', error: 'The destination changed while this task ran. Proposed output saved separately; newer edits were preserved.'};
 assert.equal(selectCompletionAnswer(record, {text: 'I finished and saved the complete report.'}), 'The workflow did not complete. The destination changed while this task ran. Proposed output saved separately; newer edits were preserved.');
 assert.equal(selectCompletionAnswer({...record, error: 'BLOCKED: The calendar connector is unavailable.'}, {text: 'Done.'}), 'The workflow did not complete. The calendar connector is unavailable.');
});

test('a previous workflow error does not mask a new successful unrelated answer', () => {
 assert.equal(selectCompletionAnswer({workflowCompleted: true, workflowStatus: 'error', error: null}, {text: 'The draft uses the revised headline.'}), 'The draft uses the revised headline.');
});

test('actual completion composition protects a late caveat beyond the old 420-character cutoff', () => {
 const opening = 'I prepared a graphic with ' + 'carefully arranged explanatory labels, '.repeat(10) + 'and a title.';
 const caveat = 'I could not verify the claimed solution.';
 const turn = {text: opening + '\n\n' + 'The supporting report describes the stages. '.repeat(20) + '\n\n' + caveat};
 const spoken = completionSpeech('', selectCompletionAnswer({}, turn));
 assert.ok(spoken.includes(caveat));
 assert.ok(spoken.length <= 420);
 assert.ok(!spoken.includes('The full answer is in the written reply.'));
 assert.ok(!spoken.includes('carefully arranged'));
});

test('actual composition budgets expanded numbers before preserving approval requirements', () => {
 const opening = 'I compared ' + Array.from({length: 12}, (_, i) => `$${201 + i}M`).join(', ') + ' across the scenarios.';
 const caveat = 'I need your approval before publishing this draft.';
 const spoken = completionSpeech('', selectCompletionAnswer({}, {text: opening + '\n\n' + caveat}));
 assert.ok(spoken.includes(caveat));
 assert.ok(spoken.length <= 420);
 assert.ok(!spoken.includes('The full answer is in the written reply.'));
});

test('an indivisibly long limitation gets an explicit qualified pointer rather than optimistic speech', () => {
 const limitation = 'I cannot confirm ' + 'the independently dated and attributed historical evidence, '.repeat(15) + 'so the result remains unverified.';
 const spoken = completionSpeech('', selectCompletionAnswer({}, {text: 'The draft is ready.\n\n' + limitation}));
 assert.equal(spoken, 'There are important limitations in the result. Please read the full written reply.');
});

test('actual composition protects authoritative failure even with an extremely long error reason', () => {
 const record = {workflowCompleted: true, workflowStatus: 'error', error: 'The destination changed. ' + 'The conflicting content contains extensive detail. '.repeat(30)};
 const spoken = completionSpeech('', selectCompletionAnswer(record, {text: 'I finished and saved the report.'}));
 assert.equal(spoken, 'The workflow did not complete, so I cannot confirm that the result was saved.');
 assert.ok(!spoken.includes('I finished'));
 assert.ok(!spoken.includes('The full answer is in the written reply.'));
});

test('valid raw JSON artifacts get a neutral pointer without changing their bytes', () => {
 for (const input of ['{\r\n  "status": "ok",\r\n  "data": [1, 2]\r\n}', '[{"name":"first","verified":false}]']) {
  const original = input;
  assert.equal(selectSpokenAnswer(input), 'The detailed result is in the written reply.');
  assert.equal(input, original);
 }
 assert.equal(selectSpokenAnswer('{draft} is a placeholder, not an approved result.'), '{draft} is a placeholder, not an approved result.');
 assert.equal(selectSpokenAnswer('The response contains {"status":"ok"}, but I have not verified it.'), 'The response contains {"status":"ok"}, but I have not verified it.');
 assert.equal(selectSpokenAnswer('42'), '42');
});
