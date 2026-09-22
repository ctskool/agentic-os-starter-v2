# Make the dashboard yours

Choose **Customize dashboard** in the Obsidian cockpit or the Jarvis HUD. Pick up to ten buttons, change their order, and save. The same selection appears in both places within a few seconds.

- **Keep the defaults:** before you personalize, Obsidian keeps its original ten buttons and the HUD keeps its four. Restoring defaults returns each app to that layout.
- **Choose your own:** your saved list replaces both sets of quick buttons. You can choose fewer than ten, or none. The full workflow browser stays available.
- **Save or cancel:** changes to your button selection apply when you save. Registering an installed skill adds it to the available catalog immediately, but does not run it.
- **Two windows:** if another window changes the saved configuration while you are editing, reload and reconcile the selection. The older draft cannot silently overwrite it.

## Included workflows and personal skills

Included workflows such as Plan Today, Deep Research and Content Cascade use the existing background workflow runner and save a report in your vault. Some need a calendar, email connection or source URL.

Use **Find installed skills** to discover skills in the standard folders for your chosen coding tool. Select an existing skill to register it, then add it to your dashboard. You can also register an exact local `SKILL.md` path. Discovery does not install anything or scan your notes.

Personal skills open an ordinary conversation in Claude Code or Codex. Enter what you want the skill to do; questions and approvals appear in the terminal. A registered file is not a guarantee that its connectors, helper tools or accounts are ready. If they are missing, finish that setup in the conversation.

Running a personal skill inside Obsidian needs the **Terminal** community plugin (by polyipseity) enabled: any stable 3.x release from 3.27.1 on; 3.27.1 and 3.27.2 are tested, newer ones show a one-time notice, pre-releases are not supported. If you prefer not to install it, use the same button in the Jarvis HUD. Bundled background workflows do not need that plugin.

A skill is tied to the provider or providers it was registered for. Switching providers can disable an incompatible button. A missing or changed skill file is also disabled; re-register the reviewed file to use its new version. Skills are never downloaded or executed merely because they were found.

Registration accepts ordinary local files in their actual folder. Linked files or folders and hard-linked files are rejected; use the real folder path instead of a shortcut or symbolic link. Discovery may skip linked or invalid folders and reports when its bounded search was incomplete.

## Commands for your installing agent

Run from the starter repository. The configured vault is used automatically; `--vault "<absolute vault path>"` can select another installed Agentic OS vault explicitly. These commands do not start or stop services.

```text
node aos.mjs dashboard list
node aos.mjs dashboard discover --provider claude
node aos.mjs dashboard discover --provider codex
```

`list` returns the catalog, saved selection and a `revision`. Use that revision when changing the configuration:

```text
node aos.mjs dashboard select --skills "plan-today,deep-research-chase,weekly-review" --revision "<revision>"
node aos.mjs dashboard add --path "<absolute path to SKILL.md>" --provider claude --revision "<revision>"
node aos.mjs dashboard reset --revision "<revision>"
```

For registration, `--provider` accepts `claude`, `codex` or `both`; only choose `both` after checking compatibility. Optional `--label "Write proposals"` supplies the button label. The result includes a `registeredId` and the updated revision. Include that ID in your next `select` command to pin it. `--skills none` explicitly saves an empty quick-button list.

Keep unrelated notes and profile settings unchanged. The configuration is a separate file, `system/v2/dashboard.json`, inside the vault. It is preserved by setup and update. If it is malformed, the UI reports the error and refuses to overwrite it; have your coding agent help repair that file.

## Suggestions during setup

Tell the agent what work you do and which skills you use often. It should explain a short recommended selection and ask you to approve it. It should not invent usage history, install every recommendation, or promise an unconnected skill works. Keeping the defaults is always an option.

You can also describe a new workflow you want a button for. The agent can help create that skill in your coding tool's normal skill folder, check its requirements, and register it once it is ready. The dashboard itself does not generate a skill from a label: every personal button points to an actual reviewed SKILL.md file.
