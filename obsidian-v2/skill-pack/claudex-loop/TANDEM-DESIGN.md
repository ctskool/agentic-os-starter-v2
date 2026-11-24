# Design: Tandem Build Mode + Capability Detection for Crucible (rev 8 — base APPROVED at rev 5; Amendments A & B revised after amendment review round 2)

_Base design approved Round 5. Extends the claudex-loop skill (renamed from crucible 2026-08-16) (`SKILL.md` in this folder) and codex-build (`../codex-build/`)._

## Problem (unchanged)

The pipeline is either/or at build time: Codex builds OR Claude builds. Codex has differentiated capabilities Claude lacks — notably native raster image generation (headless, ChatGPT auth, PNGs to disk). No phase asks "does my counterpart have a tool I don't?" Projects needing visual assets waste this.

## A. Capability card + recon detection

1. **`CODEX-CAPABILITIES.md`** in the claudex-loop skill (renamed from crucible 2026-08-16) folder. Each entry:
   - stable ID (initial entry: `image-gen-raster`; vector generation is NOT claimed — it would be a separate entry gated on its own passing probe)
   - fires-when conditions, deliverable-shaped and restricted to what is verified: "plan's deliverables include raster art: sprites, icons, textures, UI chrome, hero images (PNG)"
   - known limitations + policy constraints
   - probe ID → implemented in `probes.sh` shipped with the skill (audited, allowlisted). Markdown never carries executable shell strings.
   - last-verified **environment fingerprint**: codex-cli version + configured model + auth account. Verification is valid only while the fingerprint matches; 90d expiry as secondary guard.
2. **Phase 0 step (after terrain detection):** match the task's deliverables against fires-when conditions. A hit is recorded in the Assumptions Ledger as a **proposed build strategy**, not a fact. If the fingerprint is stale, it is recorded as "matched, **unverified**" — **Phase 0 runs no writing probe of any kind.** Availability checks in Phase 0 are limited to non-writing ones (`codex --version`, config read). The generation probe runs at **Act 3 kickoff**, after the user has selected tandem, in isolated staging — so no generation resources are spent before the strategy is confirmed, and the parent rule (Codex strictly read-only through Phases 0–2) holds without exception.
3. **Downstream:** when the strategy is confirmed, Phase 1 adds asset-contract questions to the decision map (load-bearing: dimensions, anchors, atlas vs files, frame layout, scaling, alpha semantics, per-asset action + fallback; cosmetic: palette, style wording). The contract is the machine-readable manifest below, referenced from PLAN.md `## Assets`.

## B. The asset contract manifest (locked, immutable)

`assets.contract.json`, authored during Phase 1, locked with the plan, **never modified afterward**. Per asset:

```json
{
  "id": "player-idle",
  "path": "assets/sprites/player-idle.png",
  "action": "create",
  "baseline_sha256": null,
  "format": "png-rgba",
  "dims": [64, 64],
  "anchor": [32, 60],
  "frames": {"count": 4, "layout": "horizontal-strip"},
  "scaling": "nearest",
  "alpha": "straight",
  "style": "chunky pixel-art, 4-color ramp, top-left key light",
  "fallback": "procedural-placeholder"
}
```

- `action` ∈ `create | replace`. `replace` requires `baseline_sha256` of the existing file; import rejects any destination collision not declared as `replace` with a matching baseline hash.
- `fallback` ∈ `procedural-placeholder | stock:<path> | omit | user-provided:<path>`. **Every fallback is validated at Phase 1:** stock/user-provided files must exist on disk at plan-lock and are hashed into the contract; if any declared fallback cannot execute unattended, tandem is refused at Resolution. "Claude fixes it" is never a fallback (Claude cannot generate art; that gap is why tandem exists).
- Codex **never writes this file**. It emits a separate **results manifest** (`out-r<N>/results.json`: asset IDs, produced hashes, generation status, provenance only), which Claude validates against the locked contract. The producer cannot attest against a spec it authored.

## C. Tandem build mode (extends codex-build; offered at Resolution only when the strategy flag is set)

**Baseline requirement:** tandem requires an existing **user-approved baseline commit**. Brownfield: clean tree at the recorded base commit (existing gate). Greenfield without a repo/commit: tandem is **unavailable** — no automatic scaffold-and-commit (commits happen only on explicit human approval, per codex-build's own gate; the user can make/approve a baseline commit and then pick tandem). Base commit hash + path-ownership map recorded at kickoff; each lane is reviewed against this immutable baseline.

**Act 3 kickoff probe:** if the capability was "matched, unverified," run the generation probe now (staging-isolated, one small PNG). The **probe-failure policy is declared by the user at the moment tandem is selected** (default: "fall back to Claude-builds with every asset's declared fallback") and executes automatically on failure — no new mid-flight human gate.

**Asset track (Codex, isolated staging):**
1. Claude creates a fresh staging directory containing only: PLAN.md copy, `assets.contract.json` copy, empty `out-r1/`. The staging root must not be shared with any other writable consumer, and must not contain or be contained by the repo.
2. **Sandbox verification before launch:** the invocation pins `-c sandbox_mode="workspace-write"` scoped to the staging dir, `-c approval_policy="never"` (unattended — no escalation requests, no stalls), and excludes implicit writable temp roots from the effective sandbox (verified against the CLI's effective config, not assumed — workspace-write may grant temp-root writability by default, and both staging and repo-adjacent paths can live under the Windows temp hierarchy). Stated precisely: the asset track has **no write access to the repo**; reads are not restricted by workspace-write and are accepted (the repo is not secret from the reviewer-turned-producer).
3. **Launch mechanics — one prompt-delivery method, stated exactly:** prompt written to a temp file, delivered via stdin per codex-build's verified pattern (`codex exec ... - < "$PROMPT_FILE"`), with `--json` and `-o` for the last message; 10-minute ceiling; background Bash task. `thread_id` comes ONLY from a correlated `thread.started` event in this invocation's captured JSON stream — a missing event is a hard failure (no inference from sessions-dir recency).
4. Prompt: read the contract, generate every asset to `out-r1/<path>`, write `out-r1/results.json`, then write `out-r1/READY-<run_id>` **last** (run_id supplied by Claude in the prompt, unique per invocation).
5. On timeout: kill the full process tree. A round is valid only if: process exited cleanly per the captured exit record AND that round's own `READY-<run_id>` exists AND `results.json` is complete. Root-level or prior-round markers count for nothing.

**Code track (Claude, main session, repo):**
6. Claude builds engine/app code in the repo simultaneously. Assets load from contracted paths; anything absent renders as an in-memory placeholder at contract dims (no files written into the asset zone — that zone belongs to the import step alone). Headless-testable throughout. The tracks cannot observe each other mid-flight, so parallelism carries no coordination risk; sequential remains a degraded mode.

**QA in staging (all acceptance happens BEFORE import):**
7. Mechanical pass per staged candidate: results.json validated against the locked contract (every ID present, hashes match files, dims/format/alpha per spec). Path canonicalization against the ownership allowlist — reject absolute paths, `..`, reparse points/symlinks, Windows reserved names, case-insensitive collisions, undeclared destination collisions.
8. Visual pass: the QA harness — a **fixed, audited, script-free HTML template shipping with the skill** (Codex never generates it) — is populated from the validated results + contract and opened in a network-blocked context: actual-size renders, dimension boxes, anchor crosshairs, alpha checkerboard, sprite rows, frame strips.
9. Fix rounds against staged output only: `codex exec resume <THREAD_ID>` with the same explicit `-c` sandbox/approval config, cwd verified, per-asset findings cited by ID, output to fresh `out-r<N>/` with its own `READY-<run_id>`. Hash-compare each round against the previously accepted set — an already-approved asset changing hash is itself a finding. Cap MAX_FIX_ROUNDS=2; then each still-failing asset's declared fallback activates **in staging**.
10. The **final accepted set** (generated + activated fallbacks) is frozen in staging with hashes.

**Journaled import (not claimed atomic — Windows cannot atomically replace a nonempty directory):**
11. The contract declares a single canonical `asset_root`; every destination path must resolve beneath it, or tandem is refused at plan-lock (multi-root contracts are out of scope for v1).
12. Build the candidate tree by **seeding from the complete baseline asset zone**, then overlaying the accepted set's declared creates/replacements. Verify every undeclared file retains its baseline hash — the import can never silently remove or alter assets outside the contract.
13. **Pre-import revalidation:** immediately before the first rename, rehash the live `asset_root` against the kickoff snapshot. Abort on any undeclared change, or any declared `replace` whose baseline hash no longer matches — an externally modified live tree is never silently replaced, even if the candidate's undeclared files match the older baseline.
14. **Two-rename journal — fully specified:**
    - Journal lives OUTSIDE both trees at `<staging>/import-journal-<run_id>.json`, written atomically (temp file + rename) at every phase transition.
    - Phases: `PREPARED` (revalidation passed, candidate frozen) → `OLD_MOVED` (`asset_root` renamed to `asset_root.pre-<run_id>`; skipped with an explicit `baseline_absent: true` flag when an all-`create` contract targets a root that does not yet exist) → `NEW_ACTIVE` (candidate renamed to `asset_root`) → `CLEANED` (`.pre` backup successfully removed). **The journal is deleted only after `CLEANED`** — never while recovery artifacts remain on disk.
    - Recovery table (run at next session start or on demand; decisions verified against tree existence + hashes, not phase alone):
      | Journal phase | State found | Action |
      |---|---|---|
      | `PREPARED` | live root intact | delete candidate, delete journal — nothing happened |
      | `OLD_MOVED` | `.pre` exists, root missing | roll forward (rename candidate in) if candidate verifies, else roll back (`.pre` → root) |
      | `OLD_MOVED` + `baseline_absent` | root missing | roll forward if candidate verifies, else delete candidate + journal |
      | `NEW_ACTIVE` | root = candidate (hash-verified), `.pre` present | finish cleanup: remove `.pre`, mark `CLEANED`, delete journal |
      | `CLEANED` | journal present, `.pre` gone | delete journal |
    - The canonical-path-missing window (between the renames) exists and is stated honestly — the guarantee is *journaled and crash-recoverable*, not atomic. Imported hashes + provenance recorded in the log.

**Cross-inspection:**
15. **Codex inspects code** in a FRESH read-only session (`codex exec -s read-only`, new thread — independence over context) given the plan, base commit, ownership map, and a code-only diff. Findings go to Claude as final arbiter (accept/reject with logged reasons — Phase 2 discipline). (Claude's inspection of the assets already happened in staging, steps 7–9.)
16. **Claude is the sole serialized writer of PLAN-REVIEW-LOG.md.** Reviewer output recorded verbatim under `## Act 3 — Tandem Build` (asset-track and code-track subsections) after each process finishes.

**Proof + sign-off:**
17. Claude runs the plan's proof gates itself (tests, perf, screenshot with real assets).
18. Final human gate shows: code diff, asset contact sheet (from the QA harness), the results manifest with changed hashes, and per-asset provenance (generated round N / fallback-activated). Commit only on the user's yes.

## Invariants

- Phases 0–2: Codex performs no writes anywhere — not even probes. The Act 3 kickoff probe and asset track write only to isolated staging until the journaled import.
- The locked contract manifest is immutable; the producer emits results, never spec.
- The Phase 2 review loop is untouched.
- All loops terminate: review rounds at MAX_ROUNDS, fix rounds at MAX_FIX_ROUNDS with validated, unattended-executable fallbacks.
- Human gates: ledger confirmation, interrogation, plan sign-off, final diff+contact-sheet sign-off. None added mid-flight; no automatic commits ever.
- Windows host. **Act 3 asset-track invocations** use: prompt-file-via-stdin delivery, explicit `-c` sandbox + approval config, 10-min ceiling, process-tree kill on timeout, thread_id only from a correlated `thread.started` event. **The Phase 2 review loop's command contract is preserved verbatim** (prompt argument + `< /dev/null`, `-s read-only` / `-c sandbox_mode="read-only"`) — this invariant does not reach into it.
- Import guarantee is journaled + crash-recoverable (two-rename journal, baseline-seeded candidate tree, undeclared-file hash verification), never claimed atomic.

## AMENDMENT A — Bar pass (taste QA; adapted from the gauntlet-loop pattern) — rev 8

Rationale: the approved base gates correctness but never asks "is the output actually good?" Imported mechanic: blind comparison against a named reference bar. Adapted: cross-model + clean-context judging, locked rubric, bounded rounds.

1. **Declared at Phase 1.** Taste-surfaced deliverables get one load-bearing question: what is the bar? Bar must be **named, fetchable, comparable**. The reference is fetched, hashed, and stored as a **plan artifact in the plan store** (part of the user-approved baseline; it never dirties the working tree). At Act 3 kickoff its verified bytes are copied into **neutral judging staging**.
2. **Locked rubric at Phase 1, not free preference:** weighted criteria with minimum thresholds — task fit, contract fidelity, legibility at actual size, composition, style coherence, reference-relative quality. **PASS** = meets rubric thresholds with no material reference-relative deficit. Judges verdict against the rubric; a named reference alone is not a decision procedure (prevents imitation-seeking and judge-by-judge redefinition of "good").
3. **Judges are clean-context and repo-blind:**
   - Asset bar pass: a **fresh clean-context Claude subagent** (main-session Claude is orchestrator + arbiter — not independent). It receives ONLY the locked rubric and an anonymized composite from neutral judging staging; A/B mapping (randomized, seed recorded) and build history are withheld until its verdict is persisted.
   - UI bar pass: a fresh read-only **Codex session launched from neutral staging** containing only anonymized renders + the rubric — never from the repo (filenames/code would deanonymize the candidate).
   - Verdicts: `PASS` / `FAIL` (with gap list) / **`INVALID_COMPARISON`** — a hard setup failure (wrong crop, subject mismatch, viewport drift), never scored as a loss. **Transition policy:** one setup retry that does NOT consume `MAX_BAR_ROUNDS`; a second `INVALID_COMPARISON` terminates `NEEDS_REPLAN`.
   - **Judge-unavailable fallback:** if the clean-context Claude subagent or the Codex vision path is unavailable, the bar is marked **`UNJUDGED`**, the run terminates `DEGRADED_READY`, and the anonymized comparison is presented to the human at the final gate. The producer or orchestrator NEVER substitutes as judge.
   - **No-viable-bar branch:** a taste deliverable with no comparable reference compiles its bar condition as **`NOT_APPLICABLE`** — it neither blocks `SUCCESS` nor counts as a capped loss.
4. **Normalization locked per deliverable class:** sprites — native resolution plus integer-nearest enlarged panels, identical backgrounds, matched occupancy and animation timing; UI — identical viewport, device scale, theme, data, state, fonts, crop. Source pixels are never altered; palette is never normalized.
5. **Placement:** asset bar passes run **in staging, before final-set freeze and import** (the approved import protocol is never reopened). UI bar passes run after integrated proof, **before final cross-inspection**. Any bar-driven revision **invalidates and reruns every affected mechanical/proof/inspection gate** before the next judgment or import.
6. **Bounded, precisely:** `MAX_BAR_ROUNDS=2` = **two total judgments including the initial one** → at most one producer revision. After an initial loss, the declared fallback may serve as the revision candidate (it must pass correctness QA first, then be re-judged blind) — consuming the sole revision.
7. A capped loss is never a win — it produces the `DEGRADED_READY` terminal outcome (Amendment B) and is reported plainly at the final human gate: ship / iterate manually / lower the bar.

## AMENDMENT B — Act 3 run mode (autonomous execution loop) — rev 8

Rationale: Phase 2 already runs autonomously to termination; Act 3 as approved is conversationally orchestrated. This compiles Act 3 into a goal-driven loop with crucible's bounded-termination doctrine.

1. **Compiled at sign-off** into three immutable artifacts:
   - **Authority manifest, ENFORCED not declared:** writable roots, allowed commands, network policy, dependency-change policy, time budget, forbidden actions. Enforcement mechanism: the loop has exactly ONE action-execution step — a **policy dispatcher** that validates every action (command, cwd, canonical paths, network use, dependency changes, side effects) against the signed manifest BEFORE executing; Codex invocations additionally carry their enforceable `-c` sandbox/approval configs (mechanical enforcement), and Claude's own shell actions must pass the dispatcher's allowlist check. No action reaches execution except through the dispatcher. **Any action outside the manifest is terminal `NEEDS_REPLAN`** (state preserved, reported at the final gate); product/security/schema/scope decisions absent from the plan are never auto-arbitrated.
   - **Hard floor the manifest cannot override:** commits, pushes, releases, deployments, migrations, and outbound communications are FORBIDDEN inside Act 3 regardless of manifest contents. A manifest can only NARROW the approved base, never broaden it.
   - **Condition DAG**, dependency-driven with stable tie-break order: recovery/safety preflight → contract correctness → asset bar → import → integrated proof → UI bar → final cross-inspection → affected-gate reruns.
   - **Run state machine** (below).
2. **Terminal outcomes (win condition disaggregated):** `SUCCESS` (all gates green, bars passed) / `DEGRADED_READY` (correctness green, bar capped or fallbacks activated) / `NEEDS_REPLAN` (out-of-authority finding) / `HARD_FAILED` (probe dead, import unrecoverable, sandbox or attestation mismatch). "Won-or-capped" is abolished — completion and degraded exhaustion are distinct.
3. **Termination, proven not asserted:** every action carries a monotonic counter; all round caps are now explicitly defined — `MAX_FIX_ROUNDS=2` (base), `MAX_BAR_ROUNDS=2` (Amendment A), and **`MAX_INSPECTION_ROUNDS=2`** (initial inspection + one reinspection after accepted fixes — previously undefined); plus a global fuse `MAX_ACT3_ITERATIONS=20` and no-progress/cycle detection. **Both fuses map to a terminal outcome:** cycle/no-progress → `NEEDS_REPLAN`; global-fuse exhaustion → `NEEDS_REPLAN`, preserving the dirty diff, state, counters, and last verified artifacts for the final gate.
4. **Resumable state machine, not just logs:** state lives in one durable, exclusively-owned location — `system/runs/<run_id>/` — written atomically (temp+rename) **before and after every action**, each action under an idempotency key. **Exclusive lease:** owner ID + epoch + heartbeat + compare-and-swap takeover required before any action — a duplicated queue delivery or a live-session/headless overlap can never execute the same pending action twice. On resume, any action found `RUNNING` is reconciled (verify effects by hash/thread — complete or roll back) before proceeding. Minimum state: run ID, mode, terminal status, base/plan/contract/reference hashes, authority-manifest hash, condition table, counters/caps, current+pending action with idempotency key, Codex thread IDs, expected cwd/sandbox, process status, artifact paths+hashes, import-journal state, judge mappings/verdicts (sealed until persistence), inspection decisions, last completed transition.
5. **Cross-inspection sits INSIDE the loop as its final diagnostic gate** — after integrated proof and bar passes, so it reviews the finished state, not a moving target. It is invalidated only if the reviewed diff subsequently changes. Accepted fixes loop back through affected gates; rejections need logged reasons; out-of-authority findings → `NEEDS_REPLAN`.
6. **Telemetry, not silence:** questions are suppressed (every branch has a pre-declared answer: probe policy, fallbacks, caps, arbiter discipline); completion banners and periodic non-blocking state updates are REQUIRED. Autonomy never means invisibility.
7. **Drive modes:**
   - `run=session` (default): loop executes in the live session; Codex tracks as background tasks.
   - `run=headless`: Act 3 compiles into one self-contained prompt for the agentic-os runner queue. **Compile-time preflight attestation:** the exact headless launcher must produce an attestation — canonical roots, base/contract/reference hashes, effective permissions, CLI/model/auth fingerprints, tool availability, timeouts — that **byte-matches the signed run manifest**, else abort before launch. (The highest-risk divergence is broader inherited authority in the headless environment; the attestation is the one check that catches it.)



## Standing rejections (Round 1, accepted by reviewer in Round 2)

- Full capability-registry schema: deferred until the card exceeds ~5 entries.
- Sequential-by-default: parallel stays default under staging isolation; sequential is the degraded mode.
- Structured eligibility-rule engine: matching stays judgment-based; detection output is recorded as strategy, not fact.
