import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const valid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const bridgeAuthFile = runtimeDir => path.join(runtimeDir, 'bridge-auth.json');
export const needsBridgeToken = method => !['GET', 'HEAD', 'OPTIONS'].includes((method || 'GET').toUpperCase());

export function readBridgeToken(runtimeDir) {
  try {
    const value = JSON.parse(fs.readFileSync(bridgeAuthFile(runtimeDir), 'utf8'));
    if (value.version === 1 && valid(value.token)) return value.token;
  } catch {}
  throw new Error('Bridge authentication is unavailable. Start the V2 bridge and try again.');
}

export function acceptsBridgeToken(method, headers, token) {
  if (!needsBridgeToken(method)) return true;
  const supplied = typeof headers?.get === 'function' ? headers.get('X-V2-Token') : headers?.['x-v2-token'];
  return valid(token) && valid(supplied) && crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(supplied, 'hex'));
}

// The bridge creates this once at boot. Consumers only read it; they never mint a replacement.
export function createBridgeAuth(runtimeDir) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const token = crypto.randomBytes(32).toString('hex'), file = bridgeAuthFile(runtimeDir);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, token, createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  return { token, file, accepts: (method, headers) => acceptsBridgeToken(method, headers, token) };
}
