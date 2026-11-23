import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readPrivate} from './private-store.mjs';

export const CONSENT_VERSION=1;
export const LIVE_KEY_SHAPE=/^sk-(?!or-)[A-Za-z0-9_-]{16,500}$/;
export const LIVE_RUNTIME_DIR=fileURLToPath(new URL('../../.runtime/',import.meta.url));
export const liveKeyFile=runtimeDir=>path.join(runtimeDir,'openai.json');
function authorization(runtimeDir){
 let saved;
 try{saved=readPrivate(liveKeyFile(runtimeDir),null)}catch{return {reason:'Live voice authorization could not be read. Run aos openai-key.'}}
 if(typeof saved?.key!=='string'||!LIVE_KEY_SHAPE.test(saved.key))return {reason:'Run aos openai-key to set up Live voice.'};
 const consentAt=typeof saved.consentAt==='string'?Date.parse(saved.consentAt):NaN;
 if(saved.consentVersion!==CONSENT_VERSION||!Number.isFinite(consentAt)||consentAt<=0||consentAt>Date.now())return {reason:'Live voice needs current consent. Run aos openai-key.'};
 return {key:saved.key,reason:null};
}
export function liveAuthorization(runtimeDir=LIVE_RUNTIME_DIR){
 const {key,reason}=authorization(runtimeDir);
 return {ready:!!key,reason};
}
export const readLiveKey=(runtimeDir=LIVE_RUNTIME_DIR)=>authorization(runtimeDir).key||null;
