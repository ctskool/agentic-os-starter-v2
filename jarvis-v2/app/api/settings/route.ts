import { sameOrigin } from "@/lib/preview";
import {serverBridge as bridge} from '@/lib/bridge-server';
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({error:"Origin not allowed"}, {status:403});
  try { const {provider}=await request.json();return Response.json(await bridge('/selection',{provider,model:provider==='codex'?'gpt-6-astra':'opus'})); }
  catch { return Response.json({error:"Could not save provider selection"}, {status:400}); }
}
