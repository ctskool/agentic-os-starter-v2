// The bridge's /events subscription against the ways a speech service can fail to accept it.
// An uncaught exception anywhere here fails the run: that is the point.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {speechEvents} from '../runner/speech-events.mjs';
import {createFakeSpeech} from './fixtures/fake-speech.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const until = async (condition, ms = 4000) => { const end = Date.now() + ms; while (!condition() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20)); return condition(); };

test('a socket that reports an error from inside close() cannot make the handler call itself', async t => {
  // What Node's WebSocket does for a connection that fails before it opens: 'error', never 'close',
  // and close() reports another error synchronously. `onerror = () => socket.close()` overflowed the stack here.
  const made = [];
  class FailsBeforeOpening { constructor() { made.push(this); this.readyState = 0; this.closes = 0; queueMicrotask(() => this.onerror?.()); } close() { this.closes++; this.onerror?.(); } }
  const link = speechEvents('ws://127.0.0.1:1/events', () => {}, {Socket: FailsBeforeOpening, retryMs: 30});
  t.after(() => link.stop());   // whatever fails below, nothing keeps retrying
  assert.ok(await until(() => made.length >= 4), 'it keeps retrying');
  assert.equal(link.connected(), false);
  link.stop(); const after = made.length;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(made.length, after, 'stop ends the retries');
  assert.ok(made.slice(0, -1).every(socket => socket.closes === 1), 'every failed socket was closed exactly once');
});

test('with the real WebSocket: nothing listening, and a service that answers /events with plain HTTP', async t => {
  const closed = http.createServer(), port = await listen(closed); await new Promise(resolve => closed.close(resolve));
  let attempts = 0;
  class Counted extends WebSocket { constructor(url) { super(url); attempts++; } }
  const refused = speechEvents(`ws://127.0.0.1:${port}/events`, () => {}, {Socket: Counted, retryMs: 40});
  t.after(() => refused.stop());
  assert.ok(await until(() => attempts >= 3), 'a refused connection is retried, not fatal');
  refused.stop();

  const plain = createFakeSpeech(), plainPort = await listen(plain);
  const link = speechEvents(`ws://127.0.0.1:${plainPort}/events`, () => {}, {retryMs: 40});
  t.after(() => { link.stop(); plain.closeAllConnections?.(); plain.close(); });
  assert.ok(await until(() => plain.seen.filter(call => call === 'GET /events').length >= 3), 'a plain HTTP answer is retried, not fatal');
  assert.equal(link.connected(), false);
});

test('a working socket delivers messages, and one that closes is connected again', async t => {
  const sockets = [];
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const text = Buffer.from(JSON.stringify({type: 'hello', n: sockets.length + 1}));
    socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]));
    socket.on('error', () => {}); sockets.push(socket);
  });
  const port = await listen(server), heard = [];
  const link = speechEvents(`ws://127.0.0.1:${port}/events`, event => heard.push(JSON.parse(String(event.data)).n), {retryMs: 40});
  t.after(() => { link.stop(); for (const socket of sockets) socket.destroy(); server.close(); });
  assert.ok(await until(() => heard.length === 1 && link.connected()));
  sockets[0].destroy();
  assert.ok(await until(() => heard.length === 2 && link.connected()), 'connected again after the service dropped the socket');
  link.stop();
  assert.ok(await until(() => !link.connected()));
});
