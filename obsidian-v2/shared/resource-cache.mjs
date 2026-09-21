// Cache read-only resources, never mutations. Invalidated reads cannot replace newer data.
export function createResourceCache(ttlMs,now=Date.now,maxEntries=128){
 const entries=new Map();
 return {invalidate(key){entries.delete(key)},read(key,load){
  const prior=entries.get(key);
  if(prior&&(prior.pending||now()<prior.expires))return prior.promise;
  const entry={pending:true,expires:0,promise:null};
  entry.promise=Promise.resolve().then(load).then(value=>{entry.pending=false;entry.expires=now()+ttlMs;return value},error=>{if(entries.get(key)===entry)entries.delete(key);throw error});
  if(!entries.has(key)&&entries.size>=maxEntries)entries.delete(entries.keys().next().value);
  entries.set(key,entry);return entry.promise;
 }};
}
