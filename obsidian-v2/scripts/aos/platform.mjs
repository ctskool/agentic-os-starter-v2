// The only per-OS code behind `aos`: who listens on a port, what that process
// is, where a command lives, and how to open a page. Parsers are pure so both
// operating systems are covered by fixtures wherever the suite runs.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export const isWindows = process.platform === 'win32';
const caseless = process.platform === 'win32' || process.platform === 'darwin';

// Same place on disk. Links are resolved when the paths exist (macOS reports /private/var for /var).
export function samePath(a, b) {
  if (!a || !b) return false;
  const real = value => { const full = path.resolve(String(value)); try { return fs.realpathSync.native(full); } catch { return full; } };
  const left = real(a), right = real(b);
  return caseless ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function parseLsofPids(text) {
  return [...new Set(String(text || '').split(/\r?\n/).map(line => line.trim()).filter(line => /^\d{1,10}$/.test(line)).map(Number))];
}

// `ps -ww -o lstart=,command= -p <pid>` → "Mon Sep 21 13:35:02 2026 /usr/bin/node /x/bridge.mjs"
export function parsePsLine(text) {
  const match = String(text || '').trim().match(/^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/s);
  if (!match) return null;
  const commandLine = match[2].trim();
  return {startedAt: match[1].replace(/\s+/g, ' '), commandLine, name: path.basename(commandLine.split(/\s+/)[0] || '')};
}

export function parseWindowsProcess(text) {
  let data; try { data = JSON.parse(String(text || '').replace(/^\uFEFF/, '').trim() || 'null'); } catch { return null; }
  if (!data || !Number.isSafeInteger(data.pid)) return null;
  return {pid: data.pid, name: String(data.name || ''), commandLine: String(data.commandLine || ''), startedAt: String(data.startedAt || '')};
}

function powershell(script, run) {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return run(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {encoding: 'utf8', windowsHide: true, timeout: 15000});
}
const processScript = filter => `$p=Get-CimInstance Win32_Process -Filter "${filter}";if($p){@{pid=[int]$p.ProcessId;name=$p.Name;commandLine=$p.CommandLine;startedAt=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}`;

export function processInfo(pid, {run = spawnSync, platform = process.platform} = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (platform === 'win32') return parseWindowsProcess(powershell(processScript(`ProcessId=${pid}`), run).stdout);
  const result = run('ps', ['-ww', '-o', 'lstart=,command=', '-p', String(pid)], {encoding: 'utf8', timeout: 5000});
  const parsed = result.status === 0 ? parsePsLine(result.stdout) : null;
  return parsed && {pid, ...parsed};
}

// The loopback listener on a port, or null. More than one listener is reported
// as ambiguous so a caller never picks a process to stop by position.
export function listener(port, {run = spawnSync, platform = process.platform} = {}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  if (platform === 'win32') {
    const script = `$c=@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue|Where-Object{$_.LocalAddress -eq '127.0.0.1'});if($c.Count -gt 1){'{"ambiguous":true}'}elseif($c.Count -eq 1){$id=$c[0].OwningProcess;${processScript('ProcessId=$id')}}`;
    const out = String(powershell(script, run).stdout || '');
    return /"ambiguous"/.test(out) ? {ambiguous: true} : parseWindowsProcess(out);
  }
  const result = run('lsof', ['-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-t'], {encoding: 'utf8', timeout: 5000});
  const pids = parseLsofPids(result.stdout);
  if (pids.length > 1) return {ambiguous: true};
  return pids.length ? processInfo(pids[0], {run, platform}) : null;
}

export function which(command, {env = process.env, exists = fs.existsSync, platform = process.platform} = {}) {
  const names = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''].map(ext => command + ext) : [command];
  const flavour = platform === 'win32' ? path.win32 : path.posix;
  for (const dir of String(env.PATH || env.Path || '').split(flavour.delimiter).filter(Boolean))
    for (const name of names) { const candidate = flavour.join(dir, name); if (exists(candidate)) return candidate; }
  return null;
}

export function openUrl(url, {run = spawnSync, platform = process.platform} = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}\//.test(url)) throw new Error('Only local pages are opened');
  if (platform === 'win32') return run('rundll32.exe', ['url.dll,FileProtocolHandler', url], {windowsHide: true, timeout: 10000}).status === 0;
  return run(platform === 'darwin' ? 'open' : 'xdg-open', [url], {timeout: 10000}).status === 0;
}

export async function fetchJson(url, {method = 'GET', headers = {}, body, timeoutMs = 4000} = {}) {
  const response = await fetch(url, {method, headers: {...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)});
  const text = await response.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return {ok: response.ok, status: response.status, data};
}
export const tryJson = async (url, options) => { try { const result = await fetchJson(url, options); return result.ok ? result.data : null; } catch { return null; } };

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
