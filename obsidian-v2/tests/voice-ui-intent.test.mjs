import test from 'node:test';
import assert from 'node:assert/strict';
import {parseUiIntent,sameUiAction} from '../runner/voice-ui-intent.mjs';
import {rules} from '../runner/voice-router.mjs';

// The parser is consulted only after Jev has said "this is a UI action". These
// tests treat Jev as confidently wrong: whatever the utterance, the parser alone
// must refuse anything that is not one plain, fully understood workspace command.
const tables={WEB_TARGETS:rules.WEB_TARGETS,COMMAND_ALLOW:rules.COMMAND_ALLOW};
const parse=(say,options={})=>parseUiIntent(say,{tables,...options});
const validated=(say,candidate)=>rules.validateRouted(candidate,'luna',say)?.obsidian;
const web=(name,where)=>({op:'web',...rules.WEB_TARGETS[name],...(where?{where}:{})});
const command=id=>({op:'command',id,label:rules.COMMAND_ALLOW[id]});

const accepted=[
 ['Close this tab please',command('workspace:close')],
 ['Can you close the current tab?',command('workspace:close')],
 ['Switch to graph view',command('graph:open')],
 ['Show me the vault graph',command('graph:open')],
 ['Open up a terminal for me',command('terminal:open-terminal.default.root')],
 ['Hey Jarvis, launch the terminal',command('terminal:open-terminal.default.root')],
 ['Toggle the left sidebar please',command('app:toggle-left-sidebar')],
 ['Toggle my right side bar',command('app:toggle-right-sidebar')],
 ['Go back please',command('app:go-back')],
 ['Go forward',command('app:go-forward')],
 ['Split the screen vertically',command('workspace:split-vertical')],
 ['Split down',command('workspace:split-horizontal')],
 ['Show YouTube Studio in a split',web('youtube-studio','split')],
 ['Can you pull Gmail up on the right side?',web('gmail','right-sidebar')],
 ['Display google mail over on the left',web('gmail','left-sidebar')],
 ['Open gmail',web('gmail')],
 // The calendar lives in the right sidebar unless a side was spoken.
 ['Show my calendar',web('calendar','right-sidebar')],
 ['Bring up my google calendar on the left',web('calendar','left-sidebar')],
 ['Put up my daily note side by side',{op:'daily-note',where:'split'}],
 ["Display today's daily note on the right hand side",{op:'daily-note',where:'right-sidebar'}],
];
test('every row of the closed vocabulary parses, and the unchanged validator returns exactly the expected action',()=>{
 for(const [say,expect] of accepted){
  const parsed=parse(say);
  assert.equal(parsed.refused,undefined,`${say} -> ${parsed.refused}`);
  assert.deepEqual(parsed.expect,JSON.parse(JSON.stringify(expect)),say);
  assert.equal(parsed.candidate.tier,2);assert.equal(parsed.candidate.reply,'');
  assert.ok(sameUiAction(validated(say,parsed.candidate),parsed.expect),`validator changed: ${say} -> ${JSON.stringify(validated(say,parsed.candidate))}`);
 }
});
test('anything that is not one plain workspace command is refused, however sure Jev was',()=>{
 const refused=[
  // Could do the opposite of what was asked, depending on the current state.
  'Hide the right sidebar please','Collapse the left sidebar','Show the left sidebar','Close the right sidebar','Expand the right sidebar',
  // Content, not a workspace control.
  'Display this graph.','Open the graph','Show that terminal','Make it bigger.','Check off the second priority.','Close the deal tab notes','Open the calendar note',
  // Placements the validator would drop or replace, and placements on commands.
  'Show my calendar in a new tab','Show gmail in a new window','Close this tab on the right','Open the terminal on the left','Toggle the left sidebar in a split',
  // The command cannot deliver what the words promise.
  'Move Gmail to the right','Move the calendar to the left sidebar','Go forward to the previous note','Go back to the last thing I had open.','Go back to the previous version of the diagram',
  // Negation, conditions, questions, second clauses, second sentences.
  "Don't close this tab",'Do not open gmail','Close this tab after I save','Open gmail when you are done','How do I open the terminal','Can you tell me what graph view is',
  'Close this tab and open gmail','Open gmail or the calendar','Open gmail. Then close it.','Open gmail then youtube studio',
  // Unknown surfaces and free text.
  'Open settings','Search the vault for solar','Open mattpocock/skills','Open the dashboard','Open https://mail.google.com',
  '','   ',
 ];
 for(const say of refused){const parsed=parse(say);assert.ok(parsed.refused,`${JSON.stringify(say)} parsed as ${JSON.stringify(parsed.candidate)}`);assert.equal(parsed.candidate,undefined)}
 assert.equal(parse(null).refused,'no-transcript');assert.equal(parse('open gmail '.repeat(30)).refused,'length');
});
test('surfaces whose words could name the selected conversation\'s content abstain while one is selected',()=>{
 for(const say of ['Display the graph view','Show the terminal please','Show my calendar','Open my daily note on the right']){
  assert.equal(parse(say).refused,undefined,say);
  assert.equal(parse(say,{conversationSelected:true}).refused,'conversation-selected',say);
 }
 // These words cannot mean a conversation's content.
 for(const say of ['Open gmail','Show YouTube Studio in a split','Toggle the left sidebar','Close this tab','Go back','Split right'])assert.equal(parse(say,{conversationSelected:true}).refused,undefined,say);
});
test('the expectation is built from the validator\'s own tables and fails closed without them',()=>{
 assert.equal(parseUiIntent('Open gmail',{tables:{}}).refused,'unknown-target');
 assert.equal(parseUiIntent('Close this tab',{tables:{WEB_TARGETS:rules.WEB_TARGETS}}).refused,'unknown-command');
 assert.equal(parseUiIntent('Open gmail',{tables:{WEB_TARGETS:{gmail:{url:'https://example.test',label:'gmail'}}}}).expect.url,'https://example.test');
});
test('post-validation equality rejects any action the validator changed, dropped or replaced',()=>{
 const parsed=parse('Open gmail on the left');
 assert.ok(sameUiAction({op:'web',url:'https://mail.google.com',label:'gmail',where:'left-sidebar'},parsed.expect));
 assert.ok(sameUiAction({where:'left-sidebar',label:'gmail',url:'https://mail.google.com',op:'web'},parsed.expect),'key order is irrelevant');
 for(const changed of [
  {op:'web',url:'https://mail.google.com',label:'gmail'},
  {op:'web',url:'https://mail.google.com',label:'gmail',where:'right-sidebar'},
  {op:'web',url:'https://calendar.google.com',label:'google calendar',where:'left-sidebar'},
  {op:'web',url:'https://mail.google.com',label:'gmail',where:'left-sidebar',extra:true},
  {op:'open-note',query:'gmail'},null,undefined])assert.equal(sameUiAction(changed,parsed.expect),false,JSON.stringify(changed));
 // The case that motivated the check: the validator has no "tab" placement and
 // would put the calendar in the right sidebar instead.
 const tab=rules.validateRouted({tier:2,reply:'',obsidian:{op:'web',target:'calendar',where:'tab'}},'luna','Show my calendar in a new tab')?.obsidian;
 assert.equal(tab.where,'right-sidebar');assert.equal(sameUiAction(tab,{op:'web',...rules.WEB_TARGETS.calendar,where:'tab'}),false);
});
