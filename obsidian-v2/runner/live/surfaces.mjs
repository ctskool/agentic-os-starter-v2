import {randomUUID} from 'node:crypto';
import {liveSecret,sameLiveSecret} from './calls.mjs';

// A revoked ID stays distinguishable from a Local, caller-chosen UUID even
// after a bridge restart. The prefix is outside the legacy UUID namespace.
const prefix='live-';
export class LiveSurfaces {
 constructor({now=Date.now}={}){this.now=now;this.entries=new Map()}
 registered(id){return typeof id==='string'&&id.startsWith(prefix)}
 register(appScope){
  this.sweep();
  if(this.entries.size>=128)throw new Error('Too many registered voice surfaces.');
  const surfaceId=prefix+randomUUID(),surfaceSecret=liveSecret();
  this.entries.set(surfaceId,{appScope,surfaceSecret,registeredAt:this.now(),connected:false});
  return {surfaceId,surfaceSecret};
 }
 require(id,scope,secret,connected=false){
  const entry=this.entries.get(id);
  if(!entry||entry.appScope!==scope||!sameLiveSecret(entry.surfaceSecret,secret)||connected&&!entry.connected)throw new Error('Voice surface authentication required.');
  return entry;
 }
 verify(id,scope,secret){if(this.registered(id))this.require(id,scope,secret)}
 connect(id,scope,secret){if(this.registered(id))this.require(id,scope,secret).connected=true}
 revoke(id){this.entries.delete(id)}
 sweep(){
  for(const [id,entry]of this.entries)if(!entry.connected&&this.now()-entry.registeredAt>=60000)this.entries.delete(id);
 }
}
