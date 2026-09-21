import {TIME_ZONE} from '../../shared/timezone.mjs';
import type {App, FileView, TFile, WorkspaceLeaf} from 'obsidian';
import type {VoiceReply} from '../../shared/voice-session';
import {COMMAND_ALLOW,WEB_TARGETS,type ObsidianWhere} from '../../shared/voice-actions';
import type {VoiceArtifact} from '../../shared/artifact-delivery';

const ARTIFACT_MIME:Record<string,string>={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',pdf:'application/pdf',md:'text/markdown',txt:'text/plain'};
const ensureOpening=(signal?:AbortSignal)=>{if(signal?.aborted)throw new Error('Opening was cancelled.')};
function waitForIndex(milliseconds:number,signal?:AbortSignal){return new Promise<void>((resolve,reject)=>{
 const finish=(error?:Error)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve()};
 const abort=()=>finish(new Error('Opening was cancelled.')),timer=setTimeout(()=>finish(),milliseconds);
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
})}

export async function openVoiceArtifact(app:App,artifact:VoiceArtifact,signal?:AbortSignal):Promise<void>{
 const path=artifact?.path,extension=typeof path==='string'?path.split('.').at(-1)?.toLowerCase():undefined;
 if(!path||path.length>1000||/^[\/\\]|^[a-z]:|[\\\x00-\x1f]|(?:^|\/)\.{1,2}(?:\/|$)/i.test(path))throw new Error('The saved file has an invalid path.');
 if(!extension||ARTIFACT_MIME[extension]!==artifact.mime)throw new Error('This file type cannot be displayed here.');
 ensureOpening(signal);
 // The bridge may have just saved the file. Wait briefly for Obsidian's file
 // index instead of treating a correctly generated image as a missing note.
 let file=app.vault.getAbstractFileByPath(path);
 for(let attempt=0;(!file||!('extension' in file))&&attempt<12;attempt++){
  await waitForIndex(150,signal);ensureOpening(signal);file=app.vault.getAbstractFileByPath(path);
 }
 if(!file||!('extension' in file))throw new Error('The file is saved, but Obsidian has not found it yet.');
 ensureOpening(signal);
 // A later "show it again" should raise the file already on screen, not grow
 // another tab. Match the full immutable path, never a title or basename.
 const matches:WorkspaceLeaf[]=[];
 app.workspace.iterateAllLeaves(leaf=>{if((leaf.view as Partial<FileView>).file?.path===path&&leaf.view.getViewType()!=='empty')matches.push(leaf)});
 ensureOpening(signal);
 const existing=matches[0],leaf=existing||app.workspace.getLeaf('tab');if(!leaf)throw new Error('No workspace pane is available.');
 if(!existing)await leaf.openFile(file as TFile);ensureOpening(signal);
 await app.workspace.revealLeaf(leaf);
 ensureOpening(signal);
 if(existing&&(leaf.view as Partial<FileView>).file?.path!==path)throw new Error('The file pane changed before it could be shown.');
 if(leaf.view?.getViewType?.()==='empty')throw new Error('Obsidian could not display the saved file.');
}

export async function applyVoiceAction(app:App,reply:VoiceReply,activate:()=>Promise<unknown>,openWork:()=>void):Promise<string|null>{
 const leafFor=(where?:ObsidianWhere)=>{
  if(where==='right-sidebar')return app.workspace.getRightLeaf(false);
  if(where==='left-sidebar')return app.workspace.getLeftLeaf(false);
  if(where==='split'){const current=app.workspace.getMostRecentLeaf();return current?app.workspace.createLeafBySplit(current,'vertical'):app.workspace.getLeaf('split')}
  return app.workspace.getLeaf('tab');
 };
 const open=async(path:string,where?:ObsidianWhere)=>{
  if(/^[\/\\]|^[a-z]:|(?:^|[\/\\])\.\.(?:[\/\\]|$)/i.test(path))throw new Error('Invalid note path');
  const file=app.vault.getAbstractFileByPath(path);
  if(!file||!('extension' in file))throw new Error('That note is unavailable.');
  let existing:WorkspaceLeaf|undefined;
  if(!where||where==='tab')app.workspace.iterateAllLeaves(leaf=>{if(!existing&&(leaf.view as Partial<FileView>).file?.path===file.path&&leaf.view.getViewType()!=='empty')existing=leaf});
  const leaf=existing||leafFor(where);if(!leaf)throw new Error('That note is unavailable.');
  if(!existing)await leaf.openFile(file as TFile);await app.workspace.revealLeaf(leaf);
  return `Opened ${file.name}.`;
 };
 if(reply.deliverable&&reply.reveal==='open')return open(reply.deliverable);
 const action=reply.obsidian||(reply.action==='cockpit'?{op:'cockpit' as const}:null);
 if(!action)return null;
 switch(action.op){
  case 'cockpit':await activate();return 'Opened command center.';
  case 'daily-note':return open(`daily-notes/${new Intl.DateTimeFormat('en-CA',{timeZone:TIME_ZONE}).format(new Date())}.md`,action.where);
  case 'open-note':{
   const exact=app.vault.getAbstractFileByPath(action.query);
   if(exact&&'extension' in exact)return open(exact.path,action.where);
   const words=action.query.toLowerCase().split(/\s+/).filter(w=>w.length>2);
   const scored=app.vault.getMarkdownFiles().map(f=>({f,score:words.reduce((sum,w)=>sum+(f.basename.toLowerCase().includes(w)?2:f.path.toLowerCase().includes(w)?1:0),0)})).sort((a,b)=>b.score-a.score);
   const match=scored[0];if(!match||match.score<Math.max(1,words.length)||scored[1]?.score===match.score)throw new Error('Please use a more specific note name.');
   return open(match.f.path,action.where);
  }
  case 'search':{
   const search=(app as any).internalPlugins?.getPluginById?.('global-search')?.instance;
   if(!search?.openGlobalSearch)throw new Error('Enable Obsidian Search to search notes.');
   search.openGlobalSearch(action.query);return `Searching for ${action.query}.`;
  }
  case 'command':{
   if(!COMMAND_ALLOW[action.id])throw new Error('Unsupported workspace command.');
   if(action.id==='terminal:open-terminal.default.root'){openWork();return 'Opened terminals.'}
   if(!(app as any).commands?.executeCommandById?.(action.id))throw new Error('That workspace command is unavailable.');
   return `Opened ${action.label}.`;
  }
  case 'repo':case 'web':{
   if(action.op==='repo'&&!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(action.slug))throw new Error('Invalid repository.');
   if(action.op==='web'&&!Object.values(WEB_TARGETS).some(t=>t.url===action.url))throw new Error('Unsupported web target.');
   const leaf=leafFor(action.where);if(!leaf)throw new Error('No workspace pane is available.');
   await leaf.setViewState({type:'webviewer',active:true,state:{url:action.op==='repo'?`https://github.com/${action.slug}`:action.url,navigate:true}});
   await app.workspace.revealLeaf(leaf);return `Opened ${action.op==='repo'?action.slug:action.label}.`;
  }
 }
}
