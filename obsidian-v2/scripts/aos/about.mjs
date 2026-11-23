import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicRename,vaultPath} from '../../runner/core.mjs';
import {withFileLock} from '../../runner/file-lock.mjs';
import {ABOUT_MAX_BYTES,aboutHeading,aboutSection,agentsImport,frontMatterEnd,readAboutMe,visibleMarkdown} from '../../runner/live/about.mjs';
import {configuredVaultPath,layout} from './services.mjs';

const HELP=`About me

  about show                   show what Live reads from your vault
  about write --from <file>    update the About me section in AGENTS.md
  about migrate [--yes]        move CLAUDE.md to AGENTS.md and add the import
`;
const BODY_MAX_BYTES=8*1024;
const IMPORT=['<!-- Claude Code reads AGENTS.md through this import; edit AGENTS.md. -->','@AGENTS.md',''];
const lineEnding=text=>text.match(/\r?\n/)?.[0]||'\n';

function readOptional(file){
  const info=fs.lstatSync(file,{throwIfNoEntry:false});
  if(!info)return null;
  if(!info.isFile())throw new Error(`${path.basename(file)} must be a regular file.`);
  return fs.readFileSync(file);
}
function atomicWrite(file,data){
  const temp=`${file}.${randomUUID()}.tmp`,mode=fs.lstatSync(file,{throwIfNoEntry:false})?.mode??0o600;
  try{fs.writeFileSync(temp,data,{mode,flag:'wx'});atomicRename(temp,file)}
  finally{try{fs.unlinkSync(temp)}catch(error){if(error.code!=='ENOENT')throw error}}
}
function backup(root,name,data){
  const at=Date.now();
  for(let offset=0;;offset++){
    const stamp=new Date(at+offset).toISOString().replace(/:/g,'-');
    const file=vaultPath(root,`system/v2/backups/${name}.${stamp}`);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    try{fs.writeFileSync(file,data,{flag:'wx',mode:0o600});return}
    catch(error){if(error.code!=='EEXIST')throw error}
  }
}

function updateSection(before,body){
  if(!before)return `## About me\n\n${body.replace(/\r\n/g,'\n')}\n\n## Vault conventions\n\nSee the guides in \`docs/\`.\n`;
  // Latin-1 indices are byte offsets, including for old files with non-UTF-8 bytes.
  const bom=before.subarray(0,3).equals(Buffer.from('\uFEFF'))?3:0;
  const raw=before.subarray(bom).toString('latin1'),eol=lineEnding(raw);
  const text=body.replace(/\r?\n/g,eol),section=aboutSection(raw);
  if(section){
    const heading=raw.slice(section.start,section.bodyStart);
    const previous=raw.slice(section.bodyStart,section.end);
    const leading=previous.match(/^(?:[\t ]*\r?\n)*/)[0];
    const trailing=previous.slice(leading.length).match(/(?:\r?\n[\t ]*)+$/)?.[0]||'';
    const prefix=heading.endsWith('\n')?'':eol;
    const suffix=trailing||(section.end<raw.length?eol:'');
    return Buffer.concat([before.subarray(0,bom+section.bodyStart),Buffer.from(prefix+leading+text+suffix),before.subarray(bom+section.end)]);
  }
  const title=/^# [^\r\n]*(?:\r?\n|$)/m.exec(visibleMarkdown(raw)),index=title?title.index+title[0].length:frontMatterEnd(raw);
  const rest=raw.slice(index).replace(/^(?:[\t ]*\r?\n)*/,''),needsBoundary=rest.trim()&&!rest.startsWith('## ');
  // A heading keeps existing prose after the insertion out of About me.
  const insert=(index?(raw[index-1]==='\n'?eol:eol.repeat(2)):'')+['## About me','',text,'',''].join(eol)+
    (needsBoundary?['## Vault conventions','',''].join(eol):'');
  return Buffer.concat([before.subarray(0,bom+index),Buffer.from(insert),before.subarray(bom+index)]);
}

function show(root,log){
  const about=readAboutMe(root);
  if(!about){log('Add a ## About me section in AGENTS.md or run `node aos.mjs about write --from <file>`.');return}
  log(about.text);
  log(`${about.source} · ${about.bytes} / ${ABOUT_MAX_BYTES} bytes${about.dropped?` · ${about.dropped} bytes dropped`:''}`);
}

export function aboutCommand({words=[],flags={},log=console.log,at=layout(),vault}={}){
  const [action='show',...rest]=words;
  if(action==='help'&&!rest.length){log(HELP);return 0}
  if(rest.length||!['show','write','migrate'].includes(action))throw new Error(HELP);
  const allowed=action==='write'?['from']:action==='migrate'?['yes']:[];
  if(Object.keys(flags).some(name=>!allowed.includes(name)))throw new Error(HELP);
  vault??=configuredVaultPath(at);
  if(!vault)throw new Error('Nothing is installed here yet. Run `node aos.mjs setup --vault "<path>"` first.');
  const root=fs.realpathSync(vault);
  if(action==='show'){show(root,log);return 0}
  const agents=vaultPath(root,'AGENTS.md'),claude=vaultPath(root,'CLAUDE.md');
  if(action==='write'){
    if(typeof flags.from!=='string'||!flags.from)throw new Error('Use: about write --from <file>');
    const raw=fs.readFileSync(flags.from,'utf8').replace(/^\uFEFF/,'').replace(aboutHeading,(match,offset)=>offset===0?'':match);
    if(Buffer.byteLength(raw)>BODY_MAX_BYTES)throw new Error('About me must be 8 KB or less.');
    if(/^## /m.test(raw))throw new Error('About me must not contain another level-two heading (## ).');
    const body=raw.replace(/^(?:[\t ]*\r?\n)+|(?:\r?\n[\t ]*)+$/g,'');
    withFileLock(agents,()=>{
      const before=readOptional(agents),other=readOptional(claude);
      if(before)backup(root,'AGENTS.md',before);
      atomicWrite(agents,updateSection(before,body));
      if(!other)atomicWrite(claude,IMPORT.join(before?lineEnding(before.toString('latin1')):'\n'));
      else if(!/^@AGENTS\.md[\t ]*\r?$/m.test(visibleMarkdown(other.toString('utf8'))))
        log('Add `@AGENTS.md` on its own line in CLAUDE.md so Claude Code can read it, or run `node aos.mjs about migrate`.');
    });
    show(root,log);return 0;
  }
  if(flags.yes!==undefined&&flags.yes!==true)throw new Error('Use: about migrate --yes');
  const migrate=()=>{
    const before=readOptional(claude),current=readOptional(agents);
    if(!before)throw new Error('CLAUDE.md is missing.');
    const text=before.toString('utf8');
    if(agentsImport(text))throw new Error('CLAUDE.md already imports AGENTS.md.');
    if(current&&!current.equals(before))throw new Error('AGENTS.md differs from CLAUDE.md. Reconcile the files before migrating.');
    if(!flags.yes){log('Would back up CLAUDE.md, copy it to AGENTS.md, and replace CLAUDE.md with the import. Run `node aos.mjs about migrate --yes` to apply.');return}
    backup(root,'CLAUDE.md',before);
    if(!current)atomicWrite(agents,before);
    atomicWrite(claude,IMPORT.join(lineEnding(text)));
    log('Migrated CLAUDE.md to AGENTS.md and added the import.');
  };
  if(flags.yes)withFileLock(agents,migrate);else migrate();
  return 0;
}
