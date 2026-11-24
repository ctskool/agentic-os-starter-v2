# Tandem Mode — Codex Paints, Claude Codes, Each Checks the Other

Extension of codex-build, offered at the claudex-loop Resolution gate ONLY when the Phase 0 capability scan confirmed a matching Codex capability (see `../claudex-loop/CODEX-CAPABILITIES.md`). Two tracks run in parallel: **Codex generates contracted assets in isolated staging** (raster PNGs and/or procedural three.js model modules) while **Claude builds the code in the repo**. Neither track can write into the other's zone. Cross-inspection at merge: whoever made the thing never checks the thing.

This is the lean v1 of the reviewed design (`../claudex-loop/TANDEM-DESIGN.md`, 8 Codex review rounds, APPROVED 2026-08-16). Deferred to a future headless mode: import journal recovery tables, exclusive run leases, launcher attestation. Everything below is the interactive path.

## The cross-check matrix (the one rule)

| Work | Made by | Checked by |
|---|---|---|
| Assets (textures/sprites/models) | Codex | Claude (mechanical + visual QA) |
| Code | Claude | fresh read-only Codex (PR-style) |
| Asset taste (bar pass) | Codex | fresh clean-context Claude subagent |
| Screen taste (bar pass) | Claude | fresh Codex judge, repo-blind |

## Tunables

| Var | Default | Meaning |
|-----|---------|---------|
| `MAX_FIX_ROUNDS` | `2` | Asset fix iterations via resume, then fallbacks activate. |
| `MAX_BAR_ROUNDS` | `2` | Total blind judgments per bar, INCLUDING the initial one → at most one revision. |
| `MAX_INSPECTION_ROUNDS` | `2` | Initial code inspection + one reinspection after accepted fixes. |
| `LOG_FILE` | `PLAN-REVIEW-LOG.md` | Gets `## Act 3 — Tandem Build`. Claude is the SOLE writer — reviewer output recorded verbatim after each process finishes. |

## Terminal outcomes (report exactly one)

- `SUCCESS` — all gates green, all applicable bars passed.
- `DEGRADED_READY` — correctness green, but a bar capped/UNJUDGED or fallbacks activated. Never report a capped bar as a win.
- `NEEDS_REPLAN` — a needed fix exceeds the plan's scope (product/security/schema decisions are never auto-arbitrated). Preserve state, hand to human.
- `HARD_FAILED` — probe dead, sandbox verification failed, or unrecoverable import.

## The contract — `assets.contract.json`

Authored in claudex-loop Phase 1, locked with the plan, immutable afterward. Top level declares one `asset_root` (all paths beneath it) and optional `bar` entries (reference path + sha256 + locked rubric + normalization rules). Per asset:

```json
{
  "id": "wall-concrete",
  "type": "raster",
  "path": "textures/wall-concrete.png",
  "action": "create",
  "baseline_sha256": null,
  "format": "png-rgba",
  "dims": [64, 64],
  "tileable": true,
  "style": "cool-gray concrete, uniform light, no text",
  "fallback": "procedural-placeholder"
}
```

Raster extras as needed: `anchor`, `frames: {count, layout}`, `scaling`, `alpha`. Model-module entries use `"type": "model-module"` with `export` (factory signature), `mesh_count: [min, max]`, `bounds` (dims), `three_version`, optional `render_check: true`. `action` ∈ `create|replace` (`replace` requires `baseline_sha256`). `fallback` ∈ `procedural-placeholder | stock:<path> | omit | user-provided:<path>` — stock/user-provided validated + hashed at plan-lock; every fallback must execute unattended or tandem is refused.

**Bar comparability gate (at bar-lock, learned 2026-08-16):** a bar entry is valid ONLY if the reference is the same medium and fidelity class as the deliverable — a stylized low-poly web build is judged against a best-in-class *low-poly web* reference, never against AAA-game footage; pixel art against pixel art at comparable resolution; a web UI against a web UI at the same viewport class. A class-mismatched reference forces one of two outcomes: reject it and pick a comparable bar, or keep it explicitly tagged `"aspirational": true` — shown to the human at the final gate for context but NEVER PASS/FAIL judged (it is unpassable by construction, and judging it produces either a dishonest PASS or a meaningless FAIL). Each bar entry records `medium` + `fidelity_class` so the gate is checkable, not vibes.

## Step 0 — Gates

1. Standard codex-build gates: spec exists (`PLAN.md` + `assets.contract.json`), clean tree, **user-approved baseline commit exists** (greenfield without one → tandem unavailable; user commits a scaffold first).
2. Record base commit hash + path ownership: Codex's import zone = the contract's single `asset_root` (every contract path must resolve beneath it — reject `..`, absolute paths, symlinks/reparse points, Windows reserved names, case-collisions); Claude's zone = everything else. Claude writes NOTHING into `asset_root` during the build (in-memory placeholders only).
3. **Kickoff probe:** if the capability was "matched, unverified," run `bash ../claudex-loop/probes.sh <probe-id> <staging>` now. Failure → execute the probe-failure policy declared at Resolution (default: Claude-builds with declared fallbacks). No mid-flight questions.

## Step 1 — Launch the asset track (background)

Create fresh staging OUTSIDE the repo (scratchpad): copy in `PLAN.md` + `assets.contract.json`, create `out-r1/`.

```bash
P=$(mktemp)
cat >"$P" <<'EOF'
ASSET TRACK. Read assets.contract.json in this directory — it is the locked contract.
The project repo at <REPO_PATH> is READABLE — consult it for integration context
(loader code, three.js version, style of neighboring code). You cannot write there.
For each contract entry: generate the asset to out-r1/<path>.
  - Raster entries: exact dims, format, alpha semantics, style descriptor. Tileable
    means 0 opposing-edge pixel mismatches — verify your own output.
  - Model-module entries: self-contained JS exporting the contracted factory signature,
    returning a THREE.Group within the contracted mesh-count range and bounding dims.
    Execute your module in Node to verify before reporting. If network is enabled and
    the contract flags render-check, you may npm-install locally (redirect caches:
    npm_config_cache=./.npm-cache) and screenshot-verify your own render.
Do NOT modify assets.contract.json. Write out-r1/results.json: per asset id — produced
path, sha256, status, provenance notes. Write out-r1/READY-<RUN_ID> LAST.
EOF
codex exec -s workspace-write -c approval_policy="never" \
  ${NETWORK:+-c sandbox_workspace_write.network_access=true} \
  --json -o "$STAGING/asset-track-report.txt" - <"$P" 2>/dev/null | grep '"type":"thread.started"'
```

- Run from the staging dir. Capture `THREAD_ID` from the correlated `thread.started` event — missing event = hard failure, never infer from sessions-dir recency.
- Launch with `run_in_background: true`; completion notifies. `timeout: 600000` ceiling per invocation; on timeout kill the process tree — no `READY-<RUN_ID>` = rejected round, no partial acceptance.
- Network flag: only when the contract includes model modules with render-check (per `self-visual-verify` card entry) — it permits npm installs in staging, nothing more.

## Step 2 — Code track (Claude, simultaneously)

Build the engine/app in the repo as usual. Load assets from contracted paths; render in-memory placeholders at contract dims for anything not yet imported. Keep it headless-testable throughout. Don't wait on the asset track — the tracks can't observe each other until import.

## Step 3 — Asset QA in staging (ALL acceptance before import)

When the background task completes:

1. **Mechanical pass (scripted):** round valid only if exit clean + `READY-<RUN_ID>` present + `results.json` complete. Then per asset: file exists, sha256 matches results.json, dims/format/alpha per contract; model modules execute in Node (export signature, mesh count, bounding box). Path canonicalization against `asset_root`.
2. **Visual pass:** populate `asset-lab-template.html` (this folder) from contract + results → open in the Browser pane → check anchors, silhouettes, frame strips, tiling seams at actual size.
3. **Fix rounds:** violations → resume the SAME session, findings cited per asset id, output to fresh `out-r<N>/` with its own `READY-<RUN_ID>`:

```bash
codex exec resume "$THREAD_ID" -c sandbox_mode="workspace-write" -c approval_policy="never" \
  --json -o "$STAGING/asset-track-report.txt" - <"$P2" 2>/dev/null >/dev/null
```

   Hash-compare each round against previously accepted assets — an approved asset silently changing hash is itself a finding. After `MAX_FIX_ROUNDS`: each still-failing asset's declared fallback activates in staging.
4. **Asset bar pass (if contract declares a bar):** runs NOW, in staging, before import. Anonymized side-by-side (candidate vs hashed reference, randomized A/B, seed recorded) + the locked rubric → a **fresh clean-context Claude subagent** (Agent tool; it gets ONLY the composite + rubric, no build history). Verdict persists before mapping is revealed.
   - **Binary first, rubric second (anti-curve rule, learned 2026-08-16):** the judge's FIRST required answer is "blind: which is better, A or B?" If the reference wins **materially**, the candidate CANNOT pass — no threshold wiggle room, no "fine for what it is." The rubric's job is then the gap list (*why* it lost), not an escape hatch to PASS anyway. A verdict that contradicts the human eye is worse than a loss.
   - **Judge reasoning is recorded verbatim in the log** — a two-line verdict can hide grading-on-a-curve; the reasoning cannot.
   - Verdicts: `PASS` / `FAIL`+gaps / `INVALID_COMPARISON` (setup failure: one free retry, second → `NEEDS_REPLAN`). Judge unavailable → bar `UNJUDGED`, outcome `DEGRADED_READY`, show the human the comparison at the final gate. FAIL → the one revision (regeneration or the declared fallback as candidate), re-judge. Capped loss → `DEGRADED_READY`.
5. Freeze the final accepted set with hashes.

## Step 4 — Import (validate-then-copy)

Immediately before copying: re-verify the live `asset_root` still matches the kickoff baseline (abort on undeclared external change). Then copy the accepted set into the repo — only contracted paths, `create` entries must not collide, `replace` entries must match their declared `baseline_sha256`. Log imported hashes + provenance (generated round N / fallback-activated). Nothing else crosses — not node_modules, not scratch files, not the staging repo Codex may have inited.

## Step 5 — Integrated proof + UI bar + cross-inspection

1. Claude runs the plan's proof gates with real assets (tests, perf, screenshot). Codex's claims are advisory — same as base codex-build.
2. **UI bar pass (if declared):** normalized render of the running app (fixed viewport/state/theme) vs the reference — judged by a **fresh read-only Codex session launched from a neutral dir** containing only the anonymized renders + rubric (never from the repo — filenames deanonymize). Same verdict rules as Step 3.4, including binary-first (reference materially better = no PASS) and verbatim reasoning in the log. A bar-driven UI revision invalidates and reruns affected proof gates.
3. **Code cross-inspection (last):** fresh read-only Codex session (`codex exec -s read-only`, NEW thread) gets the plan, base commit, ownership map, and the code-only diff. PR-style findings → Claude arbitrates (accept with fix / reject with logged reason). Accepted fixes rerun affected gates; cap `MAX_INSPECTION_ROUNDS`. Out-of-scope findings → `NEEDS_REPLAN`.

## Step 6 — Human gate

Present: terminal outcome, code diff, **asset contact sheet** (from the QA lab), results manifest with hashes + per-asset provenance, bar verdicts (with the anonymized comparison if UNJUDGED/capped), inspection summary, proof output, rounds used. Ask: commit? Claude commits on yes — never Codex, never automatic.

## Hard rules

- Codex never writes to the repo — staging only, until Claude's validated import. (Reads are allowed and encouraged.)
- `assets.contract.json` is immutable once locked. Codex emits `results.json`; the producer never attests against a spec it can edit.
- Whoever made the thing never checks the thing — no exceptions, including judges (clean-context, repo-blind).
- Every loop is capped; a capped bar loss reports as `DEGRADED_READY`, never success.
- Inside Act 3, regardless of anything: no commits, pushes, releases, deployments, migrations, or outbound communications.
- Suppress questions (every branch has a pre-declared answer), never suppress telemetry — background-completion banners and brief state lines stay.
