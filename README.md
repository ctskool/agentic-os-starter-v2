<div align="center">

<a href="#install"><img src="docs/assets/banner.png" alt="Agentic OS V2. Your AI command center, inside Obsidian." width="100%"></a>

<br>

<p><b>Plan your day, talk to your agents, and run your skills from one place.</b><br>
Everything they produce lands in your vault as plain Markdown.</p>

<p>
<img alt="Version" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fctskool%2Fagentic-os-starter-v2%2Fmain%2Fobsidian-v2%2Fmanifest.json&query=%24.version&label=version&labelColor=14161d&color=e8744a&style=flat-square">
<img alt="Runs on Claude Code and Codex" src="https://img.shields.io/badge/runs%20on-Claude%20Code%20%C2%B7%20Codex-2a2d38?labelColor=14161d&style=flat-square">
<img alt="Windows and macOS beta" src="https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20beta-2a2d38?labelColor=14161d&style=flat-square">
<a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2a2d38?labelColor=14161d&style=flat-square"></a>
<a href="https://github.com/ctskool/agentic-os-starter-v2/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/ctskool/agentic-os-starter-v2?labelColor=14161d&color=2a2d38&style=flat-square"></a>
</p>

**[Install](#install)** &nbsp;·&nbsp; **[What you get](#what-you-get)** &nbsp;·&nbsp; **[Talk to it](#talk-to-it)** &nbsp;·&nbsp; **[How it works](#how-it-works)** &nbsp;·&nbsp; **[Help](#help)**

<br>

<a href="docs/assets/jarvis-hud.png"><img src="docs/assets/showcase.webp" alt="The Jarvis HUD in a browser and the Obsidian cockpit in a vault, side by side" width="100%"></a>

<sub>Actual dashboard components, shown with demo data. Full size: <a href="docs/assets/jarvis-hud.png">Jarvis HUD</a> · <a href="docs/assets/obsidian-cockpit.png">Obsidian cockpit</a></sub>

</div>

<br>

## Install

Open **Claude Code** or **Codex** and paste this:

```text
Clone https://github.com/ctskool/agentic-os-starter-v2 into ~/agentic-os and set it up for me.
```

Your agent does the rest, and asks before each step that needs you:

1. **Checks your computer** and helps install anything missing.
2. **Sets up your vault.** Use a new one or the Obsidian vault you already have. No note in it is overwritten.
3. **Installs and proves it works.** A built-in doctor runs a real workflow and shows a pass or a fix for every check.
4. **Makes it yours.** Tell it about you, pick up to ten dashboard buttons from the starter workflows or your own skills, and choose whether you want voice.

> [!NOTE]
> Allow installation and network access when your agent asks.

### Already use Agentic OS? Upgrade instead

Open **Claude Code** or **Codex** and paste this:

```text
Use https://github.com/ctskool/agentic-os-starter-v2 to help upgrade the Agentic OS I already use. Find my installation and vault, explain what I can add, and preserve my customizations. Show me the plan before changing my setup.
```

You do not need to know your installation's path. The agent finds it, recommends compatible improvements, and asks before interrupting your running system. Customized setups get an integration plan. After the update it offers what is new, such as Live voice, once.

On a starter you have not modified, `node aos.mjs update` from the starter folder does the same in one command. Coming from the September 2026 release, it needs one extra step afterwards: see [How upgrades work](docs/UPGRADING.md).

<details>
<summary><b>What you need</b></summary>

<br>

| Requirement | Details |
|---|---|
| **A coding agent** | Claude Code or Codex, signed in with a plan that supports it. One is enough. |
| **Obsidian** | [Obsidian](https://obsidian.md) and a new or existing vault. |
| **Runtimes** | Node.js 22+ and Git. Python 3.12 (3.10 to 3.13) for voice and for conversations inside Obsidian. Python 3.14 is not supported by the voice libraries yet. Your agent helps install what is missing. |
| **Space** | About 3 GB of disk and 8 GB of RAM. Local voice accounts for roughly 1.3 GB of downloads. |
| **Optional keys** | An [OpenRouter](https://openrouter.ai) key for Jev, and an OpenAI API key for Live voice. You type them into a local setup page, never into chat. |

</details>

<br>

## What you get

Two screens on one system. The **Obsidian cockpit** lives in your vault and the **Jarvis HUD** runs full screen in your browser. Both read the same vault, so a report you start in one shows up in the other.

<table>
<tr>
<td width="50%" valign="top">
<b>Obsidian cockpit</b><br>
Today's plan, your top three priorities, schedule, metrics, and one-click workflows, inside the vault you already use.
</td>
<td width="50%" valign="top">
<b>Jarvis HUD</b><br>
A full-screen dashboard with Claude Code and Codex terminals, provider switching, and usage meters.
</td>
</tr>
<tr>
<td valign="top">
<b>Your skill buttons</b><br>
Starter workflows such as Plan Today, Morning Intel, and Deep Research, plus your own skills. Change them any time with <b>Customize dashboard</b>. <a href="docs/DASHBOARD.md">Dashboard skills</a>
</td>
<td valign="top">
<b>Reports you can edit</b><br>
Results are saved in your vault as Markdown, so you can open, edit, and link them like any other note.
</td>
</tr>
<tr>
<td valign="top">
<b>Claude Code and Codex</b><br>
Switch between them with one click. Each keeps its own conversations.
</td>
<td valign="top">
<b>Voice, local and live</b><br>
Speak a request on either screen. Local voice runs on your computer. Live voice is an optional real-time call.
</td>
</tr>
<tr>
<td valign="top">
<b>Jev</b><br>
An optional router that helps send eligible voice requests to the right place.
</td>
<td valign="top">
<b>Health checks and autostart</b><br>
A doctor that diagnoses problems and names the fix, a monitor that restarts services, and optional startup at login.
</td>
</tr>
</table>

<br>

## Talk to it

| | Local voice | Live voice |
|---|---|---|
| **What it is** | Click the microphone or use the shortcut, speak, then pause. | A two-way call with an assistant that answers from your day and hands real work to your agents. |
| **Runs on** | Your computer. Whisper hears you and Kokoro speaks the reply. | GPT-Live, with your own OpenAI API key. |
| **Cost** | No API charge for speech. | Estimated at five cents a minute while active and two cents in standby. |
| **Setup** | Chosen during installation. | Off until you opt in. Tell your agent “set up Live voice”. [Live voice guide](docs/LIVE-VOICE.md) |

On a Live call, each request it hands off shows a card on the HUD, and by default you have about 2.5 seconds to cancel before it starts. The [Live voice guide](docs/LIVE-VOICE.md) lists what a call sends to OpenAI and which parts you can turn off.

The voice shortcut is **Ctrl–Alt–J** on Windows and **Control–Option–J** on Mac. On Mac, keep the Obsidian orb enabled or the HUD visible. [Mac voice setup and permissions](docs/MAC-VOICE.md)

<br>

## How it works

<a href="docs/assets/how-it-works.png"><img src="docs/assets/how-it-works.png" alt="Agentic OS overview: you talk or click in the Obsidian cockpit or the Jarvis HUD, the bridge on your computer sends each request to an instant answer, a quick answer or real work in Claude Code or Codex, and everything reads and writes one shared vault" width="100%"></a>

<p align="center"><sub>Conceptual overview. Click the diagram to open it full size.</sub></p>

You ask or click. The bridge coordinates the work, your chosen agent carries it out, and both dashboards read the results from your vault. The local services listen only on `127.0.0.1`.

<br>

## Help

If something is not working, open the folder in your coding agent and say **“run the doctor”**.

| Guide | For |
|---|---|
| [Dashboard skills](docs/DASHBOARD.md) | Adding, removing, and reordering your buttons. |
| [Live voice](docs/LIVE-VOICE.md) | Getting a key, setting up calls, what is sent to OpenAI, and what it costs. |
| [Mac voice](docs/MAC-VOICE.md) | Microphone and shortcut permissions on macOS. |
| [Upgrading](docs/UPGRADING.md) | Moving an existing or customized setup to this version. |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Fixes for common problems. |
| [Commands and reference](docs/REFERENCE.md) | Commands and settings. |

<br>

<div align="center">

<a href="#install"><img src="docs/assets/mark.png" alt="" width="64"></a>

<sub><a href="LICENSE">MIT license</a> · Copyright (c) 2026 Chase AI · Third-party components retain their own licenses; see <a href="THIRD_PARTY_NOTICES.md">third-party notices</a>.</sub>

</div>
