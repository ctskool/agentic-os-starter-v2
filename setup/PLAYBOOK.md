# Setup playbook (for the coding agent doing the install)

You are the installer, guide and doctor for Agentic OS V2. The person you are helping cloned this repository (or asked you to) and wants the whole system working: an Obsidian cockpit, the Jarvis HUD in the browser, voice, and background workflows that run on their own Claude Code and/or Codex subscription. Get them there with as little typing on their side as possible.

**If `obsidian-v2/.runtime/aos-setup.json` already exists this is a re-run:** go straight to [Phase 6](#phase-6--prove-it-works) and repair only what fails.

## Rules

- One question at a time. If a fix is safe and reversible, do it and say what you did.
- **Never ask for a secret in chat and never print one.** Keys are typed by the user into a local page or a file they open themselves. Never read, print or copy `obsidian-v2/.runtime/jev.json`, `bridge-auth.json` or `~/.claude/.env`. If the user pastes a key into the chat anyway, tell them to revoke it and make a new one.
- Never overwrite a note, and never edit the `.obsidian/` settings of a vault that already exists. `aos setup` already guarantees both; keep the guarantee in anything you do by hand.
- Everything runs on this computer, on `127.0.0.1` ports 3217–3221. Do not open firewall ports, tunnels or remote access.
- If the same step fails twice with the same error, stop looping: show the exact error and your best next step.
- All commands below run from the repository root (the folder with `aos.mjs`).

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
- **Members coming from the first starter kit:** use the same vault. The old "Chase Command Center" plugin and the new "Agentic OS V2" plugin can both be installed, but only one cockpit should be switched on: tell them to disable the old one after V2 works. The old background runner is separate and harmless; they can leave it or remove its login item later.

Then two yes/no questions, one at a time:

1. *"Do you want voice? It is free and runs on your computer, but downloads about 800 MB once."*
2. *"Should everything start by itself when you log in?"* (recommended)

## Phase 2 — Install

```
node aos.mjs setup --vault "<absolute path>" --voice yes|no --autostart yes|no
```

This takes 5–15 minutes the first time (packages, the HUD build, voice models). It installs packages, builds the plugin and the HUD, creates or completes the vault, installs the plugin into it, installs voice, starts the services and ends with a checklist. It is safe to run again: finished steps are skipped.

Read the output. Typical fixes:

- `npm ci` fails on Mac with compiler errors → `xcode-select --install`, then run setup again.
- Python not found or too old → install it (table above), open a new terminal, run setup again.
- `Port 3221 belongs to another installation` → another copy of this system is running from a different folder. Stop that one first (`node aos.mjs stop` in its folder).
- A voice download fails half way → run setup again; finished files are kept.

The checklist at the end shows `WAIT  Plugin switched on in Obsidian` — that is expected until Phase 5.

**If the services are not running a minute after setup** (some agent sandboxes end background processes when a command finishes): ask the user to run `node aos.mjs start` in their own terminal, or use `--autostart yes`, which hands the services to the operating system.

## Phase 3 — Jev, the fast voice router (optional, recommended)

Explain in two or three sentences: *voice requests are routed by a small model on OpenRouter called Jev. It answers in about a fifth of a second instead of five, and costs a fraction of a cent per request. It is sent what you said, the last two turns of that voice conversation, the title and last lines of the selected conversation and the file names of recent reports, never your notes. Without it everything still works, only slower.*

1. The user creates an account at https://openrouter.ai, adds a few dollars of credit, and creates a key at https://openrouter.ai/keys.
2. Run `node aos.mjs jev-key`. A page opens in **their** browser; they paste the key there. The command waits up to five minutes and prints only `{"saved":true}` or `{"saved":false}`. If your command runner cannot wait that long, ask the user to run the command in their own terminal.
3. Check with `node aos.mjs jev-key --check`.

## Phase 4 — Calendar and mail (optional)

Plan Today, Inbox Brief and Morning Intel read the calendar and mail through the connectors of the coding tool, not through keys.

- Claude Code: the user runs `/mcp` (or opens claude.ai → Settings → Connectors) and connects Google Calendar, Gmail and Google Drive.
- Codex: the user connects the same in Codex's connector settings.

You cannot do the sign-in for them. Everything else works without it; those workflows will say the calendar was unavailable.

## Phase 5 — The clicks only the user can do

1. Open Obsidian → *Open folder as vault* → the vault path.
2. New vault: Obsidian asks whether to trust the author and enable plugins → **Trust**. Existing vault: *Settings → Community plugins → Turn on community plugins → enable "Agentic OS V2"*.
3. Optional, for terminals inside Obsidian: *Community plugins → Browse → "Terminal"* (by polyipseity) → install and enable. Without it, conversations open in the Jarvis HUD instead.
4. Open the HUD: http://127.0.0.1:3217
5. First use of the microphone: the browser (and on Mac, *System Settings → Privacy & Security → Microphone*) asks for permission → allow.

Ask them to tell you when the cockpit is visible in Obsidian.

## Phase 6 — Prove it works

```
node aos.mjs doctor --full
```

Every line is PASS, FAIL, WAIT or SKIP, and every FAIL names its fix. `--full` also runs one real workflow (Vault Summary) on their subscription and checks that the report landed in the vault. Apply the fix, run it again, repeat until nothing fails. More help: `docs/TROUBLESHOOTING.md`.

Then have the user try three things themselves:

1. Click **Plan Today** in the cockpit.
2. Hold the microphone button in the HUD and say *"What is on my schedule today?"*
3. Say *"Open the morning intel"* (after they have run Morning Intel once).

## Phase 7 — Make it theirs (each item optional)

- **Daily Drivers:** ask for the three or four things they want on every day's checklist, and write them to `<vault>/system/v2/profile.json` as `{"dailyDrivers": ["…", "…"]}` (1–8 short labels). Optional `"cta"`: the closing paragraph Content Cascade should use for their community or newsletter.
- **Metrics cards** (YouTube, Instagram, TikTok, GitHub): create `~/.claude/.env` from `docs/env.example` if it does not exist, open it in their editor (`notepad` / `open -e`), tell them which lines to fill, and wait. Handles are not secret; the YouTube key is, so they type it, not you.
- **Time zone:** dates follow the computer's clock. After changing the computer's time zone: `node aos.mjs stop`, then `node aos.mjs start`.

## Phase 8 — Hand over

A short, personal wrap-up:

- What now runs by itself: the bridge, the HUD and voice (and at login, if they chose that). Nothing leaves the computer except requests to their own Claude / Codex account and, if set, OpenRouter.
- Costs: their Claude and/or Codex subscription, plus pennies on OpenRouter for Jev. No other API bills.
- Day-to-day: `node aos.mjs status | stop | start | doctor | update`.
- Where things land: reports in `inbox/reports/` and `inbox/research/`, daily notes in `daily-notes/`, conventions in the vault's `CLAUDE.md` / `AGENTS.md`.
- Known limits: on Mac there is no global push-to-talk hotkey (use the microphone button) and the Claude weekly-usage meter may read "unavailable". Mac support is new — if something is off, `node aos.mjs doctor` first.
- If anything breaks later: open this folder in Claude Code or Codex and say *"run the doctor"*.
