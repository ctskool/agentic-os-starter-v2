> Current V2 direction: two provider palettes share the same dashboard layout. Claude uses the warm ember core; Codex uses a cool monochrome four-arm galaxy, extended stars and restrained platform accent colors. Weekly-only gauges and a compact workflow deck serve quick reading; Agent work exposes real persistent conversations. Decorative galaxy motion is ambient artwork, not measured telemetry. The original single-provider design notes below apply to Claude styling only. Runtime behavior and current limits are documented in [README](README.md).

# Design

## Visual Theme

Nocturnal reactor-control. Near-black warm field, one luminous 3D core (Three.js + UnrealBloom), open composition with no panel boxes: text floats on edge scrims, separated by hairlines. Color strategy: Committed — the ember spectrum carries the whole surface.

## Colors

- `--bg` oklch(0.12 0.008 45) — warm near-black, never #000
- `--ink` oklch(0.88 0.025 65) — warm parchment text
- `--ink-dim` oklch(0.60 0.02 55)
- `--ink-faint` oklch(0.42 0.015 50)
- `--ember` oklch(0.67 0.13 40) — brand terracotta (#d97757 lineage)
- `--ember-hot` oklch(0.76 0.15 55) — highlights, deltas
- `--white-hot` oklch(0.95 0.04 80) — peak values, wordmark
- `--cobalt` oklch(0.62 0.17 265) — listening state ONLY
- `--err` oklch(0.62 0.22 30), `--warn` oklch(0.78 0.13 80)
- Hairlines: ember at 15–25% alpha. No solid borders thicker than 1px.

## Typography

- Display: **Big Shoulders** (variable) — condensed industrial; clock, metric values, MRR. Weight 300–700, tabular feel via tight tracking.
- Data/labels: **Martian Mono** (variable) — wide technical mono; 8–10px uppercase labels tracked +0.2em, telemetry log, deltas.
- Scale ratio ≥1.4 between label → value → hero tiers. Labels tiny, values huge; no middle mush.

## Components

- **Section heading**: mono 9px ember uppercase + trailing hairline. No box.
- **Vital row**: label over Big Shoulders value + mono delta, sparkline beneath, hairline separator.
- **Deck button**: full-width text row, leading dot, hover = ember background tint (8%) + white-hot text. No border boxes.
- **Mode chips**: text + dot, color-coded per core mode, always carrying a text label.
- **Progress**: 2px hairline track with gradient fill, no rounded pill.

## Layout

Fullscreen stage. 320px left rail (vitals, telemetry), 320px right rail (pipeline, deck, diagnostics), giant clock top-right, wordmark top-left, hero MRR bottom-center. Edge scrim gradients guarantee legibility over the core; center stays empty for the 3D scene.

## Motion

- Boot: one orchestrated staggered reveal (opacity + 12px rise + blur clear), ease-out-quint, 0.05–1.0s delays. Runs once.
- State changes: 150–250ms; palette lerps in the shader, not CSS.
- Core: continuous slow rotation, Kepler ring shear, mouse parallax. Error mode strobes the core, not the text.
- `prefers-reduced-motion`: animations collapse to instant.
