import {serverBridge as bridge} from '@/lib/bridge-server';
import {sameOrigin} from '@/lib/preview';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  if(!sameOrigin(request))return Response.json({error:'Origin not allowed'},{status:403});
  const provider=new URL(request.url).searchParams.get('provider')||'codex';
  if(provider!=='claude'&&provider!=='codex')return Response.json({error:'Unknown provider'},{status:400});
  return Response.json(await bridge('/usage?provider='+provider,undefined,25000),{headers:{'Cache-Control':'no-store'}});
}
