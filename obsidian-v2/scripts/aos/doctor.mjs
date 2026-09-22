// The member's test. Every line is PASS, FAIL, WAIT (needs a click from the
// user) or SKIP, and every FAIL carries the one thing to do about it.
// Two promises to the reader: a check never disappears (a check that cannot run
// prints SKIP with the reason), and the same failure twice in a row stops
// saying "try again".
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {projectRoot} from '../../runner/runtime.mjs';
import {tryJson, probeJson, fetchJson, request, run, sleep} from './platform.mjs';
import {layout, PORTS, configuredVaultPath, speechInstalled} from './services.mjs';
import {pluginInstalled, pluginEnabled} from './vault.mjs';
import {hasJevKey} from './jev-key.mjs';
import {terminalSupport, VERIFIED_TERMINAL_VERSIONS, JARVIS_URL} from '../../shared/terminal-support.mjs';
import {recordedTerminalPython} from '../../runner/terminal-python-record.mjs';
import {terminalPythonWorks} from './terminal-python.mjs';

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const SUPERVISOR_LOG = 'obsidian-v2/.runtime/service-supervisor.jsonl';
const SHOW_SOMEONE = `Show your coding agent this line together with the last 30 lines of ${SUPERVISOR_LOG}, or post both in the community.`;
const VOICE_CHECKS = ['Voice service healthy', 'Text to speech', 'Speech to text hears it back'];
const HOTKEY_CHECK = 'Global voice shortcut';
const STILL_STARTING = new Set(['checking', 'starting', 'waiting_for_listener', 'backoff']);
const TERMINAL_CHECK = 'Terminal plugin (conversations inside Obsidian)';
const TERMINAL_PYTHON_CHECK = 'Python helper for conversations inside Obsidian';

// Only matters once the Terminal plugin is in use; the record exists only after setup verified it.
export function terminalPythonCheck(runtime, {terminal, recorded = recordedTerminalPython, works = python => terminalPythonWorks(python)} = {}) {
  if (terminal.status !== 'PASS' && terminal.status !== 'FAIL') return {status: 'SKIP', detail: 'not needed until the Terminal plugin is installed and switched on'};
  const fix = `Run \`node aos.mjs setup\` again (it needs Python 3.12: Windows \`winget install Python.Python.3.12\`, Mac \`xcode-select --install\`), or use the same buttons in Jarvis at ${JARVIS_URL}.`;
  const python = recorded(runtime);
  if (!python) return {status: 'FAIL', detail: 'not prepared', fix};
  // The record alone proves nothing today: the base Python may be gone or a module broken since.
  return works(python) ? {status: 'PASS', detail: 'prepared by setup and loads'} : {status: 'FAIL', detail: 'prepared by setup, but it no longer runs or loads its modules', fix};
}

// The optional Terminal community plugin, from the vault's own files. Never throws: whatever
// is wrong here, Jarvis still runs every conversation, so it can never be a core failure.
export function terminalPluginCheck(vault) {
  const reinstall = `Reinstall "Terminal" by polyipseity from Settings > Community plugins, or use the same buttons in Jarvis at ${JARVIS_URL}.`;
  if (!vault || !fs.existsSync(vault)) return {status: 'SKIP', detail: 'no vault configured'};
  const manifestFile = path.join(vault, '.obsidian', 'plugins', 'terminal', 'manifest.json');
  if (!fs.existsSync(manifestFile)) return {status: 'SKIP', detail: 'not installed (optional: conversations and personal-skill buttons run in Jarvis; to have them inside Obsidian, install "Terminal" by polyipseity from Settings > Community plugins)'};
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { return {status: 'FAIL', detail: 'its manifest.json could not be read', fix: reinstall}; }
  if (manifest?.id !== 'terminal') return {status: 'SKIP', detail: 'a different plugin occupies the .obsidian/plugins/terminal folder'};
  let enabled = false;
  try { const list = JSON.parse(fs.readFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), 'utf8')); enabled = Array.isArray(list) && list.includes('terminal'); }
  catch (error) { if (error.code !== 'ENOENT') return {status: 'SKIP', detail: 'could not read the enabled-plugins list (.obsidian/community-plugins.json)'}; }
  const support = terminalSupport(manifest.version);
  if (!enabled) return {status: 'SKIP', detail: `${support.version || 'installed'}, but switched off (optional: turn it on in Settings > Community plugins for conversations inside Obsidian)`};
  if (support.status === 'verified') return {status: 'PASS', detail: support.version};
  if (support.status === 'untested') return {status: 'PASS', detail: `${support.version}, newer than the tested ${VERIFIED_TERMINAL_VERSIONS.join(' and ')}; it should work`};
  if (support.status === 'missing') return {status: 'FAIL', detail: 'its manifest has no version', fix: reinstall};
  return {status: 'FAIL', detail: `version ${support.version}`, fix: support.message};
}

// Why the voice line failed, from what the bridge, the monitor and the disk say. Pure.
//   probe     - the answer of the bridge's /voice/health: {status, data, error}
//   speechUrl - the speech service the bridge uses; own - whether that is this installation's (3220)
export function voiceProblem({probe, speechUrl, own, installed, phase, waitedSeconds = 0}) {
  if (!probe.data) return {detail: `the bridge did not answer the voice check (${probe.error || `HTTP ${probe.status}`})`,
    fix: 'Run `node aos.mjs status`. If the bridge is not listed as online, run `node aos.mjs start`. If it is online, this is a fault in the check, not in your voice.'};
  if (!own) return {detail: `the shared speech service at ${speechUrl} stopped answering`,
    fix: 'That service belongs to another program on this computer: start that program again. To stop depending on it, run `node aos.mjs stop`, then `node aos.mjs setup --voice yes`: with nothing to share, this installation gets a voice of its own. (If you set AOS_V2_SPEECH_URL yourself, remove that setting first; setup says so when it is the cause.)'};
  if (!installed) return {detail: 'not installed', fix: 'Run `node aos.mjs setup --voice yes`.'};
  if (!phase) return {detail: 'installed, but the recovery monitor is not running it', fix: 'Run `node aos.mjs stop`, then `node aos.mjs start`: the service list is rebuilt at a start.'};
  if (phase === 'blocked') return {detail: 'its process keeps crashing and the monitor stopped restarting it',
    fix: `Read the last lines that mention "speech" in ${SUPERVISOR_LOG}. Then repair the files with \`node aos.mjs setup --voice yes\` and run \`node aos.mjs start --reset-recovery\`.`};
  if (STILL_STARTING.has(phase)) return {detail: `still not up after waiting ${waitedSeconds} seconds`,
    fix: {first: `The monitor reports it as "${phase}". A first start on a slow disk can need another minute: run \`node aos.mjs doctor\` once more. ${SUPERVISOR_LOG} shows what the service is doing.`,
      repeated: `It is not going to come up by waiting. Repair the voice files with \`node aos.mjs setup --voice yes\`, then \`node aos.mjs start --reset-recovery\`.`}};
  return {detail: 'its process is running but reports that it is not ready', fix: `Run \`node aos.mjs stop\`, then \`node aos.mjs start\`. If it repeats, repair the files with \`node aos.mjs setup --voice yes\`.`};
}

// The speech health response can report microphone or helper failures in hotkey.error.
// Only known conflict codes/messages justify telling the member to change keys.
export function hotkeyProblem({hotkey, capture, platform}) {
  const error = String(capture?.error || hotkey?.error || '').slice(0, 300);
  const detail = error || (capture?.available === false ? 'microphone support is unavailable' : 'the speech service could not register the shortcut');
  const inspect = `Read the lines that mention "speech" in ${SUPERVISOR_LOG}. ${SHOW_SOMEONE}`;
  if (/^Microphone dependency unavailable:/i.test(error) || capture?.available === false) return {detail,
    fix: {first: 'After finishing active tasks, run `node aos.mjs stop`, then `node aos.mjs setup --voice yes` to repair microphone support.',
      repeated: `Microphone support is still unavailable after the repair advice. ${inspect}`}};
  if (capture?.error || /^Capture failed:/i.test(error)) return {detail,
    fix: `Check the microphone input and microphone permission for the local Python speech process in ${platform === 'darwin' ? 'System Settings > Privacy & Security > Microphone' : 'Windows Settings > Privacy & security > Microphone (including desktop apps)'}. Then test the shortcut again. ${inspect}`};
  const launchSetting = "Change the speech service's launch configuration; a terminal-only environment change does not save a login setting.";
  if (/^(Use modifiers plus one letter or digit|A hotkey needs a letter or digit|Mac hotkeys (require Control or Command|support ANSI physical letter and digit keys))/i.test(error)) return {detail,
    fix: `Correct the invalid VOICE_HOTKEY setting, or remove the custom setting to restore ctrl+alt+j. Use modifiers plus one ASCII letter or digit; on Mac include ctrl (Control) or win (Command). ${launchSetting} Restart Agentic OS after finishing active tasks.`};
  // ERROR_HOTKEY_ALREADY_REGISTERED / eventHotKeyExistsErr. Other OS error
  // codes use the same "another app may own it" runtime text, so do not match it.
  if (/\(Windows error 1409\)|\(macOS error -9878\)|already (?:owned|registered)/i.test(error)) return {detail,
    fix: `Another app has registered the key combination. Free it or choose another VOICE_HOTKEY combination. ${launchSetting} Restart Agentic OS after finishing active tasks. ${platform === 'darwin' ? 'On Mac, use Control+Option for ctrl+alt.' : 'On Windows, use Ctrl+Alt for ctrl+alt.'} The HUD microphone button is an alternative while resolving this.`};
  if (/^(?:Mac )?hotkey (?:helper|registration timed out|event )|^Mac hotkeys must run on the macOS helper main thread/i.test(error)) return {detail,
    fix: {first: 'The shortcut listener failed to start or keep running. After finishing active tasks, run `node aos.mjs stop`, then `node aos.mjs start` once.',
      repeated: `The shortcut listener failed again. ${inspect}`}};
  return {detail, fix: `The shortcut failure's cause is not identified. ${inspect}`};
}

// phase 'install' = before the user has opened Obsidian: the plugin switch is WAIT, not FAIL.
// ports, runCommand, pause, now, voiceWaitMs and platform exist for the tests; members never pass them.
export async function doctor({root = projectRoot, ci = false, full = false, phase = 'ready', log = console.log,
  ports = PORTS, runCommand = run, pause = sleep, now = Date.now, voiceWaitMs = 90000, platform = process.platform} = {}) {
  const at = layout(root), setup = readJson(path.join(at.runtime, 'aos-setup.json')), results = [];
  const local = port => `http://127.0.0.1:${port}`;
  const memoryFile = path.join(at.runtime, 'aos-doctor-last.json'), before = readJson(memoryFile).failures || {}, failing = {};

  // fix is a sentence, or {first, repeated} when the second identical failure needs different advice.
  const add = (status, name, detail = '', fix = '', {optional = false} = {}) => {
    let lines = '';
    if (status === 'FAIL') {
      const repeats = before[name]?.detail === detail ? before[name].count : 0;
      failing[name] = {detail, count: repeats + 1};
      const advice = typeof fix === 'string' ? fix : (repeats && fix.repeated) || fix.first;
      if (advice) lines += `\n     fix: ${advice}`;
      if (repeats) lines += `\n     This is the same failure as the last run (${repeats + 1} in a row), so running the doctor again will not change it. ${SHOW_SOMEONE}`;
    }
    results.push({status, name, detail, optional});
    log(`${status.padEnd(4)} ${name}${detail ? ' - ' + detail : ''}${lines}`);
  };
  const reported = name => results.some(item => item.name === name);
  // A group of checks that depend on each other. `names` is every line the group owes: whatever
  // ends it early (a failed step, a thrown error), the lines it did not reach are printed as SKIP.
  const group = async (names, fn, {optional = false} = {}) => {
    let reason = '';
    try { reason = (await fn()) || ''; }
    catch (error) {
      add('FAIL', names.find(name => !reported(name)) || `${names[0]} (unexpected error)`, String(error.code || error.message || error).slice(0, 300),
        {first: 'Run `node aos.mjs doctor` once more.', repeated: 'This is a fault, not a hiccup.'}, {optional});
    }
    const failedStep = names.find(name => results.some(item => item.name === name && item.status === 'FAIL'));
    for (const name of names) if (!reported(name)) add('SKIP', name, `not run: ${reason || (failedStep ? `"${failedStep}" did not pass` : 'an earlier step did not finish')}`);
  };

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 22 ? 'PASS' : 'FAIL', 'Node.js 22 or newer', process.versions.node, 'Install the current LTS from nodejs.org, open a new terminal, run setup again.');

  // Asked first, printed in their usual place: the plugin line below needs the bridge's answer.
  let supervisor = await tryJson(`${local(ports.supervisor)}/status`);
  const services = await tryJson(`${local(ports.bridge)}/services`, {timeoutMs: 6000});
  const hud = await tryJson(`${local(ports.jarvis)}/api/state`, {timeoutMs: 15000});

  const vault = configuredVaultPath(at);
  await group(['Vault configured', 'Vault has the daily-note schema', 'Obsidian plugin files installed', 'Plugin switched on in Obsidian'], async () => {
    if (!vault || !fs.existsSync(vault)) { add('FAIL', 'Vault configured', vault || 'none', 'Run `node aos.mjs setup --vault "<absolute path>"`.'); return; }
    add('PASS', 'Vault configured', vault);
    add(fs.existsSync(path.join(vault, 'system', 'schemas', 'daily-note.md')) ? 'PASS' : 'FAIL', 'Vault has the daily-note schema', '', 'Run setup again; it adds missing template files and never overwrites notes.');
    add(pluginInstalled(vault) ? 'PASS' : 'FAIL', 'Obsidian plugin files installed', '', 'Run `node aos.mjs setup --vault "<path>"` again.');
    // A new vault arrives with the plugin already listed as enabled, which proves nothing: Obsidian
    // still asks the user to trust it the first time the vault is opened. Proof is the cockpit
    // being connected to the bridge right now, or Obsidian having opened this vault before.
    const connected = (services?.surfaces || []).some(surface => surface.kind === 'native');
    const openedBefore = ['workspace.json', 'workspace-mobile.json', 'app.json', 'appearance.json'].some(name => fs.existsSync(path.join(vault, '.obsidian', name)));
    const needsUser = phase === 'install' || ci ? 'WAIT' : 'FAIL';
    if (pluginEnabled(vault) && (connected || openedBefore)) add('PASS', 'Plugin switched on in Obsidian', connected ? 'the cockpit is connected right now' : '');
    else if (pluginEnabled(vault)) add(needsUser, 'Plugin switched on in Obsidian', 'ready in this new vault, but Obsidian has not opened it yet', 'Open Obsidian -> "Open folder as vault" -> choose the vault folder -> "Trust author and enable plugins".');
    else add(needsUser, 'Plugin switched on in Obsidian', 'needs the user', 'In Obsidian: Settings > Community plugins -> turn on community plugins -> enable "Agentic OS V2".');
  });
  await group([TERMINAL_CHECK, TERMINAL_PYTHON_CHECK], () => {
    const check = terminalPluginCheck(vault);
    add(check.status, TERMINAL_CHECK, check.detail, check.fix || '', {optional: true});
    const python = terminalPythonCheck(at.runtime, {terminal: check});
    add(python.status, TERMINAL_PYTHON_CHECK, python.detail, python.fix || '', {optional: true});
  }, {optional: true});

  add(supervisor ? 'PASS' : 'FAIL', 'Recovery monitor running', supervisor ? `${supervisor.services.length} services watched` : '', 'Run `node aos.mjs start`.');
  add(services?.bridge?.online ? 'PASS' : 'FAIL', `Bridge answering on ${ports.bridge}`, '', `Run \`node aos.mjs start\`, wait 20 seconds, then look at ${SUPERVISOR_LOG}.`);
  add(hud ? 'PASS' : 'FAIL', `Jarvis HUD answering on ${ports.jarvis}`, '', 'Run `node aos.mjs setup` again to build the HUD, then `node aos.mjs start`.');
  const bridgeDown = 'the bridge is not answering (see the FAIL above)';

  const signedIn = [], installed = [];
  for (const provider of ['claude', 'codex']) {
    const info = services?.providers?.[provider];
    if (!services) { add('SKIP', `${provider} CLI`, `not checked: ${bridgeDown}`); continue; }
    if (!info?.installed) { add('SKIP', `${provider} CLI`, 'not installed (one provider is enough)'); continue; }
    installed.push(provider);
    add('PASS', `${provider} CLI found`, String(info.version || '').slice(0, 60));
    if (ci) { add('SKIP', `${provider} signed in`, 'not checked with --ci'); continue; }
    await group([`${provider} signed in`], async () => {
      const args = provider === 'claude' ? ['--print', '--model', 'haiku', 'Reply with the single word OK.'] : ['exec', '--skip-git-repo-check', '-s', 'read-only', 'Reply with the single word OK.'];
      // Not spawnSync: a CLI can take two minutes to answer, and a frozen doctor cannot keep a timer or a connection alive.
      const result = await runCommand(info.command, args, {timeoutMs: 120000, cwd: at.runtime, input: ''});
      if (result.status === 0 && /\bOK\b/i.test(result.stdout || '')) { signedIn.push(provider); add('PASS', `${provider} signed in`); }
      else add('FAIL', `${provider} signed in`, result.timedOut ? 'no reply within two minutes' : 'no reply', `Open a terminal, run \`${provider}\`, sign in, then run the doctor again.`, {optional: true});
    }, {optional: true});
  }
  if (!ci && services && !installed.length) add('FAIL', 'At least one of Claude Code or Codex', 'neither found', 'Install Claude Code or Codex, sign in, then run `node aos.mjs setup` again so its location is saved.');
  else if (!ci && installed.length && !signedIn.length) add('FAIL', 'A provider that is signed in', `${installed.join(' and ')} installed, none answered`, 'Nothing can run without one. Open a terminal, run `claude` or `codex`, sign in, then run the doctor again.');

  if (setup.voice === false) {
    add('SKIP', 'Voice', 'not installed (add later: `node aos.mjs setup --voice yes`)');
    add('SKIP', HOTKEY_CHECK, 'voice was not enabled');
  } else await group([VOICE_CHECKS[0], HOTKEY_CHECK, ...VOICE_CHECKS.slice(1)], async () => {
    if (!services?.bridge?.online) return bridgeDown;
    const healthUrl = `${local(ports.bridge)}/voice/health`, speechUrl = services.speech?.url || local(ports.speech), own = speechUrl === local(ports.speech);
    const speechPhase = () => supervisor?.services?.find(service => service.id === 'speech')?.phase || '';
    // What the monitor says NOW: the sign-in checks above can take minutes, and a service may have
    // come up, crashed or been given up on meanwhile.
    const refresh = async () => { supervisor = await tryJson(`${local(ports.supervisor)}/status`, {timeoutMs: 2000}) || supervisor; };
    await refresh();
    let probe = await probeJson(healthUrl, {timeoutMs: 8000});
    // Our own service loads its models before it opens its port. Wait for that here, once,
    // instead of sending the person round in circles with "run the doctor again". The limit is on
    // the clock, slow probes included (the last round can run over by one probe, never by more),
    // and the wait ends as soon as the monitor stops calling it "starting".
    if (!probe.data?.ok && own && speechInstalled(at) && STILL_STARTING.has(speechPhase())) {
      log(`     voice is still loading its models; waiting up to ${Math.round(voiceWaitMs / 1000)} seconds ...`);
      const started = now(), left = () => voiceWaitMs - (now() - started);
      while (!probe.data?.ok && STILL_STARTING.has(speechPhase()) && left() > 0) {
        await pause(Math.min(3000, left())); await refresh();
        probe = await probeJson(healthUrl, {timeoutMs: 8000});
      }
    }
    if (!probe.data?.ok) {
      // The configured limit, not the measured time: the line must read the same on the next run for a repeat to be recognised.
      const problem = voiceProblem({probe, speechUrl, own, installed: speechInstalled(at), phase: speechPhase(), waitedSeconds: Math.round(voiceWaitMs / 1000)});
      add('FAIL', VOICE_CHECKS[0], problem.detail, problem.fix, {optional: true}); return;
    }
    const whose = own ? `this installation's own service on ${ports.speech}` : `shared service at ${speechUrl}, run by another program on this computer`;
    add('PASS', VOICE_CHECKS[0], `${probe.data.engine ? probe.data.engine + ', ' : ''}${whose}`);
    // Use the fresh health response: provider sign-in and model loading can outlive
    // the initial /services snapshot. Registration is not proof of microphone access.
    const hotkey = probe.data.speech?.hotkey;
    if (!own) add('SKIP', HOTKEY_CHECK, 'the shared speech service is managed by another program');
    else if (!['darwin', 'win32'].includes(platform)) add('SKIP', HOTKEY_CHECK, 'supported on Mac and Windows; use the voice orb on this platform');
    else if (hotkey?.enabled === false) add('SKIP', HOTKEY_CHECK, 'disabled by the voice service configuration');
    else if (ci) add('SKIP', HOTKEY_CHECK, 'not checked with --ci; run the doctor in your interactive desktop session');
    else if (hotkey?.enabled !== true || typeof hotkey.ok !== 'boolean') add('WAIT', HOTKEY_CHECK, 'the running speech service does not report shortcut registration; update the starter and restart its services, then run the doctor again');
    else if (hotkey.ok) add('PASS', HOTKEY_CHECK, `${hotkey.combo || 'configured shortcut'} registered; microphone capture and use from another app still need a hands-on test`);
    else {
      const problem = hotkeyProblem({hotkey, capture: probe.data.speech?.capture, platform});
      add('FAIL', HOTKEY_CHECK, problem.detail, problem.fix, {optional: true});
    }
    // The same two calls the bridge makes, against the same service, own or shared.
    const repair = own ? 'Run `node aos.mjs setup --voice yes` again to repair the voice files.' : `The shared speech service at ${speechUrl} answers its health check but cannot do this; restart the program that runs it.`;
    const spoken = await request(`${speechUrl}/speak?text=${encodeURIComponent('Voice check, one two three.')}`, {timeoutMs: 60000});
    if (!spoken.ok || spoken.body.length < 5000) { add('FAIL', VOICE_CHECKS[1], `status ${spoken.status}, ${spoken.body.length} bytes`, repair, {optional: true}); return; }
    add('PASS', VOICE_CHECKS[1], `${Math.round(spoken.body.length / 1024)} KB of audio`);
    const heard = await request(`${speechUrl}/stt`, {method: 'POST', headers: {'Content-Type': 'audio/wav'}, body: spoken.body, timeoutMs: 120000});
    let text = ''; try { text = heard.ok ? String(JSON.parse(heard.body.toString('utf8')).text || '') : ''; } catch { /* not JSON */ }
    add(/voice|check|one|two|three/i.test(text) ? 'PASS' : 'FAIL', VOICE_CHECKS[2], heard.ok ? text.slice(0, 60) || 'heard nothing' : `status ${heard.status}`, repair, {optional: true});
  }, {optional: true});

  if (!hasJevKey(at.runtime)) add('SKIP', 'Jev fast voice routing', 'no OpenRouter key saved (optional: `node aos.mjs jev-key`)');
  else if (ci) add('PASS', 'Jev key saved');
  else await group(['Jev fast voice routing'], async () => {
    const {readJevConfig, jevState, classifyJev} = await import('../../runner/jev.mjs');
    const config = readJevConfig();
    try {
      const result = await classifyJev(jevState({transcript: 'What is on my schedule today?'}), {key: config.key, deadlineMs: 8000, tier2kind: config.tier2kind, rulebook: config.rulebook});
      add('PASS', 'Jev fast voice routing', `answered in ${Math.round(result.ms)} ms`);
    } catch (error) {
      // Timings differ per run; keep the detail stable so a repeat is recognised.
      add('FAIL', 'Jev fast voice routing', String(error.message).replace(/\d+(\.\d+)? ?ms/g, 'N ms'), /HTTP 40[13]/.test(error.message) ? 'The key was refused. Run `node aos.mjs jev-key` and paste a fresh key from openrouter.ai/keys.' : /HTTP 402/.test(error.message) ? 'The OpenRouter account has no credit. Add a few dollars at openrouter.ai/credits.' : 'Check the internet connection. Voice still works without Jev, only slower.', {optional: true});
    }
  }, {optional: true});

  const WORKFLOW = 'A real workflow end to end';
  if (!full) add('SKIP', WORKFLOW, 'not asked for (`node aos.mjs doctor --full` includes it)');
  else if (ci) add('SKIP', WORKFLOW, 'not run with --ci');
  else await group([WORKFLOW], async () => {
    if (!services?.bridge?.online) return bridgeDown;
    const token = JSON.parse(fs.readFileSync(at.auth, 'utf8')).token, id = crypto.randomUUID();
    const started = await fetchJson(`${local(ports.bridge)}/work/skill`, {method: 'POST', headers: {'X-V2-Token': token, 'X-V2-App': 'web'}, body: {id, skill: 'vault-summary'}, timeoutMs: 15000});
    if (!started.ok) { add('FAIL', WORKFLOW, started.data?.error || `status ${started.status}`, 'Sign in to the selected provider, then run `node aos.mjs doctor --full` again. If the selected provider is not the one you use, switch with `node aos.mjs setup --provider claude` (or `codex`).'); return; }
    for (let waited = 0; waited < 300; waited += 3) {
      await pause(3000);
      const task = (await tryJson(`${local(ports.bridge)}/work`, {timeoutMs: 8000}))?.tasks?.find(item => item.id === id);
      const destination = task?.workflow?.destination;
      if (task?.state === 'stopped' && !task.error && destination && fs.existsSync(path.join(vault, destination))) { add('PASS', WORKFLOW, destination); return; }
      if (task && (task.state === 'error' || task.state === 'needs input' || (task.state === 'stopped' && task.error))) { add('FAIL', WORKFLOW, String(task.error || task.state).slice(0, 200), `Open the HUD at ${local(ports.jarvis)}, look at the failed task in History, and show its message to your coding agent.`); return; }
    }
    add('FAIL', WORKFLOW, 'no result after 5 minutes', 'Open the HUD, check the task under Terminals, and show what it says to your coding agent.');
  });

  try { fs.mkdirSync(at.runtime, {recursive: true}); fs.writeFileSync(memoryFile, JSON.stringify({failures: failing}, null, 1)); } catch { /* a read-only folder only loses the repeat detection */ }

  const fails = results.filter(item => item.status === 'FAIL'), core = fails.filter(item => !item.optional), waiting = results.filter(item => item.status === 'WAIT').length;
  const listed = items => items.map(item => item.name).join(', ');
  log(`\n${!fails.length ? (waiting ? 'Everything installed. Waiting on the step(s) marked WAIT.' : 'All checks passed.')
    : !core.length ? `The core system is installed and working. ${fails.length} optional part(s) need attention: ${listed(fails)}. Each FAIL line above says what to do; everything else can be used now.`
    : `${fails.length} check(s) failed, including core parts (${listed(core)}). Work through the fix lines from the top.`}`);
  return {ok: fails.length === 0, failed: fails.length, coreFailed: core.length, waiting, results};
}
