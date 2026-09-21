import {createPollStore} from '../../obsidian-v2/shared/poll-store.mjs';
import type {VaultState} from './vault';
type Snapshot={state:VaultState|null;error:boolean};
let etag='';
export const dashboardStore=createPollStore({initial:{state:null,error:false} as Snapshot,intervalMs:1000,
 load:async():Promise<Snapshot>=>{if(document.hidden)return dashboardStore.getSnapshot();try{
  const response=await fetch('/api/state',{cache:'no-store',headers:etag?{'If-None-Match':etag}:{},signal:AbortSignal.timeout(8000)});
  if(response.status===304){const previous=dashboardStore.getSnapshot();return previous.error?{...previous,error:false}:previous}
  if(!response.ok)throw new Error('Dashboard unavailable');
  const state=await response.json();etag=response.headers?.get('etag')||'';
  return {state,error:false};
 }catch{return {...dashboardStore.getSnapshot(),error:true}}},
 onStart:(refresh:()=>void)=>{const wake=()=>{if(!document.hidden)refresh()};document.addEventListener('visibilitychange',wake);return()=>document.removeEventListener('visibilitychange',wake)}
});
export function publishProvider(provider:'codex'|'claude'){
 const current=dashboardStore.getSnapshot();
 dashboardStore.publish({...current,state:current.state?{...current.state,preview:{...(current.state as any).preview,provider}}:null});
}
