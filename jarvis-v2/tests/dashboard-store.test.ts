import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardStore,publishProvider} from '../lib/dashboard-store';

test('a slow dashboard response cannot undo a saved provider and hidden pages do not fetch',async()=>{
 const originalDocument=Object.getOwnPropertyDescriptor(globalThis,'document'),originalFetch=globalThis.fetch;
 let hidden=false,calls=0,resolve!:(value:any)=>void;
 Object.defineProperty(globalThis,'document',{configurable:true,value:{get hidden(){return hidden}}});
 globalThis.fetch=async()=>{calls++;return await new Promise(r=>{resolve=r})};
 try{
  dashboardStore.publish({state:{preview:{provider:'claude'}},error:false});
  const pending=dashboardStore.refresh();await Promise.resolve();publishProvider('codex');
  resolve({ok:true,json:async()=>({preview:{provider:'claude'}})});await pending;
  assert.equal(dashboardStore.getSnapshot().state.preview.provider,'codex');
  hidden=true;await dashboardStore.refresh();assert.equal(calls,1);
  dashboardStore.publish({state:null,error:false});hidden=false;
  const initial=dashboardStore.refresh();await Promise.resolve();publishProvider('codex');
  resolve({ok:true,json:async()=>({preview:{provider:'claude'}})});await initial;
  assert.equal(dashboardStore.getSnapshot().state,null);
 }finally{globalThis.fetch=originalFetch;if(originalDocument)Object.defineProperty(globalThis,'document',originalDocument);else delete (globalThis as any).document}
});

test('unchanged dashboard responses reuse the snapshot and send the cached validator',async()=>{
 const originalDocument=Object.getOwnPropertyDescriptor(globalThis,'document'),originalFetch=globalThis.fetch;
 Object.defineProperty(globalThis,'document',{configurable:true,value:{hidden:false}});
 let calls=0;
 globalThis.fetch=async(_url,options)=>{calls++;if(calls===1)return new Response(JSON.stringify({preview:{provider:'codex'}}),{headers:{ETag:'"sample"'}});assert.equal(new Headers(options?.headers).get('If-None-Match'),'"sample"');return new Response(null,{status:304})};
 try{await dashboardStore.refresh();const first=dashboardStore.getSnapshot();await dashboardStore.refresh();assert.equal(dashboardStore.getSnapshot(),first)}
 finally{globalThis.fetch=originalFetch;if(originalDocument)Object.defineProperty(globalThis,'document',originalDocument);else delete (globalThis as any).document}
});
