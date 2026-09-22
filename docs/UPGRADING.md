# Upgrading the Agentic OS you already use

You can start from V1, an older V2 starter, or a version you have customized. Open Claude Code or Codex and say:

```text
Use https://github.com/ctskool/agentic-os-starter-v2 to help upgrade my existing Agentic OS. Find my installation and vault, explain what I can add, and preserve my customizations. Show me the plan before changing my setup.
```

Your agent first finds your installation and vault. If it finds several, it asks which vault you use. If it cannot find yours, it helps you locate the vault through Obsidian and your computer's folder browser; you do not need to know the path beforehand.

```text
Find existing system       No changes or service interruption
        |
Choose improvements       Keep your customizations by default
        |
Review a concrete plan    Files, dependencies, tests and rollback
        |
Apply and verify          Agree before interrupting your working system
```

You can ask for the cockpit, Jarvis HUD, local voice, optional Jev, personal dashboard buttons, or bundled workflows. Your agent explains what each needs and suggests a compatible approach. A skill or plugin being present does not prove it works with the rest of your system. Some features require matching bridge, plugin and HUD changes.

Tell the agent which parts of your existing setup matter to you, and which skills you use often. It can inspect selected non-secret files to compare versions, but it cannot infer your usage history from a list of installed skills.

| Your starting point | The usual route |
|---|---|
| Unmodified, recognized V2 starter | Update the existing installation as one release. Preserve vault notes, dashboard choices and supported preferences. |
| V1 | Prepare and test V2, keep the same vault, and keep the old plugin available until the new system is verified. |
| Customized or unknown project | Review an integration plan, preserve your custom code, implement the chosen compatible changes, and test before a service handoff. Future upgrades may require manual integration. |

There is no universal automatic merge. The agent should explain actual conflicts and let you decide when your preferences are unclear. It should keep scoped backups of the non-secret files it changes, preserve your existing notes and Obsidian settings, and never copy your whole vault or credential directories as an upgrade backup. Keys stay out of chat; you enter a missing key through the local setup page yourself.

The two commands have different purposes:

```text
node aos.mjs upgrade    # Read-only discovery and report; does not apply an upgrade
node aos.mjs update     # Changes a recognized stock starter and rebuilds it
```

**Updating from the first public release (September 2026):** that version of `update` pulls the new files but then runs the setup code it had already loaded. Run `node aos.mjs setup` once after that update so the new setup steps run too (choosing the coding tool, the Python checks and the Windows login-task repair). Later updates run the new setup automatically.

`update` refuses customized or unknown source before stopping services. If it refuses, have your agent inspect the changes and plan an integration. Do not discard your modifications just to force it through.

Only one installation can own the system's fixed ports. Your agent must get your agreement before stopping the working installation, use its own scripts, and keep a way to restore it. Tests that need those occupied ports wait for that handoff. Unrelated speech services and recovery tasks should remain alone.

At the end, your agent should say what changed, which tests passed, what failed or was skipped, which installation is running, and how you should update next time. **macOS remains beta:** automated checks do not replace testing the microphone, cockpit and HUD on your own Mac.

The detailed instructions your agent follows are in [the upgrade playbook](../setup/UPGRADE.md). If something is broken and you only want a repair, say **"run the doctor for my existing installation"** instead.
