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
| `node aos.mjs autostart on\|off` | Enable or disable starting this installation at login. |
| `node aos.mjs dashboard` | Manage dashboard choices; see [personalization commands](DASHBOARD.md). |

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

## Data and costs

Speech recognition and speech generation run on your computer; local speech has no speech API charge. Claude Code/Codex requests use your provider account and may include vault content the workflow reads. Searches, connectors and personal skills can contact other services and incur their own charges.

Optional Jev uses OpenRouter to reduce routing delay for eligible voice requests. It does not generate the answer or perform the work, and voice works without it. It sends spoken text, brief recent voice exchanges, the selected conversation's title and excerpt, and report names. Full note files are not attached to the router request, but conversation excerpts can contain quoted note content. OpenRouter usage is billed separately; routing speed and cost vary.

Enter keys through the local setup page, never chat. Bundled workflows are instructed to write drafts and reports without sending messages, publishing, scheduling posts or deleting notes. Personal skills follow their own instructions and the coding agent's permissions; review their required accounts and external actions before connecting them.

For repairs, ask your coding agent to “run the doctor” and follow [troubleshooting](TROUBLESHOOTING.md).
