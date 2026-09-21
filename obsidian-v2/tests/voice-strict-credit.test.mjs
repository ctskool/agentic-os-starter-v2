import test from 'node:test';
import assert from 'node:assert/strict';
import {attempted} from '../scripts/voice-strict-credit.mjs';

// Qualification credit only. A trap counts toward a kind's denominator when the
// sentence was an attempt at that kind of command, never because a word occurs in it.
test('a trap earns credit only when the sentence starts with a complete command phrase of that kind',()=>{
 for(const say of ['Can I see how the content backfill plan is structured?','Do not pop open the content backfill plan.','Can you have a look at the skoot CRM playbook?','I wanna see the retention cliff patterns note.','Hey Jarvis, pull the streak plan up','Could we take a quick look at the weekly review from this Friday','Pop open that thing you made.','Lemme see the deep research'])assert.equal(attempted('open',say),true,say);
 // Codex, build rounds 2 and 3: unrelated questions and half phrases.
 for(const say of ['What do you see as the main risk?','How should I bring more leads into my business?','Can I get advice on pricing?','Can I have a sandwich?','May I take a break?','I want to get better at thumbnails','Let me have a minute','Showcase the calendar','Pull my metrics','Bring more leads'])assert.equal(attempted('open',say),false,say);
 for(const say of ['Hide the right sidebar.','Close the deal tab notes.',"Don't close this tab.",'Toggle the sidebar.','Move Gmail to the right.','Go back to the previous note.','Split the bill right down the middle.','Show my calendar in a new tab'])assert.equal(attempted('ui',say),true,say);
 for(const say of ['How do I toggle the left sidebar?','Make it bigger.','What should I show my sponsor on the calendar?','Open the pod bay doors','Start a new video idea','Close the deal'])assert.equal(attempted('ui',say),false,say);
 assert.equal(attempted('other','Open Gmail'),false);assert.equal(attempted('open',null),false);
});
