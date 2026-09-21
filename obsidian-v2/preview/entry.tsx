import {h,render} from 'preact';
import {WorkPane} from '../src/components/WorkPane';
import {readSelection} from '../src/lib/provider';
import {openWork,configureWorkSession} from '../src/lib/work';
import {Cockpit} from '../src/components/Cockpit';
import {OrbFloat} from '../src/components/OrbFloat';
import {DEFAULT_SETTINGS} from '../src/settings';
import {authorizedBridgeFetch} from '../shared/bridge-auth';
import {previewAuthorization} from './auth';
import {startPreviewSnapshots} from './snapshots.mjs';
import {previewAbstractFile,previewFile} from './vault-index.mjs';
const cache:Record<string,string>={};
configureWorkSession('preview');
async function rpc(op:string,args:Record<string,unknown>={}){const response=await authorizedBridgeFetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op,...args}),signal:AbortSignal.timeout(8000)},previewAuthorization);const value=await response.json();if(!response.ok)throw new Error(value.error);return value.result}
const listeners=new Map<string,Set<Function>>();const events={on:(name:string,fn:Function)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name)!.add(fn)},off:(name:string,fn:Function)=>listeners.get(name)?.delete(fn)};
const adapter={exists:(path:string)=>rpc('exists',{path}),read:(path:string)=>rpc('read',{path}),list:(path:string)=>rpc('list',{path}),mkdir:(path:string)=>rpc('mkdir',{path}),write:async(path:string,text:string)=>{await rpc('write',{path,text});cache[path]=text;listeners.get('modify')?.forEach(fn=>fn({path}))},rename:(path:string,to:string)=>rpc('rename',{path,to}),getResourcePath:(path:string)=>'/assets/'+path.split('/assets/')[1]};
const open=async(path:string)=>{try{const text=await adapter.read(path);document.querySelector('#document-name')!.textContent=path;document.querySelector('#document-body')!.textContent=text;(document.querySelector('#document') as HTMLDialogElement).showModal()}catch(e){window.dispatchEvent(new CustomEvent('preview-notice',{detail:String(e)}))}};
const app:any={vault:{adapter,...events,getAbstractFileByPath:(path:string)=>previewAbstractFile(cache,path),cachedRead:(file:any)=>adapter.read(file.path),read:(file:any)=>adapter.read(file.path),modify:(file:any,text:string)=>adapter.write(file.path,text),getMarkdownFiles:()=>Object.keys(cache).filter(p=>p.endsWith('.md')).map(previewFile)},metadataCache:{...events,getFileCache:(file:any)=>{const raw=cache[file.path]||'';return {frontmatter:{schema_version:Number(raw.match(/schema_version: (\d+)/)?.[1]||0),focus:raw.match(/focus: (.+)/)?.[1]||'',date:raw.match(/date: (.+)/)?.[1]}}}},workspace:{openLinkText:open,getLeaf:()=>({openFile:(f:any)=>open(f.path)}),revealLeaf:()=>{}}};
const root=document.querySelector('#cockpit')!;
(root as HTMLElement).style.setProperty('--aos-v2-sky','url("/assets/sky.png")');
let savedSettings={};try{savedSettings=JSON.parse(localStorage.getItem('aos-v2-preview-settings')||'{}')}catch{}
const plugin:any={app,settings:{...DEFAULT_SETTINGS,...savedSettings},saveSettings:async()=>{localStorage.setItem('aos-v2-preview-settings',JSON.stringify(plugin.settings))},applyTheme:()=>{root.setAttribute('data-cc-theme',plugin.settings.theme);root.setAttribute('data-cheap',String(plugin.settings.reduceBlur));root.setAttribute('data-paused',String(plugin.settings.pauseMotion));root.querySelector('.v2-dashboard')?.setAttribute('data-cheap',String(plugin.settings.reduceBlur))},activateView:async()=>{root.scrollIntoView({behavior:'instant'});},remountOrb:()=>{}};
plugin.applyTheme();
render(<Cockpit plugin={plugin}/>,root);
const orbRoot=document.createElement('div');
orbRoot.className='aos-v2-cc-orb-root';
document.body.appendChild(orbRoot);
render(<OrbFloat plugin={plugin} surfaceKind="web"/>,orbRoot);
window.addEventListener('preview-notice',(e:Event)=>{const el=document.querySelector('#notice')!;el.textContent=(e as CustomEvent).detail;setTimeout(()=>{el.textContent=''},5000)});
document.querySelector('#close-document')!.addEventListener('click',()=>{(document.querySelector('#document') as HTMLDialogElement).close()});

const connection=document.querySelector('.preview-host span') as HTMLElement;
connection.setAttribute('role','status');
const stopSnapshots=startPreviewSnapshots({load:()=>rpc('snapshot'),status:(message:string)=>{connection.textContent=message},apply:(next:Record<string,string>)=>{for(const p of Object.keys(cache))if(!Object.hasOwn(next,p)){delete cache[p];listeners.get('modify')?.forEach(fn=>fn({path:p}));listeners.get('changed')?.forEach(fn=>fn({path:p}))}for(const [p,text] of Object.entries(next))if(cache[p]!==text){cache[p]=text;listeners.get('modify')?.forEach(fn=>fn({path:p}));listeners.get('changed')?.forEach(fn=>fn({path:p}))}}});
window.addEventListener('beforeunload',stopSnapshots,{once:true});

const workRoot=document.createElement('section');workRoot.className='aos-preview-work';workRoot.hidden=true;document.body.appendChild(workRoot);
let workMounted=false;
window.addEventListener('aos-open-work',()=>{workRoot.hidden=false;if(!workMounted){render(<WorkPane app={app} getSelection={()=>readSelection(app)}/>,workRoot);workMounted=true}workRoot.scrollIntoView({behavior:'instant'})});
const workButton=document.createElement('button');workButton.textContent='Open terminals';workButton.className='aos-preview-work-button';workButton.onclick=()=>openWork();document.body.appendChild(workButton);
