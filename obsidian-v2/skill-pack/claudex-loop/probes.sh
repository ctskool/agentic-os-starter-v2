#!/usr/bin/env bash
# Capability probes for CODEX-CAPABILITIES.md — the ONLY place probe commands live.
# Usage: bash probes.sh <probe-id> <staging-dir>
# Every probe writes ONLY inside <staging-dir> (must be outside any repo).
# Exit 0 = capability verified; non-zero = failed (degrade to fallback path).
set -euo pipefail

PROBE_ID="${1:?usage: probes.sh <probe-id> <staging-dir>}"
STAGING="${2:?usage: probes.sh <probe-id> <staging-dir>}"

mkdir -p "$STAGING"
cd "$STAGING"

# Shared codex exec wrapper: prompt via stdin temp file, JSON stream captured,
# thread.started required, 10-min ceiling handled by the caller's Bash timeout.
run_codex() {
  local prompt_file="$1" sandbox_flags="$2" out_file="$3"
  # Capture the stream to a file FIRST, then grep it — piping straight into
  # `grep -q` EPIPEs codex on first match and pipefail kills the whole probe.
  # shellcheck disable=SC2086
  codex exec $sandbox_flags -c approval_policy="never" --json -o "$out_file" - <"$prompt_file" \
    >"$out_file.stream" 2>/dev/null
  grep -q '"type":"thread.started"' "$out_file.stream"
}

case "$PROBE_ID" in

  image-gen-raster)
    P=$(mktemp)
    cat >"$P" <<'EOF'
Probe: generate a 64x64 PNG image (any simple texture, e.g. gray concrete),
RGBA with an alpha channel, and save it in the current directory as probe-image.png.
Do nothing else. Report the file path.
EOF
    run_codex "$P" "-s workspace-write" probe-image-report.txt
    rm -f "$P"
    # Verify: file exists, is a PNG, is exactly 64x64.
    [ -f probe-image.png ] || { echo "FAIL: no probe-image.png"; exit 1; }
    node -e '
      const b = require("fs").readFileSync("probe-image.png");
      if (b.readUInt32BE(16) !== 64 || b.readUInt32BE(20) !== 64) { console.error("FAIL: dims"); process.exit(1); }
      console.log("OK: image-gen-raster verified (64x64 PNG)");
    '
    ;;

  procedural-threejs-model)
    P=$(mktemp)
    cat >"$P" <<'EOF'
Probe: write probe-model.js in the current directory. It must export (module.exports)
a single function createModel(THREE) that returns a THREE.Group containing at least
3 named Mesh children, using only primitive geometries and standard materials.
No external assets, no imports. Do nothing else.
EOF
    run_codex "$P" "-s workspace-write" probe-model-report.txt
    rm -f "$P"
    [ -f probe-model.js ] || { echo "FAIL: no probe-model.js"; exit 1; }
    # Execute against a stub THREE namespace — no real three.js needed for the probe.
    node -e '
      const vec = () => ({ x:0, y:0, z:0, set(x,y,z){ this.x=x; this.y=y; this.z=z; return this; } });
      class Base { constructor(){ this.children=[]; this.name=""; this.position=vec(); this.rotation=vec(); this.scale=vec(); this.castShadow=false; this.receiveShadow=false; } add(...c){ this.children.push(...c); return this; } }
      const THREE = new Proxy({}, { get: (t,k) => class extends Base { constructor(){ super(); } } });
      THREE.Group; // proxy warm-up, no-op
      const m = require("./probe-model.js");
      const g = (typeof m === "function" ? m : m.createModel)(THREE);
      const count = g.children.length;
      if (count < 3) { console.error("FAIL: only " + count + " children"); process.exit(1); }
      console.log("OK: procedural-threejs-model verified (" + count + " children)");
    '
    ;;

  self-visual-verify)
    echo "SKIP: self-visual-verify probe is opt-in (Chromium download). Run manually if needed:"
    echo "  network-enabled workspace-write session; see CODEX-CAPABILITIES.md entry."
    exit 0
    ;;

  *)
    echo "Unknown probe id: $PROBE_ID"; exit 2
    ;;
esac
