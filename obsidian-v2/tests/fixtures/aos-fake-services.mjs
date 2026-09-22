// Stand-ins for the recovery monitor, the bridge, the HUD and a speech service, on a thread of
// their own. That matters: the tests freeze the main thread the way a real doctor run is frozen,
// and these servers must keep living (and keep closing idle connections) meanwhile, exactly as
// the real services do in their own processes.
//   new Worker(<this file>, {workerData: state})  ->  posts {ports: {...}, sharedUrl}
//   worker.postMessage({set: {...}})               ->  changes state, posts {done: true}
//   worker.postMessage({report: true})             ->  posts {seen: {speech: [...], bridge: [...], monitor: [...], connections: {bridge, monitor}}}
import http from 'node:http';
import {parentPort, workerData} from 'node:worker_threads';
import {createFakeSpeech} from './fake-speech.mjs';

// speech: 'shared' (another program's service), 'own' (on the port the doctor treats as ours), or 'none'
const state = {speech: 'shared', speechPhase: 'online', providers: {}, surfaces: [], keepAliveMs: 5000, bridgeOnline: true,
  hotkey: {enabled: true, combo: 'ctrl+alt+j', ok: true, error: null}, ...workerData};
const options = {keepAliveTimeout: state.keepAliveMs};
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
// Time is compressed for the tests: like a real local server these advertise the usual five-second
// keep-alive (so a client pools the connection), but they close an idle one after keepAliveMs. To a
// client that is frozen meanwhile this is exactly a real server closing at five seconds during a
// thirteen-second freeze.
const json = (res, status, value) => { res.writeHead(status, {'Content-Type': 'application/json', Connection: 'keep-alive', 'Keep-Alive': 'timeout=5'}); res.end(JSON.stringify(value)); };
const bridgeSeen = [], monitorSeen = [], connections = {bridge: 0, monitor: 0};

const speech = createFakeSpeech(state, options), speechPort = await listen(speech);
// The port the doctor is told is "this installation's own speech port". For 'own' that is the
// stand-in; otherwise a port nothing listens on.
const spare = http.createServer(), sparePort = await listen(spare); await new Promise(resolve => spare.close(resolve));
const ownPort = state.speech === 'own' ? speechPort : sparePort;
const speechUrl = () => `http://127.0.0.1:${state.speech === 'none' ? ownPort : speechPort}`;

const monitor = http.createServer(options, (req, res) => { monitorSeen.push(`${req.method} ${req.url}`); json(res, 200, {kind: 'agentic-os-service-supervisor', services: [
  {id: 'bridge', phase: 'online'}, {id: 'jarvis', phase: 'online'}, ...(state.speech === 'own' || state.monitorRunsSpeech ? [{id: 'speech', phase: state.speechPhase}] : [])]}); });
const hud = http.createServer(options, (req, res) => json(res, 200, {ok: true}));
const bridge = http.createServer(options, async (req, res) => {
  bridgeSeen.push(`${req.method} ${req.url}`);
  if (!state.bridgeOnline) { req.socket.destroy(); return; }
  // The same rule as the real bridge: healthy only when the speech service says so within 1.5 s.
  const speechHealth = async () => { try { const response = await fetch(`${speechUrl()}/health`, {signal: AbortSignal.timeout(1500)}); return response.ok ? {...await response.json(), ...(state.hotkey ? {hotkey: state.hotkey} : {}), ...(state.capture ? {capture: state.capture} : {})} : null; } catch { return null; } };
  if (req.url === '/services') return json(res, 200, {bridge: {online: true}, surfaces: state.surfaces, providers: state.providers,
    speech: {url: speechUrl(), shared: state.speech === 'shared', health: await speechHealth()}});
  if (req.url === '/voice/health') { const found = await speechHealth(); return json(res, 200, {ok: !!found?.ok && !!found?.stt?.ok, engine: 'Whisper / Kokoro', speech: found}); }
  json(res, 404, {error: 'not found'});
});

bridge.on('connection', () => connections.bridge++); monitor.on('connection', () => connections.monitor++);
const ports = {supervisor: await listen(monitor), bridge: await listen(bridge), jarvis: await listen(hud), speech: ownPort};
parentPort.on('message', message => {
  if (message.set) { Object.assign(state, message.set); parentPort.postMessage({done: true}); }
  if (message.report) parentPort.postMessage({seen: {speech: [...speech.seen], bridge: [...bridgeSeen], monitor: [...monitorSeen], connections: {...connections}}});
});
parentPort.postMessage({ports, sharedUrl: `http://127.0.0.1:${speechPort}`});
