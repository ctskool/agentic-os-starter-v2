# Agentic OS V2 — starter

An AI command center that lives in your Obsidian vault and in a browser HUD, runs on **your** Claude Code and/or Codex subscription, and talks.

- **Obsidian cockpit** — today's plan, priorities, metrics and one-click workflows (Plan Today, Morning Intel, Inbox Brief, Weekly Review, Deep Research, Content Cascade and more) that write their reports into your vault.
- **Jarvis HUD** — the same system as a full-screen dashboard at `http://127.0.0.1:3217`, with live terminals for Claude Code and Codex.
- **Voice** — hold the microphone and ask. Speech recognition and the voice run locally (Whisper + Kokoro); no speech API keys.
- **Jev** (optional) — a tiny routing model on OpenRouter that makes voice answers start in a fraction of a second.

Windows 10/11 and macOS. Everything runs on your own computer, on `127.0.0.1` only.

> **macOS is new (beta).** The install and the background services are checked automatically on a Mac; the microphone, Obsidian and the HUD have had far less real-world use there than on Windows, so reports are welcome. Known gaps: no global push-to-talk hotkey (use the microphone button) and the Claude weekly-usage meter may read "unavailable".

## Install — let your coding agent do it

Open **Claude Code** or **Codex** in any folder and say:

```
Clone https://github.com/ctskool/agentic-os-starter-v2 into ~/agentic-os and set it up for me.
```

The agent reads `CLAUDE.md` / `AGENTS.md`, follows `setup/PLAYBOOK.md`, and walks you through it: prerequisites, where your vault lives, voice, your OpenRouter key (typed into a local page, never into the chat), the two clicks in Obsidian, and a final test run. Plan for 15–25 minutes, most of it downloads.

Codex users: allow the session to install software and use the network when it asks; the default sandbox cannot do an install.

### What you need

| | |
|---|---|
| A Claude Code **or** Codex subscription, signed in on this computer | one is enough, both is best |
| [Obsidian](https://obsidian.md) | free |
| Node.js 22+, Git, Python 3.10–3.13 (for voice) | the agent installs what is missing |
| About 3 GB of disk, 8 GB of RAM | voice models are ~800 MB |
| Optional: an [OpenRouter](https://openrouter.ai) key with a few dollars of credit | for Jev |

### Prefer to do it by hand?

```
git clone https://github.com/ctskool/agentic-os-starter-v2 ~/agentic-os
cd ~/agentic-os
node aos.mjs setup --vault "/absolute/path/to/your/vault" --voice yes --autostart yes
node aos.mjs jev-key          # optional
node aos.mjs doctor --full
```

Then open the vault in Obsidian, enable the **Agentic OS V2** community plugin, and open http://127.0.0.1:3217.

## Day to day

```
node aos.mjs status      what is running
node aos.mjs doctor      PASS / FAIL checks, each failure with its fix
node aos.mjs stop        stop the services (refuses while a task is open)
node aos.mjs start       start them again
node aos.mjs update      get the latest version and rebuild
node aos.mjs autostart on|off
```

Something broken? Open this folder in your coding agent and say **"run the doctor"**. See also `docs/TROUBLESHOOTING.md`.

## What it costs

Your Claude and/or Codex subscription does the thinking. Jev costs a fraction of a cent per voice request on OpenRouter. Speech is local and free. There are no other API bills.

## What it will and will not do

Workflows read your vault, the web and (if you connect them) your calendar and mail, and write **drafts and reports into your vault**. They never send messages, publish, schedule posts or delete notes.

What leaves your computer: requests to your own Claude / Codex account (which can include note content a workflow reads), and, only if you add an OpenRouter key, each voice request to Jev: the words you said, the last two turns of that voice conversation, the title and last few lines of the conversation you have selected, and the file names of recent reports, so it can decide where the request goes. Your notes, daily note and metrics are not sent to OpenRouter. Speech recognition and the voice itself stay on your computer.

## Layout

```
aos.mjs            the one command
setup/PLAYBOOK.md  what the installing agent follows
obsidian-v2/       the local bridge, the Obsidian plugin, workflows, voice service, vault template
jarvis-v2/         the HUD (Next.js)
docs/              troubleshooting, optional settings
```

Coming from the first starter kit? Use the same vault. Your notes and settings stay as they are; disable the old "Chase Command Center" plugin once V2 works.
