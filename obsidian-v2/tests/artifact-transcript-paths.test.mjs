import test from 'node:test';
import assert from 'node:assert/strict';
import {candidates} from '../runner/artifact-transcript.mjs';

const session='01a09b1a-fb81-7433-a9d7-d8333de6cbe0';
const said=(folder,file)=>`Generated images are saved to ${folder} as ${file} by default.\nThe generated image is already displayed to the user.`;
const windows=(...parts)=>parts.join(String.fromCharCode(92));

test('the saved image is picked out of "saved to <folder> as <file>" on every kind of path',()=>{
 const cases=[
  [windows('C:','Users','me','.codex','generated_images',session),windows('C:','Users','me','.codex','generated_images',session,'exec-current.png')],
  [`C:/Users/me/.codex/generated_images/${session}`,`C:/Users/me/.codex/generated_images/${session}/exec-current.png`],
  [`/Users/me/.codex/generated_images/${session}`,`/Users/me/.codex/generated_images/${session}/exec-current.png`],
  [`/Users/me/My Files/.codex/generated_images/${session}`,`/Users/me/My Files/.codex/generated_images/${session}/exec current.png`],
  [`/home/me/.codex/generated_images/${session}`,`/home/me/.codex/generated_images/${session}/exec-current.webp`],
  // A Windows folder name may end in white space (here a non-breaking space) before the next slash: drive-letter paths keep the old rule.
  [`C:/Users/Team${String.fromCharCode(160)}/.codex/generated_images/${session}`,`C:/Users/Team${String.fromCharCode(160)}/.codex/generated_images/${session}/exec-current.png`],
  [`C:/Users/My Team /.codex/generated_images/${session}`,`C:/Users/My Team /.codex/generated_images/${session}/exec-current.png`],
 ];
 for(const [folder,file] of cases)assert.deepEqual(candidates(said(folder,file),session),[{path:file,open:true}],file);
});

test('another session\'s image is never picked up',()=>{
 assert.deepEqual(candidates(said('/Users/me/.codex/generated_images/other','/Users/me/.codex/generated_images/other/x.png'),session),[]);
});
