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
  'Write a LinkedIn post based on that',
  'Draft a tweet about that report',
  'On that mic note, add a quick budget pick under a hundred bucks',
 ]) assert.equal(refersBack(text), true, text);
 for (const text of [
  "And hey, while you're doing that, can you give me a quick one-pager on this Opus 5.6 stuff",
  'Research RubyGems',
  'Make me a one page explainer of how black holes form',
  'Research what creators are posting for Black Friday and put it in my inbox',
  'What is the weather like in Austin',
  'Write a LinkedIn post about the Live upgrade',
  'Build a diagram of how Live hands off work',
  // Neon review, 2026-11-26: a pronoun before a new noun phrase names new work.
  'Write a three-bullet note about this new voice standby feature and save it to my inbox',
  'Draft a one-pager on that pricing model',
  'Check the weather report for Austin',
 ]) assert.equal(refersBack(text), false, text);
});

test('“also start a new task” is new work, even when what follows ends in “save it”', async () => {
 const {newTaskIntent}=await import('../shared/new-task-intent.mjs');
 for(const text of ['Also start a new task. Write a three-line note and save it','Also start a new task Write a three-line note and save it']){
  assert.equal(refersBack(text),false,text);
  assert.equal(newTaskIntent(text)?.payload,'Write a three-line note and save it',text);
 }
});
