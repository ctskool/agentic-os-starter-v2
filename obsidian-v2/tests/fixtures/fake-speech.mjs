// A stand-in for a speech service that some OTHER program runs on this computer (the situation
// "borrowed voice" exists for). It answers the three calls the bridge and the doctor make and
// deliberately does NOT identify itself as this system's own service.
//   node tests/fixtures/fake-speech.mjs --port 3108      (CI runs it as the foreign service)
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Half a second of a 440 Hz tone as a 16-bit mono WAV (about 16 KB).
export function toneWav(seconds = 0.5, rate = 16000) {
  const samples = Math.floor(seconds * rate), data = Buffer.alloc(samples * 2), header = Buffer.alloc(44);
  for (let index = 0; index < samples; index++) data.writeInt16LE(Math.round(Math.sin(index / rate * 2 * Math.PI * 440) * 8000), index * 2);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// state: {healthy, canSpeak, hears} read on every request, so a test can change it while running.
// quit: true adds POST /quit, which ends the process (how CI makes "the other program" go away).
export function createFakeSpeech(state = {}, {keepAliveTimeout = 5000, quit = false} = {}) {
  const seen = [];
  const server = http.createServer({keepAliveTimeout}, (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    seen.push(`${req.method} ${url.pathname}`);
    const json = (status, value) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && url.pathname === '/health') return state.healthy === false ? json(503, {ok: false}) : json(200, {ok: true, engine: 'stand-in', stt: {ok: true}});
    if (req.method === 'GET' && url.pathname === '/speak') {
      if (state.canSpeak === false || !url.searchParams.get('text')) return json(500, {error: 'cannot speak'});
      res.writeHead(200, {'Content-Type': 'audio/wav'}); return res.end(toneWav());
    }
    if (req.method === 'POST' && url.pathname === '/stt') {
      let size = 0; req.on('data', chunk => { size += chunk.length; });
      return req.on('end', () => size < 1000 ? json(400, {error: 'too short'}) : json(200, {text: state.hears ?? 'Voice check, one two three.'}));
    }
    if (quit && req.method === 'POST' && url.pathname === '/quit') { json(200, {ok: true}); return setTimeout(() => process.exit(0), 50); }
    json(404, {error: 'not found'});
  });
  server.seen = seen;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--port'), port = Number(at > 0 ? process.argv[at + 1] : 3108);
  createFakeSpeech({}, {quit: true}).listen(port, '127.0.0.1', () => console.log(`stand-in speech service on 127.0.0.1:${port}`));
}
