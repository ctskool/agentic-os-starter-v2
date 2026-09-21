import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
import {selectSpokenAnswer,selectCompletionAnswer} from '../runner/spoken-answer.mjs';
import {spokenFlow} from '../runner/speech-service.mjs';
const {speechText,completionSpeech}=createJiti(import.meta.url)('../shared/speech-text.ts');
const detail='The diagram contains background and supporting discussion. '.repeat(25);
const quick=text=>speechText(spokenFlow(selectSpokenAnswer(text,{mode:'reply'})));

for(const mode of ['quick','completion'])for(const qualification of [
 'The upload failed, so the report is not available online.',
 'The result has not been independently verified.',
 'Publishing still requires approval.',
 'Only the draft is saved; the upload is pending.',
 'The claim may be incorrect.',
 'The instructions work unless the source file has changed.',
 'The quoted price excludes tax, but the final charge could be higher.',
])test(`${mode} preserves the complete late qualification: ${qualification}`,()=>{
 const written='I created the report.\n\n'+detail+'\n\n'+qualification;
 const heard=mode==='quick'?quick(written):completionSpeech('',selectCompletionAnswer({}, {text:written}));
 assert.ok(heard.includes(qualification),heard);assert.ok(heard.length<=(mode==='quick'?880:420));
 assert.ok(written.endsWith(qualification));
});

test('shortening keeps sentence order and context of a qualified opening',()=>{
 const input='I could not finish the upload. The local draft is ready.\n\n'+detail;
 assert.equal(selectSpokenAnswer(input),'I could not finish the upload. The local draft is ready.');
});

test('a long indivisible sentence never loses a final negation',()=>{
 const input='I checked '+ 'every paragraph and supporting citation, '.repeat(40)+'but I cannot verify this account.';
 assert.equal(quick(input),'The full answer is in the written reply.');
 assert.equal(speechText(input,420),'The full answer is in the written reply.');
});

test('too many qualifications use an honest pointer without claiming successful work',()=>{
 const written=Array.from({length:25},(_,i)=>`Source ${i+1} could not be independently verified against the available evidence.`).join(' ');
 assert.equal(quick(written),'The full answer is in the written reply.');
 assert.doesNotMatch(quick(written),/done|completed|ready/);
});

test('the sentence preceding a dependent qualification is retained',()=>{
 const context='The source presents a new attribution.';
 const written='The draft is ready. '+detail+context+' This has not been verified.';
 const heard=quick(written);assert.ok(heard.includes(context+' This has not been verified.'));
});

test('a reformatted quick answer is stable through repeated client and bridge limits',()=>{
 const input='The draft is ready. '+detail+'The upload failed.';
 const once=quick(input),twice=quick(once);assert.equal(twice,once);assert.match(twice,/The upload failed\./);
});
test('process jargon never erases a parenthetical failure or deliverable caveat',()=>{
 for(const text of ['The report is drafted (the deliverable was not saved).','The run finished (exit code 1, upload failed).','The preview is ready (the autonomous upload is still pending).']){
  const spoken=speechText(text);
  assert.match(spoken,/not saved|upload failed|still pending/);
 }
 assert.equal(speechText('The preview is ready (headless).'),'The preview is ready.');
});
