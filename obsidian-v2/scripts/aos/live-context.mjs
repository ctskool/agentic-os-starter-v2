// node aos.mjs live-context: see and change what a Live call reads when it starts (runner/live/context.mjs).
// The member's coding agent runs these on their behalf during setup and later ("add my goals note to Live").
import fs from 'node:fs';
import {vaultPath} from '../../runner/core.mjs';
import {withFileLock} from '../../runner/file-lock.mjs';
import {readVoicePrefs} from '../../runner/voice-prefs.mjs';
import {ABOUT_MAX_BYTES,readAboutMe} from '../../runner/live/about.mjs';
import {LIVE_CONTEXT_FILE,LIVE_SECTIONS,MAX_NOTES,checkNotePath,cleanLabel,readLiveContext,resolveNotes,writeLiveContext} from '../../runner/live/context.mjs';
import {configuredVaultPath,layout} from './services.mjs';

const HELP=`What a Live call reads when it starts

  live-context show [--full]              what a call reads; --full prints it exactly as sent
  live-context add <path> [--label "…"]   add one of your notes, or a report folder (its newest note is read)
  live-context remove <path or number>    take a note off the list
  live-context section <name> on|off      turn a built-in part on or off: ${Object.keys(LIVE_SECTIONS).join(', ')}
  live-context reset                      back to the starting setup: every built-in part on, no notes

Everything a call reads goes to OpenAI when the call starts. About me has its own place: ask your
agent to "update my About me", or see it with \`node aos.mjs about show\`.
`;
const kb=bytes=>bytes<1000?`${bytes} bytes`:`${(bytes/1000).toFixed(1)} KB`;

function describe(root,log){
 const config=readLiveContext(root),about=readAboutMe(root),prefs=readVoicePrefs(root);
 log('What a Live call reads when it starts\n');
 log(about?.text?`About me (${about.source}): ${about.bytes} of ${ABOUT_MAX_BYTES} bytes${about.dropped?`, ${about.dropped} bytes did not fit`:''}. Change it: ask your agent "update my About me".`
  :'About me: not written yet. Ask your agent "update my About me".');
 log('\nBuilt-in parts:');
 for(const [name,text] of Object.entries(LIVE_SECTIONS))log(`  ${config.sections[name]?'on ':'off'}  ${name.padEnd(8)} ${text}`);
 log(`  ${prefs.liveShareWork?'on ':'off'}  tasks    Up to five recent task titles and their status (voice menu: Share task titles)`);
 log(`  ${prefs.liveShareBrief?'on ':'off'}  brief    The whole morning brief, email section included (voice menu: Share morning brief)`);
 const notes=resolveNotes(root,config);
 log(`\nYour notes (${notes.length} of ${MAX_NOTES}):${notes.length?'':' none yet. Add one with: node aos.mjs live-context add <path>'}`);
 notes.forEach((note,index)=>{
  const where=note.folder?`newest note in ${note.path}${note.source?' ('+note.source.slice(note.path.length+1)+')':''}`:note.path;
  log(`  ${index+1}. ${note.label}: ${where}`+(note.problem?` (not sent: ${note.problem})`:`, saved ${note.saved}, ${kb(Buffer.byteLength(note.text))}${note.cut?` of ${kb(note.bytes)}, cut to fit`:''}`));
 });
 if(config.unreadable)log(`\n${LIVE_CONTEXT_FILE} could not be read, so a call uses the starting setup. Run \`node aos.mjs live-context reset\` to rewrite it.`);
 log('\nAll of this goes to OpenAI at the start of every call. Run with --full to see it exactly.');
}

export async function liveContextCommand({words=[],flags={},log=console.log,at=layout(),vault,snapshot}={}){
 const [action='show',...rest]=words;
 if(action==='help'){log(HELP);return 0}
 const allowed={show:['full'],add:['label'],remove:[],section:[],reset:[]}[action];
 if(!allowed||Object.keys(flags).some(name=>!allowed.includes(name)))throw new Error(HELP);
 vault??=configuredVaultPath(at);
 if(!vault)throw new Error('Nothing is installed here yet. Run `node aos.mjs setup --vault "<path>"` first.');
 const root=fs.realpathSync(vault);
 if(action==='show'){
  if(rest.length)throw new Error(HELP);
  if(!flags.full){describe(root,log);return 0}
  const build=snapshot||(await import('../../runner/live/snapshot.mjs')).liveSnapshot;
  log(await build(root,{tasks:()=>[]}));
  log('\n(Work in progress is added from the tasks running when a call starts.)');
  return 0;
 }
 const file=vaultPath(root,LIVE_CONTEXT_FILE);
 const change=work=>withFileLock(file,()=>{const config=readLiveContext(root);const message=work(config);writeLiveContext(root,config);return message});
 if(action==='reset'){
  if(rest.length)throw new Error(HELP);
  log(change(config=>{for(const name of Object.keys(config.sections))config.sections[name]=true;config.notes=[];return 'Back to the starting setup: every built-in part on, no notes of your own.'}));
  return 0;
 }
 if(action==='section'){
  const [name,state]=rest;
  if(rest.length!==2||!Object.hasOwn(LIVE_SECTIONS,name)||!['on','off'].includes(state))throw new Error(`Use: live-context section <${Object.keys(LIVE_SECTIONS).join('|')}> on|off`);
  log(change(config=>{config.sections[name]=state==='on';return `${LIVE_SECTIONS[name].split(':')[0]} is ${state} for the next call.`}));
  return 0;
 }
 if(action==='add'){
  if(rest.length!==1)throw new Error('Use: live-context add <path in your vault> [--label "name"]');
  const checked=checkNotePath(root,rest[0]);
  if(flags.label===true)throw new Error('--label needs a name, like --label "Goals"');
  log(change(config=>{
   const existing=config.notes.find(note=>note.path.toLowerCase()===checked.path.toLowerCase());
   const label=cleanLabel(flags.label,existing?.label||checked.path.split('/').pop().replace(/\.(?:md|txt|csv)$/i,''));
   if(existing){existing.label=label;return `${checked.path} was already on the list; its name is now "${label}".`}
   if(config.notes.length>=MAX_NOTES)throw new Error(`A call reads at most ${MAX_NOTES} of your notes. Remove one first (node aos.mjs live-context show lists them).`);
   config.notes.push({path:checked.path,label});
   return `Added "${label}" (${checked.folder?'the newest note in '+checked.path:checked.path}). The next call reads it.`;
  }));
  const added=resolveNotes(root,readLiveContext(root)).find(note=>note.path.toLowerCase()===checked.path.toLowerCase());
  if(added?.problem)log(`Note: it is on the list, but a call would leave it out right now: ${added.problem}.`);
  else if(added?.cut)log(`Note: it is ${kb(added.bytes)}, so a call reads the first ${kb(Buffer.byteLength(added.text))}. A shorter note or a summary note fits whole.`);
  return 0;
 }
 // remove
 if(rest.length!==1)throw new Error('Use: live-context remove <path or number from live-context show>');
 const target=rest[0].replace(/\\/g,'/').replace(/\/+$/,'');
 log(change(config=>{
  const index=/^\d+$/.test(target)?Number(target)-1:config.notes.findIndex(note=>note.path.toLowerCase()===target.toLowerCase()||note.label.toLowerCase()===target.toLowerCase());
  if(index<0||index>=config.notes.length)throw new Error(`"${rest[0]}" is not on the list. Run node aos.mjs live-context show to see it.`);
  const [removed]=config.notes.splice(index,1);return `Removed "${removed.label}". The next call does not read it.`;
 }));
 return 0;
}
