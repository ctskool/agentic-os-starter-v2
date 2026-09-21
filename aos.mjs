#!/usr/bin/env node
// node aos.mjs setup | start | stop | status | doctor | jev-key | autostart | update
import {main} from './obsidian-v2/scripts/aos.mjs';

main().then(code => { process.exitCode = code; }).catch(error => { console.error(`\nStopped: ${error.message}`); process.exitCode = 1; });
