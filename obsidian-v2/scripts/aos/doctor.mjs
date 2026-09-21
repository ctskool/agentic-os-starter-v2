// The member's test. Every line is PASS, FAIL, WAIT (needs a click from the
// user) or SKIP, and every FAIL carries the one thing to do about it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {projectRoot} from '../../runner/runtime.mjs';
import {tryJson, fetchJson, sleep} from './platform.mjs';
import {layout, PORTS, configuredVaultPath, speechInstalled} from './services.mjs';
import {pluginInstalled, pluginEnabled} from './vault.mjs';
import {hasJevKey} from './jev-key.mjs';

const local = port => `http://127.0.0.1:${port}`;
const readSetup = at => { try { return JSON.parse(fs.readFileSync(path.join(at.runtime, 'aos-setup.json'), 'utf8')); } catch { return {}; } };

// phase 'install' = before the user has opened Obsidian: the plugin switch is WAIT, not FAIL.
export async function doctor({root = projectRoot, ci = false, full = false, phase = 'ready', log = console.log} = {}) {
  const at = layout(root), setup = readSetup(at), results = [];
  const add = (status, name, detail = '', fix = '') => { results.push({status, name, detail, fix}); log(`${status.padEnd(4)} ${name}${detail ? ' - ' + detail : ''}${status === 'FAIL' && fix ? `\n     fix: ${fix}` : ''}`); };
  const check = async (name, fn) => { try { await fn(); } catch (error) { add('FAIL', name, String(error.message || error).slice(0, 300), 'Run `node aos.mjs doctor` again; if it repeats, show this line to your coding agent.'); } };

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 22 ? 'PASS' : 'FAIL', 'Node.js 22 or newer', process.versions.node, 'Install the current LTS from nodejs.org, open a new terminal, run setup again.');

  const vault = configuredVaultPath(at);
  if (!vault || !fs.existsSync(vault)) add('FAIL', 'Vault configured', vault || 'none', 'Run `node aos.mjs setup --vault "<absolute path>"`.');
  else {
    add('PASS', 'Vault configured', vault);
    add(fs.existsSync(path.join(vault, 'system', 'schemas', 'daily-note.md')) ? 'PASS' : 'FAIL', 'Vault has the daily-note schema', '', 'Run setup again; it adds missing template files and never overwrites notes.');
    add(pluginInstalled(vault) ? 'PASS' : 'FAIL', 'Obsidian plugin files installed', '', 'Run `node aos.mjs setup --vault "<path>"` again.');
    if (pluginEnabled(vault)) add('PASS', 'Plugin switched on in Obsidian');
    else add(phase === 'install' || ci ? 'WAIT' : 'FAIL', 'Plugin switched on in Obsidian', 'needs the user', 'In Obsidian: Settings > Community plugins -> turn on community plugins -> enable "Agentic OS V2".');
  }

  const supervisor = await tryJson(`${local(PORTS.supervisor)}/status`);
  add(supervisor ? 'PASS' : 'FAIL', 'Recovery monitor running', supervisor ? `${supervisor.services.length} services watched` : '', 'Run `node aos.mjs start`.');
  const services = await tryJson(`${local(PORTS.bridge)}/services`, {timeoutMs: 6000});
  add(services?.bridge?.online ? 'PASS' : 'FAIL', 'Bridge answering on 3219', '', 'Run `node aos.mjs start`, wait 20 seconds, then look at .runtime/service-supervisor.jsonl.');
  const hud = await tryJson(`${local(PORTS.jarvis)}/api/state`, {timeoutMs: 15000});
  add(hud ? 'PASS' : 'FAIL', 'Jarvis HUD answering on 3217', '', 'Run `node aos.mjs setup` again to build the HUD, then `node aos.mjs start`.');

  for (const provider of ['claude', 'codex']) {
    const info = services?.providers?.[provider];
    if (!info?.installed) { add('SKIP', `${provider} CLI`, 'not installed (one provider is enough)'); continue; }
    add('PASS', `${provider} CLI found`, String(info.version || '').slice(0, 60));
    if (ci) continue;
    await check(`${provider} signed in`, async () => {
      const args = provider === 'claude' ? ['--print', '--model', 'haiku', 'Reply with the single word OK.'] : ['exec', '--skip-git-repo-check', '-s', 'read-only', 'Reply with the single word OK.'];
      const result = spawnSync(info.command, args, {encoding: 'utf8', timeout: 120000, windowsHide: true, cwd: at.runtime, input: ''});
      if (result.status === 0 && /\bOK\b/i.test(result.stdout || '')) add('PASS', `${provider} signed in`);
      else add('FAIL', `${provider} signed in`, 'no reply', `Open a terminal, run \`${provider}\`, sign in, then run doctor again.`);
    });
  }
  if (!ci && services && !['claude', 'codex'].some(provider => services.providers?.[provider]?.installed)) add('FAIL', 'At least one of Claude Code or Codex', 'neither found', 'Install Claude Code or Codex, sign in, then run `node aos.mjs setup` again so its location is saved.');

  if (setup.voice === false) add('SKIP', 'Voice', 'not installed (add later: `node aos.mjs setup --voice yes`)');
  else await check('Voice', async () => {
    const health = await tryJson(`${local(PORTS.bridge)}/voice/health`, {timeoutMs: 8000});
    if (!health?.ok) return add('FAIL', 'Voice service healthy', speechInstalled(at) ? 'installed but not answering yet' : 'not installed', speechInstalled(at) ? 'The voice models take up to a minute to load after a start; run doctor again. Then check .runtime/service-supervisor.jsonl.' : 'Run `node aos.mjs setup --voice yes`.');
    add('PASS', 'Voice service healthy', health.engine || '');
    const speech = services?.speech?.url || local(PORTS.speech);
    const spoken = await fetch(`${speech}/speak?text=${encodeURIComponent('Voice check, one two three.')}`, {signal: AbortSignal.timeout(60000)});
    const wav = Buffer.from(await spoken.arrayBuffer());
    if (!spoken.ok || wav.length < 5000) return add('FAIL', 'Text to speech', `status ${spoken.status}`, 'Run `node aos.mjs setup --voice yes` again to repair the voice files.');
    add('PASS', 'Text to speech', `${Math.round(wav.length / 1024)} KB of audio`);
    const heard = await fetch(`${speech}/stt`, {method: 'POST', body: wav, signal: AbortSignal.timeout(120000)});
    const text = heard.ok ? String((await heard.json()).text || '') : '';
    add(/voice|check|one|two|three/i.test(text) ? 'PASS' : 'FAIL', 'Speech to text hears it back', text.slice(0, 60), 'Run `node aos.mjs setup --voice yes` again to repair the speech model.');
  });

  if (!hasJevKey(at.runtime)) add('SKIP', 'Jev fast voice routing', 'no OpenRouter key saved (optional: `node aos.mjs jev-key`)');
  else if (ci) add('PASS', 'Jev key saved');
  else await check('Jev fast voice routing', async () => {
    const {readJevConfig, jevState, classifyJev} = await import('../../runner/jev.mjs');
    const config = readJevConfig();
    try {
      const result = await classifyJev(jevState({transcript: 'What is on my schedule today?'}), {key: config.key, deadlineMs: 8000, tier2kind: config.tier2kind, rulebook: config.rulebook});
      add('PASS', 'Jev fast voice routing', `answered in ${Math.round(result.ms)} ms`);
    } catch (error) {
      add('FAIL', 'Jev fast voice routing', String(error.message), /HTTP 40[13]/.test(error.message) ? 'The key was refused. Run `node aos.mjs jev-key` and paste a fresh key from openrouter.ai/keys.' : /HTTP 402/.test(error.message) ? 'The OpenRouter account has no credit. Add a few dollars at openrouter.ai/credits.' : 'Check the internet connection and run doctor again. Voice still works without Jev, only slower.');
    }
  });

  if (full && !ci && services?.bridge?.online) await check('A real workflow end to end', async () => {
    const token = JSON.parse(fs.readFileSync(at.auth, 'utf8')).token, id = crypto.randomUUID();
    const started = await fetchJson(`${local(PORTS.bridge)}/work/skill`, {method: 'POST', headers: {'X-V2-Token': token, 'X-V2-App': 'web'}, body: {id, skill: 'vault-summary'}, timeoutMs: 15000});
    if (!started.ok) return add('FAIL', 'A real workflow end to end', started.data?.error || `status ${started.status}`, 'Sign in to the selected provider, then run `node aos.mjs doctor --full` again.');
    for (let waited = 0; waited < 300; waited += 3) {
      await sleep(3000);
      const task = (await tryJson(`${local(PORTS.bridge)}/work`, {timeoutMs: 8000}))?.tasks?.find(item => item.id === id);
      const destination = task?.workflow?.destination;
      if (task?.state === 'stopped' && !task.error && destination && fs.existsSync(path.join(vault, destination))) return add('PASS', 'A real workflow end to end', destination);
      if (task && (task.state === 'error' || task.state === 'needs input' || (task.state === 'stopped' && task.error))) return add('FAIL', 'A real workflow end to end', String(task.error || task.state).slice(0, 200), 'Open the HUD at http://127.0.0.1:3217, look at the failed task in History, and show its message to your coding agent.');
    }
    add('FAIL', 'A real workflow end to end', 'no result after 5 minutes', 'Open the HUD, check the task under Terminals, then run doctor again.');
  });

  const failed = results.filter(item => item.status === 'FAIL').length, waiting = results.filter(item => item.status === 'WAIT').length;
  log(`\n${failed ? `${failed} check(s) failed.` : waiting ? 'Everything installed. Waiting on the step(s) marked WAIT.' : 'All checks passed.'}`);
  return {ok: failed === 0, failed, waiting, results};
}
