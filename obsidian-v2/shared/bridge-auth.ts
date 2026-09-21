export type BridgeAuthorization = (refresh?: boolean) => Promise<string>;
const mutates = (method = 'GET') => !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
export { allowsAuthBootstrap } from './auth-origin.mjs';

export function createBrowserBridgeAuth(endpoint: string): BridgeAuthorization {
  let token = '', flight: Promise<string> | null = null;
  return async (refresh = false) => {
    if (refresh) token = '';
    if (token) return token;
    if (!flight) flight = (async () => {
      const response = await fetch(endpoint, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Bridge authentication is unavailable. Start V2 services and try again.');
      const result = await response.json();
      if (!/^[a-f0-9]{64}$/.test(result.token)) throw new Error('Invalid bridge authentication response');
      return token = result.token;
    })().finally(() => { flight = null; });
    return flight;
  };
}

export async function authorizedBridgeFetch(url: string, options: RequestInit, authorize?: BridgeAuthorization): Promise<Response> {
  if (!authorize || !mutates(options.method)) return fetch(url, options);
  const send = async (refresh: boolean) => {
    const token = await authorize(refresh);
    options.signal?.throwIfAborted();
    const headers = new Headers(options.headers); headers.set('X-V2-Token', token);
    return fetch(url, { ...options, headers });
  };
  let response = await send(false);
  // The bridge returns 401 before dispatch. Never replay failed work or network errors.
  if (response.status === 401) { await response.body?.cancel(); response = await send(true); }
  return response;
}
