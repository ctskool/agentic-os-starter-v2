import {readCachedVaultState,setVaultRoot} from "@/lib/vault";
import {serverBridge as bridge} from '@/lib/bridge-server';
import {createHash} from 'node:crypto';
export const dynamic = "force-dynamic";
export async function GET(request:Request) {
 try{const shared=await bridge('/state');setVaultRoot(shared.vault);const sample=await readCachedVaultState();
 const {ts,...health}=shared.health||{};
 const etag='"'+createHash('sha256').update(JSON.stringify([sample.generated_at,shared.vault,shared.selection,health,shared.runs,shared.queue])).digest('hex')+'"';
 const headers={'Cache-Control':'no-store',ETag:etag};
 if(request.headers.get('if-none-match')===etag)return new Response(null,{status:304,headers});
 return Response.json({...sample,vault_root:shared.vault,preview:{provider:shared.selection.provider,model:shared.selection.model,execution:'connected',simulated:false},
 runner:shared.health?{...shared.health,alive:true,heartbeat_age_s:Math.max(0,(Date.now()-Date.parse(shared.health.ts))/1000)}:{...sample.runner,busy:false,active:0,pending:0,alive:false},
 queue:shared.queue,runs:shared.runs.map((r:any)=>({...r,label:`${r.skill} · ${r.provider}`,link:null,duration_s:r.ts_completed?(Date.parse(r.ts_completed)-Date.parse(r.ts_started))/1000:null}))},{headers});
 }catch(e){return Response.json({error:e instanceof Error?e.message:'V2 bridge unavailable'},{status:503})}
}
