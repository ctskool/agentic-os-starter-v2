# Upgrade playbook (for the coding agent)

Help a member improve the Agentic OS they already use while keeping their notes, skills and customizations. The member chooses **fresh install** or **upgrade existing** at entry. Do not make "selected features" a third onboarding choice: explain feature choices after you have identified their existing system.

Honor an explicit upgrade request even when this repository contains `obsidian-v2/.runtime/aos-setup.json`. That marker does not mean the member asked for repair. A repair request can use the same discovery to find the intended installation, then follow the repair instructions in `PLAYBOOK.md`.

```text
Find existing system (read only)
              |
Explain what can be added and what must move together
              |
Member approves a concrete plan
              |
Prepare and test changes away from running services
              |
Member authorizes handoff -> verify -> keep rollback available
```

## 1. Find their installation for them

From this starter's root, run:

```text
node aos.mjs upgrade
```

If this starter is a separate checkout obtained to guide the upgrade, treat it as the reference copy. Do not assume it is the member's running installation, and do not clone over an existing project to obtain these instructions.

This command reports candidates from known installation locations, Obsidian's registered vaults, and a running monitor's non-secret location metadata. It is **discovery only**: it does not download a release, install anything, change files, run doctor, stop services or apply an upgrade. Do not add `git fetch`, `git pull`, a health check or a service restart to this phase. There is no `upgrade --apply` command.

If Node is missing, explain that the discovery command needs Node and use the prerequisite instructions in `PLAYBOOK.md` with the normal installation permissions. Do not turn that prerequisite into permission to change their existing Agentic OS.

Read the actual report, including unavailable locations, errors and skipped checks. A candidate is evidence of an installation; it is not proof of a working or compatible system. An absent candidate is not proof that nothing is installed. Show the member a short plain-language account such as:

> "I found your Client Work vault and an Agentic OS folder associated with it. I will compare its non-secret code and settings before recommending changes. Your running system has not been changed."

If there are several plausible targets, ask which **vault name** they use, listing the names you found. Resolve its installation from the evidence. Use paths only to distinguish genuinely ambiguous candidates, not as the first question. The following options can narrow a known target; do not make the member type them:

```text
node aos.mjs upgrade --install "<identified installation folder>" --vault "<identified vault folder>"
```

If discovery finds none, guide the member to open Obsidian's vault switcher and identify the vault they use. Help them reveal that vault's folder with Obsidian's folder/open-in-system-explorer action, then use the revealed location. If their app version has no such action, guide them through Finder or File Explorer from the vault they recognize. Do not quiz them on paths or recursively search their whole home directory. If there is genuinely no existing Agentic OS, explain that finding and offer the fresh-install route.

## 2. Compare the chosen system without disturbing it

Limit inspection to the selected installation and relevant non-secret files in its vault. Read manifests, package versions, source entry points, launcher scripts, selected skill instructions, and explicit configuration schemas as needed. Git status, file-name-only differences and commit IDs can help identify edits; inspect content only in selected non-secret files. Never dump all environment variables, runtime files, configuration files or repository diffs.

Never read, print or copy `jev.json`, `bridge-auth.json`, `providers.json`, `.credentials.json` or `~/.claude/.env`. Do not obtain keys from the member in chat. The presence of a credential file does not authorize reading it. If a future handoff needs a key configured, the member uses the existing local key-entry flow themselves.

Record evidence for:

- Which vault, installation folder and source revision belong together; which installation currently owns the service ports, if known.
- Whether this is a maintained V2 starter, V1, or a customized/unknown project. A clean Git checkout can still contain committed personal changes; cleanliness alone is not evidence of stock source.
- The member's custom dashboard, skills, workflows, notes structure and relevant integration changes. Ask what they value and use often; file presence is not usage history.
- Which proposed changes need matching bridge, plugin, HUD or launcher versions. Read their contracts before claiming compatibility.

Do not run doctor or execute an existing workflow during discovery. Those are active validation steps, and `doctor --full` spends provider usage and writes a report. Schedule them in the approved plan. Do not read unrelated notes to make an inventory, and do not edit vault settings to make the inventory easier.

## 3. Explain choices, then recommend a compatible plan

Start with: *"What do you want to improve in the version you already use? I can also explain what this starter adds and suggest a starting point."* Preserve their current customizations by default. They do not need to replace everything to express a preference, but some components must be upgraded together.

Use this capability list as a guide to discussion, not as an automatic compatibility detector:

| Capability | What the member gets | Dependencies to check |
|---|---|---|
| Obsidian cockpit | Daily plan, metrics and workflow controls in the vault | Compatible plugin and bridge; existing note/parser conventions; Obsidian. Personal-skill conversations inside Obsidian also require the Terminal community plugin, a stable 3.x release from 3.27.1 on. |
| Jarvis HUD | Browser dashboard and agent terminals | Compatible HUD, bridge and launcher/monitor configuration; selected Claude Code or Codex CLI. |
| Local voice | Speech recognition and spoken replies on the computer | Compatible bridge and voice client, Python/model requirements, microphone permission, and either owned speech or an already compatible shared service. |
| Optional Jev | Routing for spoken requests through OpenRouter | Compatible voice routing; member's OpenRouter account and credit; key entered locally. Voice can work without Jev. |
| Personal dashboard buttons | Choose and order up to ten bundled or installed skills | Matching dashboard APIs, configuration schema and UI versions; each personal skill's actual provider and dependencies. Obsidian personal skills require Terminal; Jarvis can run them without that plugin. |
| Bundled workflows | Reports and drafts such as planning, research and content | Compatible runner/bridge and vault conventions, a signed-in coding provider, plus any connectors required by the specific workflow. |

For example: "You want your own skill buttons and you like your current dashboard design. I recommend keeping the design and integrating the dashboard API, saved selection and matching button controls together. I will check the bridge contracts first; copying just the buttons would not establish compatibility."

Read the selected existing and new code to substantiate that recommendation. Identify what can stay, what must change together, and what is currently uncertain. If a feature cannot safely fit their version, explain the missing dependency and offer a coherent larger upgrade or defer that feature. Never promise a universal automatic merge.

Present one concrete plan before applying it. Include the chosen vault and project, requested capabilities, exact files/component groups to change, customizations to preserve, conflict choices, scoped backup location, tests, rollback, and any later service interruption. Explain optional costs and account setup only where relevant. Get approval for this plan; do not substitute a generic "may I upgrade?" for a reviewable result.

## 4. Use the appropriate execution case

These are internal implementation cases. Describe their consequences simply instead of making the member diagnose their project.

### A. Recognized stock V2 starter: update it as a whole

Use the existing installation folder. The bridge, Obsidian plugin, HUD and launchers are maintained as one release; optional features can still be enabled or left unused. Preserve the member's vault, dashboard choices and supported preferences.

After the member approves the plan and the specific service handoff, run `node aos.mjs update` from that existing folder. The command changes source and rebuilds, so it is not a discovery command. Its source guard refuses customized or unknown checkouts **before stopping services**. Respect a refusal: identify the custom changes and move to case C. Do not reset files, remove the guard, force a pull, or reclone over the existing folder to get past it.

An older installation may still have an older update launcher without this guard. Inspect that non-secret update path before executing it; do not assume the new reference copy changed the installed command. Only use an older updater after the read-only comparison positively establishes stock source and its reviewed behavior is part of the approved plan. If that cannot be established, use case C instead.

Do available offline checks before the handoff; follow section 6 for the live verification and rollback decision. A refusal caused by active work is a reason to let the member finish that work, not to terminate their agents.

### B. V1 to V2: migrate the whole system while keeping the vault

Keep the old V1 installation and plugin available. Prepare the V2 starter in its own normal installation folder, outside the vault and cloud-sync directories. Reuse the same vault only after comparing its existing note conventions and the files V2 will add. Preserve every existing note and Obsidian setting; resolve incompatible conventions explicitly with the member instead of rewriting their notes to fit a parser.

Build and validate V2 in a throwaway vault first, using only non-secret sample data. Review the old runner and startup ownership; do not assume it is harmless, delete it, or disable its login item during preparation. Schedule a consented handoff if anything conflicts with the fixed service ports.

For the approved installation into their actual vault, follow the relevant fresh-install phases with the selected existing vault. Do not launch both conflicting service sets. Have the member enable the V2 plugin for verification. Keep the old plugin installed; disable the old cockpit only after V2 is verified and the member accepts the handoff. If V2 fails, restore the prior service ownership through its own scripts and have the member restore the old cockpit. Removing the old installation is a separate later decision.

### C. Customized or unknown project: integrate the approved scope

This is intentional work in the member's own project, not a stock update. Explain that it needs code comparison, implementation and testing, and that future updates may need the same care. Do not run blind `setup`, `update`, cherry-picks or directory replacement against that project.

After plan approval:

1. **Prepare an isolated working copy or branch.** Keep running source untouched while implementing. Use the member's owned project and an explicit allowlist of non-secret source/test files. Do not copy `.runtime`, credential directories, the whole vault or the entire `.obsidian` folder. Never create a broad vault commit. If Git is used, stage only the reviewed non-secret changes; creating a commit is not required to integrate a feature.
2. **Record a scoped rollback.** Save exact pre-change versions of the non-secret files that the approved integration will modify, outside the vault. Record newly created paths, source revision, dependency lockfiles, and the installation's own start/stop procedure. Preserve the member's current executable build until the replacement is validated. Do not back up secrets by copying the runtime directory.
3. **Resolve actual conflicts.** Show what a conflict changes in behavior. Ask whether to keep their version, adopt the starter behavior, or combine specific parts where intent is unclear. Do not choose "theirs" or "ours" for a whole merge merely to make it complete. Keep unrelated custom code, notes and settings out of the diff.
4. **Implement a compatible set.** Compare bridge endpoints, authentication/app identity, work-task and provider/model handling, event formats, vault schemas, plugin/HUD consumers and launcher paths for each selected capability. Integrate the required supporting pieces together. Preserve existing interfaces or add an explicit adapter when feasible; do not claim compatibility based on matching filenames or copied UI alone.
5. **Validate away from the member's running system.** Run relevant unit/contract tests and builds with synthetic fixtures. Use a throwaway vault for installation and workflow tests. Stub external actions and use disposable test skill files. Do not read/copy the real vault to seed tests, or test a skill by sending messages, publishing, purchasing or making other account changes. Fixed-port service testing must wait for the agreed handoff if the current installation owns those ports; passing offline tests is not a live-service test.
6. **Review the resulting change before handoff.** Summarize implemented behavior, exact changed files, passing tests and every failure or skipped check, plus remaining risks and rollback. If implementation reveals a materially larger scope or new conflicts, resolve those with the member before expanding it.

This is the explicit exception to the normal rule against changing starter source. Approval to add a dashboard skill through the supported configuration is not approval for a source integration. Keep a concise integration record with the project, limited to non-secret information and files the member agreed to create. Mark the project as requiring **manual future integrations** unless its customizations have been reconciled with a recognized maintained release. Never tell the member to use stock `update` blindly afterward.

## 5. Preserve preferences and secrets

Leave notes, custom skills, profile choices and dashboard order as they are unless the member explicitly chose a change. Do not replace `.obsidian` settings or enable/disable plugins by rewriting those files; guide the member through the Obsidian UI. If a schema migration is required, show exactly which non-secret configuration changes and back up only that scoped configuration before applying it.

A compatible shared speech service belongs to its owner. Do not stop, restart or reconfigure it to test the upgrade. Leave unrelated recovery tasks and login items alone. A selected plan can change this installation's own startup ownership only with specific permission and a rollback procedure.

The member supplies a missing Jev key through `node aos.mjs jev-key` when needed. Do not transfer it by reading the old installation's secret files. Inspecting an existing setup does not establish account access; explain and verify required connectors with the member without reading credentials.

## 6. Handoff, verification and rollback

Before interrupting anything, show which installation will stop, which one will start, what the member should finish first, and how to restore the prior system. Get explicit consent for that handoff; approval to inspect or prepare code does not authorize stopping their working system. Do not ask again if the member has already explicitly approved that exact handoff for this point in the plan.

Use the current installation's own stop/start scripts. Never kill an unknown listener or stop whichever process happens to occupy a port. Respect active-conversation safeguards. Only one installation may own ports 3217–3221; keep unrelated speech and recovery services running.

After the approved handoff, run the chosen installation's doctor. Run `doctor --full` only as included in the approved validation plan, explaining that it runs a real workflow on their subscription and writes a report. Test selected features, not just process startup: open the cockpit and HUD, check the saved dashboard order, and test voice if enabled. For a personal skill, ask for a harmless real task or use a disposable fixture; registration alone is not a successful workflow run.

Report PASS / FAIL / WAIT / SKIP exactly as observed, including error text and the reason for any skipped check. If the replacement cannot meet the agreed acceptance checks, use the scoped rollback and restore the prior installation's services. Preserve failure evidence in the approved non-secret project record; do not leave both service sets fighting over ports.

On macOS, describe automated checks and actual hands-on checks separately. Mac remains beta; successful builds or CI do not prove this member's microphone permissions, Obsidian plugin or HUD interactions work. Never claim those manual checks were performed if they were not.

Finish with what changed, what stayed customized, what was verified, anything still unavailable, which installation is active, where rollback lives, and the appropriate future update route. A discovery-only run ends with a recommendation; do not report it as an applied upgrade.
