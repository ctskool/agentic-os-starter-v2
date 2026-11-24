# Codex Capability Card

Registry of Codex's differentiated capabilities — things Codex can do that Claude cannot (or does markedly worse). Phase 0 RECON scans the task's **deliverables** against each entry's fires-when conditions; a hit is recorded in the Assumptions Ledger as a **proposed build strategy** (never a fact) and unlocks the tandem option at the Resolution gate.

Rules of the card:
- Entries carry named **probe IDs** implemented in `probes.sh` — this file NEVER contains executable shell strings.
- A verification is trusted only while its **environment fingerprint** matches (codex-cli version + configured model + auth account). Any component change → status degrades to `matched, unverified` and the probe must re-run before a build bets on it. 90-day expiry is a secondary guard.
- Phase 0 may run **non-writing** checks only (`codex --version`, config read). Writing probes run at Act 3 kickoff, in isolated staging, after the user selects tandem.
- Scope entries to what is *actually verified*. Do not generalize (raster ≠ vector; session-mode ≠ IDE-mode).

---

## image-gen-raster

- **What:** Native image-generation tool in `codex exec` sessions (ChatGPT-account backed, no API key). Generates raster PNGs to disk, headless. Verified to exact pixel dimensions and seamless tileability (0 opposing-edge mismatches on a 64×64 tile, self-verified with a 4×4 tiling proof).
- **Fires when:** plan's deliverables include raster art — sprites, icons, textures, UI chrome, hero images, decals, skybox faces (PNG).
- **Limitations / policy:** raster only (vector/SVG NOT claimed — would be a separate entry with its own probe). No trademarked/branded imagery. Style consistency across a large set needs explicit style descriptors per asset in the contract.
- **Probe ID:** `image-gen-raster` (generates one 64×64 test PNG in staging, checks dims + alpha channel)
- **Last verified:** 2026-08-16 — fingerprint: codex-cli 0.144.5 / gpt-5.6-sol / ChatGPT-account auth

## procedural-threejs-model

- **What:** Writes self-contained procedural three.js model modules (function returning a `THREE.Group`; no external assets). Verified: 17-mesh low-poly pistol, syntax-valid, executed clean against a three.js namespace in Node.
- **Fires when:** plan's deliverables include low-poly 3D props/models buildable as procedural geometry (weapons, targets, furniture, simple vehicles — NOT organic/character meshes).
- **Limitations / policy:** code-shaped deliverable — contract must specify the module interface (export signature, mesh-count range, bounding dims, three.js version). QA is execution-based (Node) + visual (render). Not for rigged/animated character meshes.
- **Probe ID:** `procedural-threejs-model` (writes + Node-executes a minimal Group factory against a stub namespace)
- **Last verified:** 2026-08-16 — fingerprint: codex-cli 0.144.5 / gpt-5.6-sol / ChatGPT-account auth

## self-visual-verify

- **What:** Given a **network-enabled** workspace-write sandbox, Codex bootstraps its own render verification: npm-installs Puppeteer + Chromium locally, serves its scene, screenshots with real WebGL (verified via ANGLE/D3D11 on host GPU), and inspects its own screenshot with its image tool. Verified end-to-end (pistol render described accurately by its author).
- **Fires when:** the asset track includes 3D/model work whose output should be self-checked before handoff (reduces Claude-side fix rounds; Claude's independent visual pass remains — judge ≠ producer).
- **Limitations / policy:** REQUIRES `sandbox_workspace_write.network_access=true` — a declared authority decision, since it permits arbitrary npm installs inside staging. First-run cost: ~1-2 min Chromium download. Known friction: global npm caches unwritable in sandbox → instruct local cache redirect (`npm_config_cache=./.npm-cache`) in the launch template.
- **Probe ID:** `self-visual-verify` (skipped by default — expensive; the capability degrades gracefully: without it, Codex hands off unrendered and Claude's visual QA catches everything)
- **Last verified:** 2026-08-16 — fingerprint: codex-cli 0.144.5 / gpt-5.6-sol / ChatGPT-account auth

---

## Not claimed (explicitly)

- **Vector/SVG generation** — never probed.
- **Direct GLB/mesh-file generation** — Higgsfield MCP is registered inside Codex sessions and its 3D catalog responds, but end-to-end image→GLB was not verified (media upload stalls headless). Procedural modules + self-render supersede the need.
- **Audio generation** — never probed.
- **Blender / external DCC tools** — IDE/desktop Codex territory; not available in headless `codex exec` on this machine.

Adding an entry: verify the capability with a real probe first, record the fingerprint, implement the probe in `probes.sh`, then add the entry. Revisit the card structure if it exceeds ~5 entries (see TANDEM-DESIGN.md standing rejections).
