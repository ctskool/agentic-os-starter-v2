import { allowsAuthBootstrap } from '../../../../obsidian-v2/shared/bridge-auth';
import { serverBridgeToken } from '@/lib/bridge-server';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  if (!allowsAuthBootstrap(request, 3217)) return Response.json({ error: 'Origin not allowed' }, { status: 403 });
  try { return Response.json({ token: serverBridgeToken() }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return Response.json({ error: 'Bridge authentication unavailable' }, { status: 503 }); }
}
