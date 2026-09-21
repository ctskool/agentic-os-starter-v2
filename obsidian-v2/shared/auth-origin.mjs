export function allowsAuthBootstrap(request, port) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url), host = request.headers.get('host') || url.host;
  if (url.protocol !== 'http:' || !['127.0.0.1:' + port, 'localhost:' + port].includes(host)) return false;
  const origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
  if (origin && origin !== `http://${host}`) return false;
  if (site && site !== 'same-origin') return false;
  return site === 'same-origin' || origin === `http://${host}`;
}
