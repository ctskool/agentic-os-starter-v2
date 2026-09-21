import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {projectRoot} from '../runner/runtime.mjs';
import {vaultPath,writeJson} from '../runner/core.mjs';
const input=process.argv[2];if(!input)throw new Error('Usage: node scripts/install-live.mjs "absolute vault path"');
const root=fs.realpathSync(input);
if(!fs.existsSync(vaultPath(root,'system/schemas/daily-note.md'))||!fs.existsSync(vaultPath(root,'.obsidian')))throw new Error('Expected an existing Agentic OS Obsidian vault');
const dist=path.join(projectRoot,'dist/agentic-os-v2'),manifest=JSON.parse(fs.readFileSync(path.join(dist,'manifest.json'),'utf8'));
if(manifest.id!=='agentic-os-v2')throw new Error('Refusing to install over the V1 plugin ID');
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),backup=path.join(projectRoot,'.runtime/backups',stamp);fs.mkdirSync(backup,{recursive:true});
const tracked=['.obsidian/community-plugins.json','.obsidian/plugins/chase-command-center/main.js','.obsidian/plugins/chase-command-center/manifest.json','.obsidian/plugins/chase-command-center/data.json','.agentic-os-v2.json'];
const hashes={};
for(const relative of tracked){const file=vaultPath(root,relative);if(fs.existsSync(file)){const target=path.join(backup,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(file,target);hashes[relative]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}}
const target=vaultPath(root,'.obsidian/plugins/agentic-os-v2');
if(fs.existsSync(target))fs.cpSync(target,path.join(backup,'previous-v2-plugin'),{recursive:true});
fs.mkdirSync(target,{recursive:true});fs.cpSync(dist,target,{recursive:true});
const authFile=path.join(projectRoot,'.runtime/bridge-auth.json');
if(fs.existsSync(authFile))fs.copyFileSync(authFile,path.join(target,'bridge-auth.json'));
// Compatibility settings for explicitly reopening older bridge-owned tabs.
// New native tasks launch directly via immutable tickets from /native/claim.
fs.writeFileSync(path.join(target,'terminal-runtime.json'),JSON.stringify({version:1,nodeExecutable:process.execPath,attachmentScript:path.join(projectRoot,'runner/terminal-attach.mjs'),runtimeDir:path.join(projectRoot,'.runtime'),vault:root},null,2));
if(!fs.existsSync(path.join(target,'data.json')))fs.writeFileSync(path.join(target,'data.json'),JSON.stringify({theme:'glass',orbEnabled:true,orbRight:220,orbBottom:48}));
// The Hot Reload community plugin reloads V2 automatically after each install
// when this marker exists; the installer never touches Hot Reload itself.
fs.writeFileSync(path.join(target,'.hotreload'),'');
for(const dir of ['queue','processing','runs','logs','artifacts','backups'])fs.mkdirSync(vaultPath(root,'system/v2/'+dir),{recursive:true});
if(!fs.existsSync(vaultPath(root,'system/v2/provider.json')))writeJson(root,'system/v2/provider.json',{provider:'codex',model:'gpt-6-astra'});
writeJson(root,'.agentic-os-v2.json',{version:2,enabled:true,vault:root,installedAt:new Date().toISOString()});
// Keep startup settings unchanged. Enable the distinct plugin from Obsidian when ready to test it.
fs.mkdirSync(path.join(projectRoot,'.runtime'),{recursive:true});fs.writeFileSync(path.join(projectRoot,'.runtime/vault.json'),JSON.stringify({vault:root}));
fs.writeFileSync(path.join(backup,'installation.json'),JSON.stringify({root,stamp,hashes,plugin:'agentic-os-v2'},null,2));
for(const [relative,hash] of Object.entries(hashes)){if(relative==='.agentic-os-v2.json')continue;if(crypto.createHash('sha256').update(fs.readFileSync(vaultPath(root,relative))).digest('hex')!==hash)throw new Error('Original file changed: '+relative)}
// A vault that never enabled a community plugin has no list yet; that is not an error and nothing is written.
const enabledFile=vaultPath(root,'.obsidian/community-plugins.json');
const enabled=fs.existsSync(enabledFile)?JSON.parse(fs.readFileSync(enabledFile,'utf8')):[];
console.log(JSON.stringify({installed:target,vault:root,backup,enabledInObsidian:enabled.includes(manifest.id),reloadRequired:true,v1Unchanged:true},null,2));
