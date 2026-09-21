#!/usr/bin/env node
// One command for every install, on Windows and macOS alike:
//   node aos.mjs setup --vault "<path>" [--voice yes|no] [--autostart yes|no]
//   node aos.mjs start | stop | status | doctor [--full] | jev-key | autostart on|off | update
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {layout, start, stop, status} from './aos/services.mjs';
import {disableAutostart} from './aos/autostart.mjs';
import {collectJevKey, hasJevKey} from './aos/jev-key.mjs';
import {doctor} from './aos/doctor.mjs';
import {setup, update, startAtLogin} from './aos/setup.mjs';

const HELP = `Agentic OS V2

  setup --vault "<path>" [--voice yes|no] [--autostart yes|no] [--rebuild]
                      install or repair everything, then run the checks
  start               start the local services (bridge, Jarvis HUD, voice)
  stop                stop them (refuses while a task is open)
  status              what is running
  doctor [--full]     PASS / FAIL checks; --full also runs one real workflow
  jev-key             open a local page to save your OpenRouter key (never shown to an agent)
  autostart on|off    start at login
  update              get the latest version and rebuild
`;

export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv, flags = {}, words = [];
  for (let index = 0; index < rest.length; index++) {
    const item = rest[index];
    if (!item.startsWith('--')) { words.push(item); continue; }
    const name = item.slice(2), next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[name] = next; index++; } else flags[name] = true;
  }
  return {command, flags, words};
}
const yesNo = (value, name) => { if (value === undefined) return undefined; if (['yes', 'true', true].includes(value)) return true; if (['no', 'false'].includes(value)) return false; throw new Error(`--${name} takes yes or no`); };

export async function main(argv = process.argv.slice(2), log = console.log) {
  const {command, flags, words} = parseArgs(argv);
  switch (command) {
    case 'setup': return (await setup({vault: typeof flags.vault === 'string' ? flags.vault : undefined, voice: yesNo(flags.voice, 'voice'), autostart: yesNo(flags.autostart, 'autostart'), rebuild: flags.rebuild === true, ci: flags.ci === true, adopt: flags.adopt === true, log})).ok ? 0 : 1;
    case 'start': await start({preview: flags.preview === true, resetRecovery: flags['reset-recovery'] === true, log}); return 0;
    case 'stop': await stop({log}); return 0;
    case 'status': log(JSON.stringify(await status(), null, 1)); return 0;
    case 'doctor': return (await doctor({ci: flags.ci === true, full: flags.full === true, phase: flags.phase === 'install' ? 'install' : 'ready', log})).ok ? 0 : 1;
    case 'jev-key': {
      if (flags.check === true) { log(JSON.stringify({saved: hasJevKey(layout().runtime)})); return 0; }
      const result = await collectJevKey({runtimeDir: layout().runtime, announce: url => log(`A page opened in your browser. If it did not, open this address yourself:\n${url}\nWaiting up to five minutes ...`)});
      log(JSON.stringify(result));
      if (result.saved) log('Saved. The voice router picks it up within a few seconds; no restart needed.');
      return result.saved ? 0 : 1;
    }
    case 'autostart': {
      if (!['on', 'off'].includes(words[0])) throw new Error('Use: autostart on  or  autostart off');
      if (words[0] === 'on') await startAtLogin({log}); else log(disableAutostart(layout()));
      return 0;
    }
    case 'update': return (await update({log})).ok ? 0 : 1;
    default: log(HELP); return command === 'help' ? 0 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(`\nStopped: ${error.message}`); process.exitCode = 1; });
}
