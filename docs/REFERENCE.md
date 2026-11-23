# Commands and technical reference

Run commands from the starter's top-level folder. For guided installation, use the [setup playbook](../setup/PLAYBOOK.md); for an existing system, start with [the upgrade guide](UPGRADING.md).

## Commands

| Command | Purpose |
|---|---|
| `node aos.mjs status` | Show which services are running. |
| `node aos.mjs start` | Start this installation's services. |
| `node aos.mjs stop` | Stop them when no terminal conversation remains open. |
| `node aos.mjs doctor` | Check services, plugin, providers and the voice round trip. |
| `node aos.mjs doctor --full` | Also run one real workflow using your provider account. |
| `node aos.mjs setup` | Build and install using the vault and options chosen in the playbook. |
| `node aos.mjs upgrade` | Find existing installations and report upgrade options without applying changes. |
| `node aos.mjs update` | Update and rebuild a recognized, unmodified starter as a complete release. |
| `node aos.mjs jev-key` | Add or replace an OpenRouter key through a local browser page. |
| `node aos.mjs openai-key` | Add or replace the OpenAI API key and record consent for [Live voice](LIVE-VOICE.md). |
| `node aos.mjs autostart on\|off` | Enable or disable starting this installation at login. |
| `node aos.mjs dashboard` | Manage dashboard choices; see [personalization commands](DASHBOARD.md). |
| `node aos.mjs schedule` | Run a bundled workflow by itself at a set time, for example `schedule add plan-today 07:00 --days weekdays`. Nothing is scheduled until you add it; `node aos.mjs schedule help` explains the rules. |
| `node aos.mjs voice` | Show and change how voice sounds (mute, voice, speed), how fast it answers, and the words it listens for. `node aos.mjs voice help` lists the choices; the same settings are in the voice menu on both screens. |
| `node aos.mjs about show` | Show the About me text Live receives and the bytes used out of 2,000. |
| `node aos.mjs about write --from <file>` | Back up `AGENTS.md` if it exists, then write its About me section from a file. |
| `node aos.mjs about migrate` | Preview moving `CLAUDE.md` to `AGENTS.md` and linking it back with an import. Add `--yes` to apply after reviewing the preview. |

Doctor prints **PASS**, **FAIL**, **WAIT** or **SKIP**, with reasons. Any FAIL produces exit code 1; the summary distinguishes core failures from optional features that need attention. Its speech round trip tests generated audio, not your microphone. See [Mac voice checks](MAC-VOICE.md) for app permissions and shortcut testing.

If a terminal conversation is still open, `stop` changes nothing and prints:

```text
Stop active tasks in Terminals first. No service was stopped.
```

When you are ready to end that conversation, close its terminal tab in the HUD or Obsidian, then retry. An upgrade or service handoff needs your agreement before interrupting a working installation. Use that installation's own scripts; leave unrelated speech services and recovery tasks alone.

`update` refuses customized or unknown source before stopping services. Do not discard modifications to bypass that check. Custom projects need the [upgrade playbook's integration plan](../setup/UPGRADE.md) and may require manual future upgrades.

## Layout and local ports

```text
aos.mjs           Top-level launcher
setup/            Instructions for the installing or upgrading agent
obsidian-v2/      Bridge, Obsidian plugin, workflows, speech and vault template
jarvis-v2/        Browser HUD
docs/             User guides and troubleshooting
```

Services bind to `127.0.0.1`: **3217** HUD, **3218** preview, **3219** bridge, **3220** this installation's speech service, **3221** monitor. A compatible shared speech service can have a different address, shown by doctor. Only one installation can own the fixed ports; identify the existing owner before starting another. Do not expose these services to the internet.

The daily-note structure follows `system/schemas/daily-note.md` (v1) in the vault. Keep its section headings intact: the cockpit parses them. Customize the content within those sections. Dashboard button choices live separately in `system/v2/dashboard.json` and survive supported updates.

**Share task titles** controls `liveShareWork` in `system/v2/profile.json`. It defaults to `true`. Set it to `false` from the Live settings on either screen to omit the work-in-progress section. **Share morning brief** controls `liveShareBrief`. It defaults to `false`. Set it to `true` to send the whole morning brief, including its email section, to OpenAI at the start of each Live call, so Live can answer from it directly. To revise the personal section of the Live snapshot, ask your coding agent “update my About me”.

**Task updates** uses `liveTaskUpdates` in `system/v2/profile.json`. Choose `done` (**Done & blockers**, the default), `silent` (**Screen only**), or `chatty` (**Check in on long tasks**, after each three-minute interval). Both screens use the same choice.

Say “slash today”, “run the today slash command”, or “run slash plan-tomorrow for next week” to run an installed skill in a fresh terminal on the selected provider. The CLI receives the slash command and its arguments as given. Install the skill or command in the provider’s supported locations before invoking it.

The **Confirm actions** setting uses `liveConfirm` in `system/v2/profile.json`. Its values are `auto` (**Just do it**, the default, with about 2.5 seconds to cancel), `voice` (**Say yes**), `click` (**Tap to confirm**), and `destructive` (**Ask only for stops & edits**). Both screens use the saved choice.

## Data and costs

In **Local** mode, speech recognition and speech generation run on your computer. Local speech has no speech API charge. Claude Code/Codex requests use your provider account and may include vault content the workflow reads. Searches, connectors and personal skills can contact other services and incur their own charges.

[Live voice](LIVE-VOICE.md) is opt-in and uses the OpenAI API organization linked to your key. The call bar estimates $0.05 per active minute and $0.02 per standby minute. Check your API usage page for actual charges.

Optional Jev uses OpenRouter to reduce routing delay for eligible voice requests. It does not generate the answer or perform the work, and voice works without it. It sends spoken text, brief recent voice exchanges, the selected conversation's title and excerpt, and report names. Full note files are not attached to the router request, but conversation excerpts can contain quoted note content. OpenRouter usage is billed separately; routing speed and cost vary.

Enter keys through the local setup page, never chat. Bundled workflows are instructed to write drafts and reports without sending messages, publishing, scheduling posts or deleting notes. Personal skills follow their own instructions and the coding agent's permissions; review their required accounts and external actions before connecting them.

For repairs, ask your coding agent to “run the doctor” and follow [troubleshooting](TROUBLESHOOTING.md).
