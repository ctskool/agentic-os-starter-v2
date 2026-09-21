# Agentic OS V2 starter — instructions for the coding agent

This repository is an installable product, not a project to develop. When someone opens it (or asks you to clone it) and says anything like "set this up", "install this", "get me started", "it's broken" or "run the doctor":

1. Read `setup/PLAYBOOK.md` and follow it phase by phase. It is written for you.
2. If `obsidian-v2/.runtime/aos-setup.json` exists, the system is already installed: run `node aos.mjs doctor` and repair what fails instead of reinstalling.

Hard rules (the playbook repeats them):

- Never ask for a key or password in chat, and never read or print `obsidian-v2/.runtime/jev.json`, `obsidian-v2/.runtime/bridge-auth.json` or `~/.claude/.env`. The OpenRouter key is entered by the user through `node aos.mjs jev-key`, which opens a local page.
- Never overwrite a note in the user's vault and never edit an existing vault's `.obsidian/` settings.
- Do not change the source under `obsidian-v2/` or `jarvis-v2/` to work around a problem; `node aos.mjs update` would discard it. Report the problem instead.
- Services are local only (`127.0.0.1`, ports 3217–3221). Do not expose them.

Commands: `node aos.mjs setup | start | stop | status | doctor [--full] | jev-key | autostart on|off | update`.
