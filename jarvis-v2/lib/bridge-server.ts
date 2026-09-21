import path from 'node:path';
import { readBridgeToken, needsBridgeToken } from '../../obsidian-v2/runner/bridge-auth.mjs';

const runtimeDir = () => path.resolve(process.cwd(), '../obsidian-v2/.runtime');
export const serverBridgeToken = () => readBridgeToken(runtimeDir());

export async function serverBridge(endpoint: string, body?: unknown, timeoutMs = 5000, method = body === undefined ? 'GET' : 'POST') {
  const send = () => fetch('http://127.0.0.1:3219' + endpoint, {
    method, headers: { 'Content-Type': 'application/json', ...(needsBridgeToken(method) ? { 'X-V2-Token': serverBridgeToken() } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
  });
  let response = await send();
  if (response.status === 401 && needsBridgeToken(method)) { await response.body?.cancel(); response = await send(); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'V2 bridge unavailable');
  return result;
}
