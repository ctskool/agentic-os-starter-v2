# System

Agentic OS plumbing. The plugin, the local bridge and the skills read and write here. Not for hand-editing unless a schema doc says so.

## Contents

- **schemas/** — frozen contracts (daily-note format). Read [[daily-note]] before touching daily notes.
- **templates/** — the daily note template. Mirrors the schema exactly.
- **metrics/** — `metrics.csv` (append-only) + `last-pull.json` (per-source status snapshot).
- **bases/** — Obsidian Bases views (active projects, content pipeline), driven by frontmatter.
- **v2/** — Agentic OS V2 state, written by the local bridge: `queue/`, `processing/`, `runs/`, `logs/`, `artifacts/`, plus `profile.json` (your preferences). Never hand-edit while the services are running.
- **queue/** and **runs/** — left from earlier versions. V2 still reads old run records from `runs/`, so keep both folders.

## Pipeline

```
button or voice request → v2/queue/<id>.json → claimed into v2/processing/ → Claude or Codex runs it → v2/runs/<id>.json (status) + v2/logs/ + v2/artifacts/
```

See [[CLAUDE]] for the agent SOP. To have the system start when you log in, run `node aos.mjs autostart on` in the starter folder.
