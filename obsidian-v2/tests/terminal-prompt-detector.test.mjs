import test from 'node:test';
import assert from 'node:assert/strict';
import {TerminalPromptDetector} from '../runner/terminal-transport.mjs';

const plan='Plan:\n1. Review the codebase\n2. Approve the design\nPress enter to confirm the plan in your head.\n';
const hooks='\x1b]0;codex\x07\x1b[1mHooks need review\x1b[0m\r\n7 hooks are new or changed.\r\nHooks can run outside the sandbox after you trust them.\r\n› 1. Review hooks\r\n  2. Trust all and continue\r\n  3. Continue without trusting (hooks won\'t run)\r\n\r\n  Press enter to confirm or esc to go back\r\n';
function feed(text,size){const detector=new TerminalPromptDetector(),reasons=[];for(let at=0;at<text.length;at+=size){const reason=detector.update(text.slice(at,at+size));if(reason)reasons.push(reason)}return {detector,reasons}}
test('ordinary review/approval lists never signal input, even at partial line boundaries',()=>{
 for(const text of [plan,'Would you like to run through this plan?\n'+plan,'The command requires approval later.\n1. Review the codebase\n2. Approve the design\n','Documentation: Hooks need review means you should inspect configuration.\n1. Review hooks\n2. Trust all and continue\n'])for(const size of [1,7,text.length])assert.deepEqual(feed(text,size).reasons,[]);
});
test('hooks, trust and approval menus remain detectable across fragmented ANSI, with a changed selection or plain menu',()=>{
 const prompts=[
  [hooks,/review its hooks/],
  ['\x1b[1mDo you trust the contents of this directory?\x1b[0m\n› 1. Yes, continue\n  2. No, quit\n',/trust this workspace/],
  ['Would you like to run this command?\n  1. Yes\n❯ 2. No\n',/your approval/],
  ['Would you like to run this command?\n1. Yes\n2. No\nPress enter to confirm\n',/your approval/]
 ];
 for(const [text,expected] of prompts)for(const size of [1,7,text.length]){const {detector,reasons}=feed(text,size);assert.ok(reasons.some(reason=>expected.test(reason)));assert.equal(detector.update('\x1b[2J\x1b[HWelcome back. Ready.\n'),null)}
});

const actionHeaders=[
 'Would you like to make the following edits?',
 'Would you like to grant these permissions?',
 'Would you like to send input to terminal 12?',
 'Approve app tool call?'
];
for(const header of actionHeaders)test(`Codex action approval is detected: ${header}`,()=>{
 const choices=header.startsWith('Approve')?['Approve','Approve for me','Reject']:['Yes','Allow and don\'t ask me again','No, and tell Codex what to do differently'];
 for(const selected of [0,1,2]){
  const menu=choices.map((choice,index)=>`${index===selected?'›':' '} ${index+1}. ${choice}`).join('\r\n');
  const screen=`\x1b[1m${header}\x1b[0m\r\n${menu}\r\nPress enter to confirm or esc to go back\r\n`;
  for(const size of [1,7,screen.length]){
   const {detector,reasons}=feed(screen,size);
   assert.ok(reasons.some(reason=>/waiting for your approval/.test(reason)));
   assert.equal(detector.update('\x1b[2J\x1b[HAction complete.\n'),null);
  }
 }
});
test('action-header mentions and header-only output cannot manufacture an approval menu',()=>{
 for(const header of actionHeaders){
  const cases=[header+'\n',header+'\n1. Review the proposal\n2. Edit the document\n',`Documentation: ${header}\n› 1. Yes\n  2. No\n`,`> ${header}\n› 1. Yes\n  2. No\n`];
  for(const text of cases)for(const size of [1,7,text.length])assert.deepEqual(feed(text,size).reasons,[]);
 }
});
