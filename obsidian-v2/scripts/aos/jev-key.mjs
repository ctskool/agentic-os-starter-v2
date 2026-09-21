// The OpenRouter key never passes through a chat, a command line or a log.
// A one-shot page on this machine takes it and writes .runtime/jev.json; the
// caller (usually a coding agent) only ever learns saved: true or false.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {openUrl} from './platform.mjs';

export const KEY_SHAPE = /^sk-or-[A-Za-z0-9_-]{10,490}$/;
// The owner's live non-secret settings: early exit on, both providers.
export const JEV_DEFAULTS = {rulebook: 'v2', mode: {codex: 'fastpath', claude: 'fastpath'}, theta: 0.9, deadlineMs: 1500, tier2kind: true};
export const STRICT_DEFAULTS = {open: 'on', ui: 'on'};

function writePrivate(file, data) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 1), {mode: 0o600});
  fs.renameSync(temp, file);
}

export function saveJevKey(runtimeDir, key) {
  if (!KEY_SHAPE.test(key)) return false;
  fs.mkdirSync(runtimeDir, {recursive: true});
  const file = path.join(runtimeDir, 'jev.json');
  let saved = {}; try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first key */ }
  // Settings someone already tuned survive a key change.
  writePrivate(file, {...JEV_DEFAULTS, ...saved, key});
  const strict = path.join(runtimeDir, 'voice-strict.json');
  if (!fs.existsSync(strict)) writePrivate(strict, STRICT_DEFAULTS);
  return true;
}

export const hasJevKey = runtimeDir => { try { return KEY_SHAPE.test(String(JSON.parse(fs.readFileSync(path.join(runtimeDir, 'jev.json'), 'utf8')).key || '')); } catch { return false; } };

const page = (body, note = '') => `<!doctype html><meta charset="utf-8"><title>Agentic OS — Jev key</title>
<style>body{font:16px system-ui;background:#0b0d12;color:#e8eaf0;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:460px;padding:24px}
input{width:100%;box-sizing:border-box;padding:12px;font:inherit;border-radius:8px;border:1px solid #39405a;background:#141826;color:inherit}
button{margin-top:12px;padding:10px 18px;font:inherit;border:0;border-radius:8px;background:#6d7cff;color:#fff;cursor:pointer}p{line-height:1.5;color:#aab0c4}.note{color:#ffb4a8}</style>
<main>${body}${note ? `<p class="note">${note}</p>` : ''}</main>`;
const form = note => page(`<h2>Paste your OpenRouter key</h2><p>It is saved on this computer only, in a file the voice router reads. It is never shown to your coding agent.</p>
<form method="post" autocomplete="off"><input type="password" name="key" placeholder="sk-or-…" autofocus required><button>Save key</button></form>`, note);

export function collectJevKey({runtimeDir, timeoutMs = 5 * 60 * 1000, open = openUrl, announce = () => {}} = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  return new Promise((resolve, reject) => {
    let done = false, timer;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); server.close(); server.closeAllConnections?.(); resolve(result); };
    const server = http.createServer((req, res) => {
      const port = server.address().port, origin = `http://127.0.0.1:${port}`;
      const headers = {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"};
      const reply = (code, html) => { res.writeHead(code, headers); res.end(html); };
      const supplied = Buffer.from(String(req.url || '').slice(1)), wanted = Buffer.from(token);
      // Another local page cannot guess the path, and a browser always sends Origin on a cross-site POST.
      if (req.headers.host !== `127.0.0.1:${port}` || supplied.length !== wanted.length || !crypto.timingSafeEqual(supplied, wanted)) return reply(404, page('<h2>Not found</h2>'));
      if (req.method === 'GET') return reply(200, form(''));
      if (req.method !== 'POST' || req.headers.origin !== origin || !/^application\/x-www-form-urlencoded/i.test(req.headers['content-type'] || '')) return reply(403, page('<h2>Refused</h2>'));
      let size = 0; const chunks = [];
      req.on('data', chunk => { size += chunk.length; if (size > 4096) { req.destroy(); return; } chunks.push(chunk); });
      req.on('end', () => {
        const key = (new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('key') || '').trim();
        let saved = false; try { saved = saveJevKey(runtimeDir, key); } catch { saved = false; }
        if (!saved) return reply(400, form('That does not look like an OpenRouter key (it starts with sk-or-). Nothing was saved.'));
        reply(200, page('<h2>Saved</h2><p>You can close this tab and go back to your coding agent.</p>'));
        res.once('finish', () => finish({saved: true}));
      });
    });
    server.once('error', reject);
    server.listen({host: '127.0.0.1', port: 0, exclusive: true}, () => {
      const url = `http://127.0.0.1:${server.address().port}/${token}`;
      timer = setTimeout(() => finish({saved: false, reason: 'timeout'}), timeoutMs);
      announce(url);
      try { open(url); } catch { /* the printed address is the fallback */ }
    });
  });
}
