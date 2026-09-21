import {serverBridge as bridge} from '@/lib/bridge-server';
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const path = new URL(request.url).searchParams.get("path") || "";
  try { return Response.json(await bridge('/report?path='+encodeURIComponent(path))); }
  catch { return Response.json({error:"V2 output not found"}, {status:404}); }
}
