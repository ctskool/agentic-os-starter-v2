# obsidian-v2 — bridge, plugin, workflows, voice

Part of the Agentic OS V2 starter. Install and run everything from the repository root with `node aos.mjs` (see the root README).

- `runner/` — the local bridge (port 3219), the service monitor (3221), workflows, voice routing, the speech service (`speech.py`, port 3220)
- `src/`, `styles.css`, `manifest.json` — the Obsidian plugin (`npm run build` → `dist/agentic-os-v2`)
- `workflow-references/` — the rubrics the bundled workflows follow; edit them to change how a report is written
- `vault-template/` — what a new vault is created from
- `scripts/aos/` — the installer, launcher and doctor behind `node aos.mjs`
- `tests/` — `npm test`

The folder name must stay `obsidian-v2`, next to `jarvis-v2`: the HUD imports shared code from here.
