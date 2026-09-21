// Identity of this server process, for the launcher's stop and setup checks: the
// process id it reports must be the one the operating system shows listening on
// the port, so a program can only ever vouch for itself. Loopback hosts only.
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const host = request.headers.get('host') || '';
  if (!/^(127\.0\.0\.1|localhost):\d{2,5}$/.test(host) || request.headers.get('origin')) return new Response(null, { status: 403 });
  return Response.json({ kind: 'jarvis-v2', pid: process.pid, root: process.cwd() }, { headers: { 'Cache-Control': 'no-store' } });
}
