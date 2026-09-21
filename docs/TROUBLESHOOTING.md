# Troubleshooting

Start with `node aos.mjs doctor`. Every FAIL line carries its own fix. This page covers what the doctor cannot see.

## Where to look

| What | Where |
|---|---|
| Which services are up | `node aos.mjs status` |
| Why a service keeps restarting | `obsidian-v2/.runtime/service-supervisor.jsonl` (one line per event) |
| Monitor would not start at login | `obsidian-v2/.runtime/service-supervisor-startup-error.log` |
| A workflow failed | the HUD (http://127.0.0.1:3217) → Terminals → History → open the task |
| What setup recorded | `obsidian-v2/.runtime/aos-setup.json` (no secrets) |

Never paste `jev.json` or `bridge-auth.json` anywhere: they hold your OpenRouter key and the local access token.

## Common situations

**The cockpit says the bridge is offline.** `node aos.mjs start`, wait 20 seconds, reload the plugin (or restart Obsidian). If it says "authentication required", run `node aos.mjs setup` again: it re-copies the local access token into the plugin.

**"Stop active tasks in Terminals first."** A conversation is still open. Close its tab in the HUD (× ends it) or in Obsidian, then repeat the command.

**"Port 3221 belongs to another installation."** A second copy of this system is running from another folder. Stop it from that folder. Only one copy can run at a time.

**Voice: the microphone does nothing.** Check the browser's site permission for `127.0.0.1:3217`. Mac: *System Settings → Privacy & Security → Microphone* must list your browser and Obsidian. The first request after a start can take a minute while the speech models load.

**Voice answers are slow to start.** Without an OpenRouter key every request is routed by your Claude/Codex model (about five seconds). `node aos.mjs jev-key` fixes that. `node aos.mjs doctor` tells you if the key is refused or out of credit.

**Claude is "not installed" on Windows although `claude` works in my terminal.** The npm version installs a `.cmd` shim the bridge cannot launch. Install Claude Code with the native installer, open a new terminal, then `node aos.mjs stop` and `node aos.mjs start`.

**Plan Today says the calendar is unavailable.** Connect Google Calendar in your coding tool (Claude Code: `/mcp`; Codex: connector settings), then run it again.

**The weekly-usage meter says "unavailable".** Codex: sign in to the Codex CLI once. Claude on Windows: run `claude` once; the meter renews its sign-in by itself afterwards. Claude on Mac: not supported yet.

**After moving the repository folder.** Run `node aos.mjs autostart off` from the old location first if you can, then `node aos.mjs setup --vault "<path>" --autostart yes` from the new one.

**Uninstall.** `node aos.mjs stop`, `node aos.mjs autostart off`, disable and delete the "Agentic OS V2" plugin in Obsidian, delete this folder. Your vault and its notes are yours and stay untouched; `system/v2/` inside the vault holds only this system's state and can be deleted too.
