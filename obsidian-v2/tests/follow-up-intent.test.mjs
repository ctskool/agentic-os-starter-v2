import test from 'node:test';
import assert from 'node:assert/strict';
import {refersBack} from '../runner/follow-up-intent.mjs';

test('a request that points back at the task in front of it is told apart from new work', () => {
 for (const text of [
  'Add a section on its history',
  'Make it shorter',
  'make that a PDF',
  'Tighten the introduction',
  'Change the colors to blue',
  'can you also add sources to the report',
  'keep going',
  'Actually, continue',
  'send it to my inbox when it’s done',
  'fix the title',
  'Is it done? Then add a summary at the top',
  'Write a summary of it for LinkedIn',
  'Make the second half shorter and punchier',
  'Give it a stronger closing line',
 ]) assert.equal(refersBack(text), true, text);
 for (const text of [
  "And hey, while you're doing that, can you give me a quick one-pager on this Opus 5.6 stuff",
  'Research RubyGems',
  'Make me a one page explainer of how black holes form',
  'Research what creators are posting for Black Friday and put it in my inbox',
  'What is the weather like in Austin',
  'Write a LinkedIn post about the Live upgrade',
  'Build a diagram of how Live hands off work',
 ]) assert.equal(refersBack(text), false, text);
});
