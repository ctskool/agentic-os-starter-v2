# Fresh-install playbook (for the coding agent)

You are the installer, guide and doctor for Agentic OS V2. The person you are helping cloned this repository (or asked you to) and wants the whole system working: an Obsidian cockpit, the Jarvis HUD in the browser, voice, and background workflows that run on their own Claude Code and/or Codex subscription. Get them there with as little typing on their side as possible.

## Choose the right route first

Honor an explicit fresh-install or upgrade request. If the member simply says "set this up" and their intent is unclear, ask: *"Are we setting up Agentic OS for the first time, or upgrading a version you already use?"* Do not ask them to find folders before answering this.

- **Fresh install:** continue below. An existing Obsidian vault does not by itself mean Agentic OS is already installed.
- **Upgrade an existing Agentic OS, including V1 or customized versions:** follow [UPGRADE.md](UPGRADE.md). It starts with read-only discovery and a plan that preserves their customizations. Feature choices belong in that conversation.
- **Repair an identified installation:** use [Phase 6](#phase-6--prove-it-works), explaining that `--full` runs a real workflow. If you do not know which installation they mean, discover it first without starting or stopping anything.

An `obsidian-v2/.runtime/aos-setup.json` marker records a previous setup. It must never short-circuit an upgrade request into repair. If it conflicts with a fresh-install request, explain that an installation already exists and resolve the intended target before making changes.

## Rules

- One question at a time. If a fix is safe and reversible, do it and say what you did.
- **Never ask for a secret in chat and never print one.** Keys are typed by the user into a local page or a file they open themselves. Never read, print or copy `jev.json`, `bridge-auth.json`, `providers.json`, `.credentials.json` or `~/.claude/.env`. If the user pastes a key into the chat anyway, tell them to revoke it and make a new one.
- Never overwrite a note, and never edit the `.obsidian/` settings of a vault that already exists. `aos setup` already guarantees both; keep the guarantee in anything you do by hand.
- Everything runs on this computer, on `127.0.0.1` ports 3217–3221. Do not open firewall ports, tunnels or remote access.
- If the same step fails twice with the same error, stop looping: show the exact error and your best next step.
- All commands below run from the repository root (the folder with `aos.mjs`).
- Keep the stock application's source unchanged during installation and repair. Intentional custom integration is a separate, explicitly approved workflow in `setup/UPGRADE.md`, not a workaround for a failed setup.
- If an existing installation owns the ports, identify it and explain the choices. Do not stop it automatically: a service handoff requires the member's permission and that installation's own scripts.

## Phase 0 — Permissions and prerequisites

You will install packages from the internet, write outside this folder (the vault, a login item) and start background services.

- **Codex:** ask the user to allow this for the session (approve the prompts, or switch the session to full access). The default sandbox blocks the network and writes outside the folder, and the install cannot work inside it.
- **Claude Code:** the user approves commands as they come up.

Check each item and fix what you can:

| Need | Check | If missing |
|---|---|---|
| Git | `git --version` | Windows: `winget install Git.Git`. Mac: `xcode-select --install` (the user confirms a dialog). |
| Node.js 22+ | `node --version` | Windows: `winget install OpenJS.NodeJS.LTS`. Mac: `brew install node`. Then open a new terminal. |
| Python 3.10–3.13 (voice only) | Windows `py -3 --version`, Mac `python3 --version` | Windows: `winget install Python.Python.3.12`. Mac: `brew install python@3.12`. |
| Mac only: compiler tools | `xcode-select -p` | `xcode-select --install`. Needed once for the terminal component. |
| Mac only: Homebrew | `brew --version` | Send the user to https://brew.sh — its installer asks for their password, so they run it themselves. |
| Obsidian | Windows: `%LOCALAPPDATA%\Programs\Obsidian` or `%LOCALAPPDATA%\Obsidian`. Mac: `/Applications/Obsidian.app` | Windows: `winget install Obsidian.Obsidian`. Mac: `brew install --cask obsidian`. Do not block on it. |
| Claude Code and/or Codex, signed in | `claude --version`, `codex --version` | One is enough, both is best. Claude Code: the native installer from https://claude.com/claude-code (on Windows the npm install is not detected). Codex: `npm install -g @openai/codex`. The user signs in themselves by running `claude` / `codex` once. |

Location: the repository should live in a normal folder such as `~/agentic-os`. **Not** inside the vault, and **not** inside OneDrive, iCloud Drive or Dropbox (package folders and local sockets misbehave there). If it was cloned into one of those, move it before going on.

## Phase 1 — One question: where is the vault?

Ask: *"Where should your vault live? I can create a new one at `~/agentic-vault`, or use an Obsidian vault you already have — nothing in it gets overwritten."*

- An existing vault keeps every note and all of its Obsidian settings. Missing template folders are added.
- **Members coming from the first starter kit:** take the upgrade route in `setup/UPGRADE.md` before running setup. Keep their vault and the old plugin; disable the old cockpit only after V2 is verified and the member approves the handoff. Do not assume an old runner or login item is harmless or remove it automatically.

Then two yes/no questions, one at a time:

1. *"Do you want voice? It is free and runs on your computer, but downloads about 1.3 GB once."*
2. *"Should everything start by itself when you log in?"* (recommended)

## Phase 2 — Install

```
node aos.mjs setup --vault "<absolute path>" --voice yes|no --autostart yes|no
```

This takes 5–15 minutes the first time (packages, the HUD build, voice models). It installs packages, builds the plugin and the HUD, creates or completes the vault, installs the plugin into it, installs voice, starts the services and ends with a checklist. It is safe to run again: finished steps are skipped.

Read the output. Typical fixes:

- `npm ci` fails on Mac with compiler errors → `xcode-select --install`, then run setup again.
- Python not found or too old → install it (table above), open a new terminal, run setup again.
- `Another installation of this system ... is running on port 3221` → another copy is running from a different folder, and the message names that folder (`It runs from "..."`). Keep using that copy or follow `setup/UPGRADE.md` to plan a handoff; get permission before stopping it with its own scripts. If the message names no folder, `node aos.mjs upgrade` can use the monitor's non-secret location metadata to help identify it.
- `Voice: a speech service is already running on this computer ... and will be shared` → not an error. Another program already provides a compatible voice, so nothing is downloaded and the checklist shows voice as a *shared service*.
- A voice download fails half way → run the same setup command again, with `--voice yes` in it: that flag makes setup check the voice files, keep the finished ones and fetch what is missing.

The checklist at the end shows `WAIT  Plugin switched on in Obsidian` — that is expected until Phase 5 (a new vault has the plugin ready, but Obsidian has not opened it yet). A vault where the plugin was already working shows PASS.

**How to read the result.** Every check prints a line: PASS, FAIL, WAIT (a click only the user can make) or SKIP (could not run, with the reason). The command exits with code 1 when there is at least one FAIL, and the last line says which kind: *core parts* failed (fix these before going on), or only *optional parts* such as voice or Jev (the system is usable; carry on with the phases and come back to them).

**If the services are not running a minute after setup** (some agent sandboxes end background processes when a command finishes): ask the user to run `node aos.mjs start` in their own terminal, or use `--autostart yes`, which hands the services to the operating system.

## Phase 3 — Jev, the fast voice router (optional, recommended)

Explain in two or three sentences: *voice requests are routed by a small model on OpenRouter called Jev. It answers in about a fifth of a second instead of five, and costs a fraction of a cent per request. It is sent what you said, the last two turns of that voice conversation, the title and last lines of the selected conversation and the file names of recent reports, never your notes. Without it everything still works, only slower.*

1. The user creates an account at https://openrouter.ai, adds a few dollars of credit, and creates a key at https://openrouter.ai/keys.
2. You run `node aos.mjs jev-key`. A page opens in **their** browser and they paste the key there; tell them that is all they have to do. The command prints only `{"saved":true}` or `{"saved":false}`.
3. You check with `node aos.mjs jev-key --check`.

*For you, not for the user:* step 2 keeps running for up to five minutes while it waits for the page. If your tool cannot keep a command running that long, do not retry it in a loop. Ask the user to run `node aos.mjs jev-key` in their own terminal and to tell you when the page said it was saved, then do step 3.

## Phase 4 — Calendar and mail (optional)

Plan Today, Inbox Brief and Morning Intel read the calendar and mail through the connectors of the coding tool, not through keys.

- Claude Code: the user runs `/mcp` (or opens claude.ai → Settings → Connectors) and connects Google Calendar, Gmail and Google Drive.
- Codex: the user connects the same in Codex's connector settings.

You cannot do the sign-in for them. Everything else works without it; those workflows will say the calendar was unavailable.

## Phase 5 — The clicks only the user can do

1. Open Obsidian → *Open folder as vault* → the vault path.
2. New vault: Obsidian asks whether to trust the author and enable plugins → **Trust**. Existing vault: *Settings → Community plugins → Turn on community plugins → enable "Agentic OS V2"*.
3. For conversations and personal-skill buttons inside Obsidian: *Community plugins → Browse → "Terminal"* (by polyipseity) → install and enable. They can skip this and use the Jarvis HUD for personal skills and conversations; bundled background workflows still work inside Obsidian. Before wiring personal skills, explain this choice.
4. Open the HUD: http://127.0.0.1:3217
5. First use of the microphone: the browser (and on Mac, *System Settings → Privacy & Security → Microphone*) asks for permission → allow.

Ask them to tell you when the cockpit is visible in Obsidian.

## Phase 6 — Prove it works

```
node aos.mjs doctor --full
```

Every line is PASS, FAIL, WAIT or SKIP, and every FAIL names its fix; a check that could not run is printed as SKIP with the reason, never left out. `--full` also runs one real workflow (Vault Summary) on their subscription and checks that the report landed in the vault. Apply the fix and run it again. When the same check fails the same way twice in a row the doctor says so and changes its advice: stop re-running it at that point and do what that line says. More help: `docs/TROUBLESHOOTING.md`.

Then have the user try three things themselves:

1. Click **Plan Today** in the cockpit.
2. Hold the microphone button in the HUD and say *"What is on my schedule today?"*
3. Say *"Open the morning intel"* (after they have run Morning Intel once).

## Phase 7 — Make it theirs (each item optional)

### Choose their dashboard buttons

Ask: *"Would you like me to wire your own skills into the button section of both dashboards? Tell me what you want those buttons to do, or we can keep the starter buttons for now."* Keeping the starter buttons is a complete answer: leave their selection unchanged and continue.

If they want to personalize, ask these one at a time:

1. *"What do you mainly use AI for — running your day, client work, research, content, or something else?"*
2. *"Which skills do you already use regularly, and is there a new workflow you would like a button for?"* Do not claim to know their usage history. With their agreement, use `node aos.mjs dashboard discover --provider claude` or `--provider codex` to find installed skills for the tool they use.
3. Suggest a short starting list, with one plain-language reason for each recommendation, and ask what they would like to keep or change. Offer up to ten buttons; they do not need to fill all ten.

First read the available bundled and registered choices with `node aos.mjs dashboard list`. Recommend only actual entries or installed skills you have verified. Useful examples:

| Their work | Possible bundled buttons |
|---|---|
| Daily organization | Plan Today, Inbox Brief, Weekly Review, Summarize Vault |
| Client work and research | Lead Research, Deep Research, Weekly Review |
| Content creation | Content Cascade, Brainstorm Angles, Build Outline, YT Pipeline |

These are suggestions, not fixed presets. Explain any required connection: for example, calendar and email workflows need their connected accounts. A skill file being present does not prove its tools or accounts are available. Read the selected skill's instructions before recommending it, explain missing requirements, and do not install new skills or connect accounts without the member choosing that step.

If they want a new skill that does not exist yet, help define its job, required inputs and expected result. After they choose to create it, use the coding tool's normal skill-creation workflow and an appropriate user or vault skill folder. Check the resulting SKILL.md, its provider compatibility and its dependencies before wiring the button. Do not modify this application's source or promise an unavailable integration works. If a skill needs more setup, say what remains and leave that button unwired until the member is ready. Never run a publishing, messaging, purchasing or other external action merely to test a new button.

For an existing personal skill, register its exact installed `SKILL.md` path with `node aos.mjs dashboard add --path "<absolute SKILL.md path>" --provider claude|codex|both --revision "<revision from list>"`. Only use `both` after verifying the instructions work in both tools. Registration returns `registeredId` and a new revision; it does not launch the skill or pin a button by itself. Skills absent from the standard discovery folders can be registered by their exact path.

Once they approve the selection, run `node aos.mjs dashboard select --skills "<comma-separated IDs in their chosen order>" --revision "<latest revision>"`. Use `--skills none` only if they explicitly want no quick buttons. A revision conflict means another window changed the dashboard: reload the saved selection and reconcile it with the member's choices before retrying.

Read `node aos.mjs dashboard list` again to confirm the saved order. Both the Obsidian cockpit and the HUD pick it up within a few seconds. Point out **Customize dashboard** in either app: they can add, remove or reorder buttons, find installed skills, and restore defaults later. Bundled workflows produce reports in the background; personal skills open an ordinary conversation in their selected coding tool, where questions and approvals remain visible. Never run an installed skill merely to test registration: ask for the actual task first.

Full commands and limits: `docs/DASHBOARD.md`. Dashboard choices live in `system/v2/dashboard.json` inside their vault and survive updates; do not change application source code to customize them.

### Other preferences

- **Daily Drivers:** ask for the three or four things they want on every day's checklist, and write them to `<vault>/system/v2/profile.json` as `{"dailyDrivers": ["…", "…"]}` (1–8 short labels). Optional `"cta"`: the closing paragraph Content Cascade should use for their community or newsletter.
- **Metrics cards** (YouTube, Instagram, TikTok, GitHub): the settings live in `~/.claude/.env`. That is only a file this system reads; it does not need Claude Code. If the `~/.claude` folder does not exist (a Codex-only computer), create the folder first, then create the file from `docs/env.example`. Open it in their editor (`notepad` / `open -e`), tell them which lines to fill, and wait. Handles are not secret; the YouTube key is, so they type it, not you.
- **Time zone:** dates follow the computer's clock. After changing the computer's time zone: `node aos.mjs stop`, then `node aos.mjs start`.

## Phase 8 — Hand over

A short, personal wrap-up:

- What now runs by itself: the bridge, the HUD and voice (and at login, if they chose that). Explain the requests to their Claude / Codex account, optional Jev routing through OpenRouter, and any web searches or connected services. Review the data access and external actions required by their selected personal skills.
- Costs: their Claude and/or Codex provider plan, optional OpenRouter usage for Jev, and any paid tools or services used by their personal skills. Local speech has no API charge.
- Day-to-day: `node aos.mjs status | stop | start | doctor | update`. Explain that `update` maintains a stock starter as a whole; `upgrade` is read-only discovery and planning for an existing or customized system.
- Where things land: reports in `inbox/reports/` and `inbox/research/`, daily notes in `daily-notes/`, conventions in the vault's `CLAUDE.md` / `AGENTS.md`.
- Known limits: on Mac there is no global push-to-talk hotkey (use the microphone button) and the Claude weekly-usage meter may read "unavailable". Mac support is new — if something is off, `node aos.mjs doctor` first.
- If anything breaks later: open this folder in Claude Code or Codex and say *"run the doctor"*.
