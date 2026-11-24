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
- **Never ask for a secret in chat and never print one.** Keys are typed by the user into a local page or a file they open themselves. Never read, print or copy `jev.json`, `openai.json`, `bridge-auth.json`, `speech-auth.json`, `providers.json`, `.credentials.json` or `~/.claude/.env`. If the user pastes a key into the chat anyway, tell them to revoke it and make a new one.
- Never overwrite a note, and never edit the `.obsidian/` settings of a vault that already exists. `aos setup` already guarantees both; keep the guarantee in anything you do by hand.
- The local services listen on `127.0.0.1` ports 3217–3221. Do not open firewall ports, tunnels or remote access. Live voice (GPT-Live) is offered once, in Phase 7, and only the member can opt in: they review the disclosure and enter their key on a local page. Reference: [Live voice setup](../docs/LIVE-VOICE.md).
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
| Python 3.12 (voice, and conversations inside Obsidian) | Windows `py -3.12 --version`, Mac `python3.12 --version` | Windows: `winget install Python.Python.3.12`. Mac: `brew install python@3.12`. Voice works with 3.10–3.13 only: python.org and Homebrew now install 3.14 by default, which the voice libraries do not support yet, so install 3.12 alongside it (nothing needs uninstalling). |
| Mac only: compiler tools | `xcode-select -p` | `xcode-select --install`. Needed once for the terminal component. |
| Mac only: Homebrew | `brew --version` | Send the user to https://brew.sh — its installer asks for their password, so they run it themselves. |
| Obsidian | Windows: `%LOCALAPPDATA%\Programs\Obsidian` or `%LOCALAPPDATA%\Obsidian`. Mac: `/Applications/Obsidian.app` | Windows: `winget install Obsidian.Obsidian`. Mac: `brew install --cask obsidian`. Do not block on it. |
| Claude Code and/or Codex, signed in | `claude --version`, `codex --version` | One is enough, both is best. Claude Code: the native installer from https://claude.com/claude-code (on Windows the npm install is not detected). Codex: `npm install -g @openai/codex`. The user signs in themselves by running `claude` / `codex` once. |

**Mac voice setup:** ensure Homebrew is available before using the `brew` commands above. Its [Python 3.12 formula](https://formulae.brew.sh/formula/python@3.12) installs `python3.12`; `python3` can still resolve to Apple's older Python because the generic aliases live in a separate `libexec/bin` directory. After installation, check `python3.12 --version`. Setup looks for the versioned names first (3.12, then 3.13, 3.11, 3.10; on Windows `py -3.12` and so on) before the generic `python3` / `py -3`, so a newer default Python never wins; there is no need to replace the system Python or change global aliases.

If the interpreter is installed but unavailable on setup's `PATH`, prefix the same setup command with `AOS_V2_PYTHON="$(brew --prefix python@3.12)/bin/python3.12"`. Keep the vault, voice and autostart arguments already chosen. For Python installed another way, set `AOS_V2_PYTHON` to its absolute executable path instead. The chosen interpreter creates the private voice environment; an existing voice environment is reused when its Python is 3.10–3.13. One made with an unsupported Python (for example 3.14) is rebuilt automatically, but only while the services are stopped: if setup says so, run `node aos.mjs stop`, then the setup command again with `--voice yes`. Setup also prepares a small separate Python environment for the Terminal plugin (conversations inside Obsidian); on Windows it holds `psutil` and `pywinctl`, which Terminal needs to size its window. Without Python, conversations still run in Jarvis.

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
node aos.mjs setup --vault "<absolute path>" --provider claude|codex --voice yes|no --autostart yes|no
```

`--provider` is the coding tool the buttons and voice use: pass the one you are running in (Claude Code → `claude`, Codex → `codex`). Without it, a new vault gets whichever of the two is installed. An existing choice is kept on later runs and updates; pass `--provider` again only to switch.

This takes 5–15 minutes the first time (packages, the HUD build, voice models). It installs packages, builds the plugin and the HUD, creates or completes the vault, installs the plugin into it, installs voice, starts the services and ends with a checklist. It is safe to run again: finished steps are skipped.

Read the output. Typical fixes:

- `npm ci` fails on Mac with compiler errors → `xcode-select --install`, then run setup again.
- Python not found, too old or too new (`Found Python 3.14…, but voice needs Python 3.10-3.13`) → install 3.12 (table above), open a new terminal, run setup again. On Mac, verify `python3.12 --version` or use the explicit interpreter path described in Phase 0; `python3` may still be Apple's older version.
- `Your buttons and voice use Codex, which is not installed here` (or the other way round) → `node aos.mjs setup --provider claude` (or `codex`) switches them.
- `Another installation of this system ... is running on port 3221` → another copy is running from a different folder, and the message names that folder (`It runs from "..."`). Keep using that copy or follow `setup/UPGRADE.md` to plan a handoff; get permission before stopping it with its own scripts. If the message names no folder, `node aos.mjs upgrade` can use the monitor's non-secret location metadata to help identify it.
- `Voice: a speech service is already running on this computer ... and will be shared` → not an error. Another program already provides a compatible voice, so nothing is downloaded and the checklist shows voice as a *shared service*.
- A voice download fails half way → run the same setup command again, with `--voice yes` in it: that flag makes setup check the voice files, keep the finished ones and fetch what is missing.

The checklist at the end shows `WAIT  Plugin switched on in Obsidian` — that is expected until Phase 5 (a new vault has the plugin ready, but Obsidian has not opened it yet). A vault where the plugin was already working shows PASS.

**How to read the result.** Every check prints a line: PASS, FAIL, WAIT (a click only the user can make) or SKIP (could not run, with the reason). The command exits with code 1 when there is at least one FAIL, and the last line says which kind: *core parts* failed (fix these before going on), or only *optional parts* such as voice or Jev (the system is usable; carry on with the phases and come back to them).

**If the services are not running a minute after setup** (some agent sandboxes end background processes when a command finishes): ask the user to run `node aos.mjs start` in their own terminal, or use `--autostart yes`, which hands the services to the operating system.

## Phase 3 — Jev, the fast voice router (optional, recommended)

Explain in three sentences: *Jev is an optional model on OpenRouter that can reduce routing delay for eligible voice requests; it does not generate the answer or perform the work, and voice works without it. It receives what you said, brief excerpts from the last two voice exchanges, the selected conversation's title and latest reply excerpt, and report names; it does not receive full note files, though quoted note content can appear in those excerpts. OpenRouter usage is billed separately, and routing speed and cost vary.*

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
3. For conversations and personal-skill buttons inside Obsidian: *Community plugins → Browse → "Terminal"* (by polyipseity) → install and enable. Any stable 3.x release from 3.27.1 on works (3.27.1 and 3.27.2 are tested; a newer one shows a one-time notice); pre-releases are not supported. The doctor's "Terminal plugin" line reports the installed version. They can skip this and use the Jarvis HUD for personal skills and conversations; bundled background workflows still work inside Obsidian. Before wiring personal skills, explain this choice.
4. Open the HUD: http://127.0.0.1:3217
5. First use of the microphone: the browser (and on Mac, *System Settings → Privacy & Security → Microphone*) asks for permission → allow.
6. With this installation's own voice service on Mac, **Control–Option–J** is registered automatically. Keep Obsidian running with the Agentic OS orb enabled, or keep the HUD visible. Explain: press once, speak, then pause to send; do not hold the keys. A shared speech service keeps its owner's shortcut behavior. Follow [Mac voice setup](../docs/MAC-VOICE.md): the selected cockpit records, so verify Obsidian or browser microphone permission. Build/reload the plugin and HUD together with the speech service when upgrading this feature.

Ask them to tell you when the cockpit is visible in Obsidian.

## Phase 6 — Prove it works

```
node aos.mjs doctor --full
```

Every line is PASS, FAIL, WAIT or SKIP, and every FAIL names its fix; a check that could not run is printed as SKIP with the reason, never left out. `--full` also runs one real workflow (Vault Summary) on their subscription and checks that the report landed in the vault. Apply the fix and run it again. When the same check fails the same way twice in a row the doctor says so and changes its advice: stop re-running it at that point and do what that line says. More help: `docs/TROUBLESHOOTING.md`.

Then have the user try three things themselves:

1. Click a button that will work with what they have connected. If they connected Google Calendar in Phase 4: **Plan Today**. If they skipped it: **Intel Brief**, which needs nothing connected. Say so plainly: *"Plan Today needs your calendar, so it will stop and tell you that until you connect it. Let's try Intel Brief first."* A button that stops for a missing account is not a failed install.
2. Hold the microphone button in the HUD and say *"What is on my schedule today?"* (after Plan Today has written today's note; skip it if they have no calendar connected).
3. Say *"Open the morning intel"* (after they have run the Intel Brief once).

On Mac with its own voice service, also put another app in front, press **Control–Option–J**, say a harmless request and pause. Verify recording ends, exactly one request is sent, and a reply is heard. The doctor's shortcut PASS proves registration only; do not claim the microphone or background interaction works until this hands-on test succeeds. If the user chose autostart, have them repeat at their next normal login.

## Phase 7 — Make it theirs (each item optional)

### Tell your assistant about you

“This goes in your vault's AGENTS.md. Your Claude/Codex agents read it, and if you use Live voice it's sent to OpenAI at the start of every call.”

Ask these one at a time. The member can skip any question or the whole intake.

1. What’s your name and what do you do, in a sentence or two?
2. What are you focused on right now, such as projects or goals this month?
3. Who comes up in your work or life that you’d like the assistant to know about, and what are their roles?
4. How do you like answers, including length, tone, and anything the assistant should always keep in mind?
5. Is there anything the assistant should never say or do?

Draft an **About me** section from what the member shares. Show it and get their OK. Save the approved body to a temporary file, run `node aos.mjs about write --from <tmp file>`, then run `node aos.mjs about show` to confirm what Live will see. The member can repeat this intake later by asking “update my About me”.

### Choose their dashboard buttons

This is a menu, not an open question. The member picks from a list.

1. Ask one thing first: *"What do you mainly use AI for: running your day, client work, research, content, or something else?"* Their answer decides what you suggest.
2. Run `node aos.mjs dashboard list`. Every entry in `catalog` is a button they can have. The built-in ones (`"kind": "builtin"`) work with nothing installed: their instructions ship inside the app. Each has a `description` and a `needs` list.
3. With their agreement, also run `node aos.mjs dashboard discover --provider claude` (or `codex`) to find skills already on their computer, and name what you found: *"I found these skills of yours: A, B and C."* Do not claim to know which ones they use.
4. Say what is on their dashboard right now. In the `dashboard list` output, `"selected": null` means the starter buttons, and a list means buttons they already chose. For a new install: *"Right now your dashboard has the starter buttons: Plan Today, Inbox Brief, Deep Research and Content Cascade on the HUD, and ten in Obsidian."*
5. Show them **one list**, grouped by job. Each line has its name, what it produces, what it needs, and whether they have that need today. They told you in Phase 4 whether they connected calendar and mail; do not guess.

   ```text
   Run your day
     [x] Plan Today        today's note: top three, schedule, carry-overs        needs Google Calendar (connected)
     [ ] Inbox Brief       triage of the last 24 hours of email                  needs Gmail (not connected yet)
     [ ] Weekly Review     a review of your last seven daily notes               needs a few days of notes
   Research
     [x] Deep Research     a cited synthesis on any topic                        needs nothing
   Your own skills (found on this computer)
     [ ] <their skill>     <its description>
   ```

   Tick three to five that fit what they told you, and say why in a few words. Put the ones that need nothing first. Do not tick a workflow whose need they cannot meet today (for example Inbox Brief without Gmail, or Lead Research without a leads database). For a need they could meet in a minute, offer it: *"Want to connect Gmail now, or leave Inbox Brief off for the moment?"*
6. Ask the swap question in plain words: *"Which of these do you want as your buttons? Your picks replace the starter set, so you can swap any starter button for one of your own skills, keep some of each, or leave the starters as they are. Up to ten, in any order, and you can change them later with Customize dashboard."* Keeping the starter buttons is a complete answer: leave their selection unchanged and continue.
7. Read their choice back before saving it: *"So your dashboard will be: A, B, C. These starter buttons come off: X, Y."*

A skill file being present does not prove its tools or accounts are available. Read an installed skill's instructions before recommending it, explain missing requirements, and do not install new skills or connect accounts without the member choosing that step.

If they want a new skill that does not exist yet, help define its job, required inputs and expected result. After they choose to create it, use the coding tool's normal skill-creation workflow and an appropriate user or vault skill folder. Check the resulting SKILL.md, its provider compatibility and its dependencies before wiring the button. Do not modify this application's source or promise an unavailable integration works. If a skill needs more setup, say what remains and leave that button unwired until the member is ready. Never run a publishing, messaging, purchasing or other external action merely to test a new button.

For an existing personal skill, register its exact installed `SKILL.md` path with `node aos.mjs dashboard add --path "<absolute SKILL.md path>" --provider claude|codex|both --revision "<revision from list>"`. Only use `both` after verifying the instructions work in both tools. Registration returns `registeredId` and a new revision; it does not launch the skill or pin a button by itself. Skills absent from the standard discovery folders can be registered by their exact path.

Once they approve the selection, run `node aos.mjs dashboard select --skills "<comma-separated IDs in their chosen order>" --revision "<latest revision>"`. Use `--skills none` only if they explicitly want no quick buttons. A revision conflict means another window changed the dashboard: reload the saved selection and reconcile it with the member's choices before retrying.

Read `node aos.mjs dashboard list` again to confirm the saved order. Both the Obsidian cockpit and the HUD pick it up within a few seconds. Point out **Customize dashboard** in either app: they can add, remove or reorder buttons, find installed skills, and restore defaults later. Bundled workflows produce reports in the background; personal skills open an ordinary conversation in their selected coding tool, where questions and approvals remain visible. Never run an installed skill merely to test registration: ask for the actual task first.

Full commands and limits: `docs/DASHBOARD.md`. Dashboard choices live in `system/v2/dashboard.json` inside their vault and survive updates; do not change application source code to customize them.

### Offer the skill pack

The starter also ships a small pack of skills the member can own. Unlike the built-in buttons, these are copied into their coding tool's own skills folder, where they can read, edit and use them in any conversation.

1. Run `node aos.mjs skills list --provider claude` (or `codex`, the tool they use). It prints each skill's `description`, what it `needs`, and whether it is already `installed`.
2. Show the list the same way as the buttons, one line each, and ask: *"Want any of these installed as your own skills?"* A no is a complete answer.
3. Install only what they chose: `node aos.mjs skills install --skills "<id>,<id>" --provider claude`. A skill that leans on another brings it along and says so. A status of `kept-yours` means a different copy was already there and was left alone.
4. Ask whether any of them should also be a dashboard button. For each yes, use the `path` the install printed with `dashboard add`, then `dashboard select`, as above.

Installing never runs a skill. A copy the member edits is theirs: a later install or update does not overwrite it.

### Live voice (optional)

Ask: *"Would you like to be able to talk to your assistant on a live call? It answers from your day's plan and hands real work to your agents. It needs your own OpenAI API key and OpenAI bills it, roughly five cents a minute while you're talking."* A no is a complete answer: Local voice keeps working and costs nothing.

Only with a clear yes:

1. Ask whether they already have an OpenAI **API** key. If not, walk them through it: sign in at platform.openai.com (a separate account from ChatGPT; a ChatGPT subscription does not include it), add credit under Billing, then create a key on the API keys page. They keep the key to themselves.
2. Run `node aos.mjs openai-key` and give them the local page it prints. They read the disclosure, paste the key and save their consent on that page. Never ask for the key in chat, and never read `openai.json`. The page checks the key with OpenAI before saving, and the command then prints the outcome in one line. Read that line and act on it:
   - *Saved. OpenAI accepted the key.* Continue.
   - *Saved, but OpenAI did not show this key the Live model.* Tell them the key's project may not have access to it yet, and that the first call will show whether it works.
   - *Saved. OpenAI could not be reached.* Continue; the first call is the test.
   - *No key was saved.* The page timed out, or OpenAI refused the key and they closed the page. Run the command again when they are ready.
3. Have them open **···** on the HUD Voice card or beside the Obsidian orb, choose **Live**, start a call and allow the microphone.
   If the call does not start, the message on screen says why in plain words: a key OpenAI does not accept, no credit on the API account, or no access to the Live model. Fix that one thing with them; `docs/TROUBLESHOOTING.md` has a row for each.
4. Have them try three things: a general question, *"What's on my plan today?"* (Live answers from what it has), and *"Run Inbox Brief"* (Live hands it to V2; they can say "stop" within about 2.5 seconds). Then **End call**.
5. **Choose what Live knows when a call starts.** Say: *"Every call starts with a short snapshot: your About me, today's plan, and a few reports. You can turn parts off, and add your own notes or reports, like a goals note or a report one of your skills saves. Everything in it goes to OpenAI at the start of each call."* Then, one question at a time:
   1. Run `node aos.mjs live-context show` and tell them in plain words what a call reads now.
   2. *"Which of these do you want on every call?"* A part fed by a workflow they do not run is empty anyway (Numbers needs Metrics Pull, News needs Morning Intel, Radar needs Outlier Radar or GitHub Trending). Turn off what they do not want with `node aos.mjs live-context section <name> off`.
   3. *"Is there anything you'd want it to know on every call: a goals or projects note, a client list, a report one of your skills saves?"* Find the note or folder in their vault with them; search for it, never guess a path, and confirm it before adding. Add it with `node aos.mjs live-context add "<path>" --label "<short name>"`. A folder means its newest note is read, which suits a report a skill saves every day. Up to six; each is read up to about 6,000 characters, so a short summary note works better than a long one. Add only what they name, and never a note with passwords, keys, account numbers or health details.
   4. Facts that rarely change (who they are, the people in their work, how they like answers) belong in **About me** instead. Offer the About me intake if it is thin.
   5. Run `node aos.mjs live-context show` again so they see the result, and tell them they can change it any time by asking, for example *"add my goals note to Live"* or *"stop sending the radar to Live"*.
6. Mention **Share morning brief** in the Live settings and leave the choice to them. It is off by default. Turned on, their whole morning brief, including its email section, goes to OpenAI at the start of each call so Live can answer from it. It is only useful if they run Morning Intel, so offer it together with the scheduled Intel Brief below.

Later, `node aos.mjs openai-key --check` says whether a key and consent are saved, and `node aos.mjs doctor` checks the saved key with OpenAI. Neither shows the key.

Details, settings and costs: `docs/LIVE-VOICE.md`. Do not turn on Live, Share morning brief or any other sharing setting for them.

### Other preferences

- **Daily Drivers:** ask for the three or four things they want on every day's checklist, and write them to `<vault>/system/v2/profile.json` as `{"dailyDrivers": ["…", "…"]}` (1–8 short labels). Optional `"cta"`: the closing paragraph Content Cascade should use for their community or newsletter.
- **Metrics cards** (YouTube, Instagram, TikTok, GitHub): the settings live in `~/.claude/.env`. That is only a file this system reads; it does not need Claude Code. If the `~/.claude` folder does not exist (a Codex-only computer), create the folder first, then create the file from `docs/env.example`. Open it in their editor (`notepad` / `open -e`), tell them which lines to fill, and wait. Handles are not secret; the YouTube key is, so they type it, not you.
- **Scheduled workflows:** ask whether they want anything to run by itself, most often Plan Today in the morning or the Intel Brief before they start. Only with a clear yes: `node aos.mjs schedule add plan-today 07:00 --days weekdays` (`node aos.mjs schedule skills` lists what can be scheduled). Say plainly that it runs only while the services are running and uses their plan the same as pressing the button. Never schedule anything they did not ask for.
- **Voice sound and words:** if they use voice, ask whether they want replies spoken (`node aos.mjs voice mute` turns that off), offer a different voice or speed (`node aos.mjs voice use <name>`, `node aos.mjs voice speed 1.1`), and teach it the two or three names it must not mishear: their own name, their company, their main product (`node aos.mjs voice teach "<word>" "<word>"`). `node aos.mjs voice` shows the result. They can change all of it later from the voice menu on either screen.
- **Voice language:** voice hears and speaks English. If they will speak Spanish, French, Italian or Brazilian Portuguese to it, add `"speechLanguage": "es"` (`fr`, `it`, `pt`) to the same `profile.json`, then run `node aos.mjs stop` and `node aos.mjs setup --voice yes` (it downloads that language's speech model, about 460 MB) and `node aos.mjs doctor`. Tell them plainly: the instant spoken commands stay English, so in another language each request takes a few seconds longer. Any other language is not supported; leave the setting out.
- **Time zone:** dates follow the computer's clock. After changing the computer's time zone: `node aos.mjs stop`, then `node aos.mjs start`.

## Phase 8 — Hand over

A short, personal wrap-up:

- What now runs by itself: the bridge, the HUD and voice (and at login, if they chose that). Explain the requests to their Claude / Codex account, optional Jev routing through OpenRouter, and any web searches or connected services. Review the data access and external actions required by their selected personal skills.
- Costs: their Claude and/or Codex provider plan, optional OpenRouter usage for Jev, optional OpenAI usage for Live voice calls, and any paid tools or services used by their personal skills. Local speech has no API charge.
- Day-to-day: `node aos.mjs status | stop | start | doctor | update`. Explain that `update` maintains a stock starter as a whole; `upgrade` is read-only discovery and planning for an existing or customized system.
- Where things land: reports in `inbox/reports/` and `inbox/research/`, daily notes in `daily-notes/`, conventions in the vault's `CLAUDE.md` / `AGENTS.md`.
- Voice shortcut: **Control–Option–J** on Mac, **Ctrl–Alt–J** on Windows, with this installation's own voice service. Press once, speak, pause to send. Keep Obsidian with its orb enabled or the HUD visible. On Mac the Claude weekly-usage meter may read "unavailable". Mac support is new — if something is off, `node aos.mjs doctor` first.
- If anything breaks later: open this folder in Claude Code or Codex and say *"run the doctor"*.
