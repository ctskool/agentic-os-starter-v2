import { TIME_ZONE } from '../../obsidian-v2/shared/timezone.mjs';
import { serverBridge as bridge } from './bridge-server';
import { invalidateVaultSnapshot } from './vault';
import { sameOrigin } from './preview';

type Bridge = (path: string, body?: unknown) => Promise<any>;
type Directive = { index: number; done: boolean; date: string; text: string };
class DirectiveError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function parseDirective(value: unknown, today: string): Directive {
  const input = value as Partial<Directive> | null;
  if (!input || !Number.isInteger(input.index) || input.index! < 0 || input.index! > 2 ||
      typeof input.done !== 'boolean' || typeof input.text !== 'string' ||
      !input.text.trim() || input.text.length > 10000 || typeof input.date !== 'string') {
    throw new DirectiveError('Invalid directive');
  }
  if (input.date !== today) throw new DirectiveError("Only today's priorities can be changed. Refresh the dashboard and try again.", 409);
  return input as Directive;
}

function updatePriority(before: string, directive: Directive): string {
  // Keep every byte outside the checkbox, including mixed line endings and BOM.
  const lines = before.split('\n');
  let section = '', seen = -1;
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^##\s+(.*)/);
    if (heading) { section = heading[1].trim(); continue; }
    if (section !== 'Top 3 Priorities') continue;
    const item = lines[i].match(/^(\d+\.\s+)\[( |x)\](\s+)(.*)/);
    if (!item || ++seen !== directive.index) continue;
    if (item[4].trim() !== directive.text.trim()) {
      throw new DirectiveError('This priority changed since it was displayed. Refresh and try again; newer edits were preserved.', 409);
    }
    const checkbox = item[1].length + 1;
    lines[i] = lines[i].slice(0, checkbox) + (directive.done ? 'x' : ' ') + lines[i].slice(checkbox + 1);
    return lines.join('\n');
  }
  throw new DirectiveError('Daily priority was not found. Refresh the dashboard and try again.', 404);
}

export function createDailyPost({ requestBridge = bridge, invalidate = invalidateVaultSnapshot, now = () => new Date() }: {
  requestBridge?: Bridge; invalidate?: (root: string) => void; now?: () => Date;
} = {}) {
  return async function POST(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return Response.json({ error: 'Origin not allowed' }, { status: 403 });
    let root: string | undefined;
    try {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(now());
      const directive = parseDirective(await request.json(), today);
      const status = await requestBridge('/status');
      root = status.vault;
      const path = `daily-notes/${today}.md`;
      const report = await requestBridge('/report?path=' + encodeURIComponent(path));
      if (typeof report.content !== 'string') throw new Error('The daily note could not be loaded');
      const before = report.content, after = updatePriority(before, directive);
      await requestBridge('/notes/replace', { path, before, after });
      invalidate(root!);
      return Response.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Directive update failed';
      const conflict = /changed since|newer edits were preserved/i.test(message);
      // A conflict means cached dashboard data is also stale. Refresh without retrying the write.
      if (root && conflict) invalidate(root);
      const status = error instanceof DirectiveError ? error.status : error instanceof SyntaxError ? 400 : conflict ? 409 : 502;
      return Response.json({ error: message }, { status });
    }
  };
}
