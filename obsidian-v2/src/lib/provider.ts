import type { App } from 'obsidian';
import { useEffect, useState } from 'preact/hooks';
import { DEFAULT_SELECTION, MARKER, ROOT, validateSelection } from '../../shared/contract.mjs';
import {readBridgeStatus} from './bridge-status';
import {createPollStore} from '../../shared/poll-store.mjs';
export type Provider = 'codex' | 'claude';
export interface Selection { provider:Provider; model:string }
export interface Health { ts:string; busy:boolean; providers:Record<Provider,{installed:boolean; detail:string}> }
export async function assertTestVault(app:App){
 if(await app.vault.adapter.exists('.agentic-os-v2.json')){
  const config=JSON.parse(await app.vault.adapter.read('.agentic-os-v2.json'));
  const adapter=app.vault.adapter as typeof app.vault.adapter & {getBasePath?:()=>string};
  if(config.version===2&&config.enabled===true&&(!adapter.getBasePath||adapter.getBasePath().replace(/\\/g,'/').toLowerCase()===String(config.vault).replace(/\\/g,'/').toLowerCase()))return;
  throw new Error('V2 configuration does not match this vault');
 }
 if(!await app.vault.adapter.exists(MARKER) || (await app.vault.adapter.read(MARKER)).trim()!=='agentic-os-v2-only') throw new Error('Open the bundled V2 test vault. V1 queues are never used.');
}
export async function readSelection(app:App):Promise<Selection>{
 const file=`${ROOT}/provider.json`;
 return validateSelection(await app.vault.adapter.exists(file)?JSON.parse(await app.vault.adapter.read(file)):DEFAULT_SELECTION) as Selection;
}
export async function saveSelection(app:App,value:Selection){
 await assertTestVault(app);validateSelection(value);
 await app.vault.adapter.write(`${ROOT}/provider.json`,JSON.stringify(value,null,2));
 const store=providerStore(app);store.publish({...store.getSnapshot(),selection:value,error:''});
}
export async function readHealth(app:App):Promise<Health|null>{
 try{return (await readBridgeStatus()).health}catch{return null}
}
interface ProviderSnapshot {selection:Selection;health:Health|null;error:string}
const stores=new WeakMap<App,ReturnType<typeof createPollStore>>();
function providerStore(app:App){
 const existing=stores.get(app);if(existing)return existing;
 const store=createPollStore({initial:{selection:DEFAULT_SELECTION as Selection,health:null,error:''} as ProviderSnapshot,
  load:async()=>{try{await assertTestVault(app);const [selection,health]=await Promise.all([readSelection(app),readHealth(app)]);return {selection,health,error:''}}catch(e){return {...store.getSnapshot(),health:null,error:String(e)}}},
  onStart:(run:()=>void)=>{window.addEventListener('aos-v2-provider',run);return()=>window.removeEventListener('aos-v2-provider',run)}
 });stores.set(app,store);return store;
}
export function useProvider(app:App){
 const store=providerStore(app);
 const [snapshot,setSnapshot]=useState<ProviderSnapshot>(store.getSnapshot());
 useEffect(()=>store.subscribe(setSnapshot),[store]);
 return {...snapshot,refresh:store.refresh};
}
