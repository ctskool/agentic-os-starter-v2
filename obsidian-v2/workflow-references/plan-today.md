# Plan today — planning rubric

Adapted from the vault's plan-today v1.1.0. The current execution contract controls persistence; this reference defines the plan's content.

## Evidence to read

Use America/Chicago to determine today. Read the last three available daily notes: unfinished Top 3, unfinished Daily Drivers, and EOD reflections. Read today's existing note, and projects modified within 14 days with active, in-progress, blocked or draft status, or due dates on/before today. Use the selected provider's authenticated Calendar connector for today's instances, including all-day and recurring events; paginate as needed. A connector failure is different from a verified empty calendar and must be reported as blocked.

## Ranked Top 3

Add these original rubric signals per candidate, then rank:

| Signal | Score |
| --- | ---: |
| Yesterday's incomplete Top 3 | +50 |
| Project due today | +40 |
| Overdue project | +30 |
| Calendar commitment requiring preparation | +25 |
| Repeated theme in the last three EOD reflections | +20 |
| Unfinished Top 3 from two or three days ago | +15 |

Select up to three distinct, high-impact candidates. Preserve user-set priorities and their checked state; suggest additions only for empty slots, avoiding duplicate themes. One strong suggestion is better than filling three slots with weak guesses. With sparse history, use what exists and state the gap.

## Daily-note format

Respect the frozen v1 `system/schemas/daily-note.md` contract. A newly created note includes every field in this planner template; do not reduce it to date/schema alone. Keep three parallel priority strings/unchecked flags, using empty strings for unused slots:

```yaml
---
date: YYYY-MM-DD
schema_version: 1
focus: ""
top3:
  - "<suggestion 1 or empty>"
  - "<suggestion 2 or empty>"
  - "<suggestion 3 or empty>"
top3_done: [false, false, false]
effort: null
focus_blocks: null
posts_shipped:
  youtube: 0
  blog: 0
  linkedin: 0
  x: 0
  instagram: 0
  tiktok: 0
videos_shipped_today: 0
---
```

Follow with `# YYYY-MM-DD`, then the exact fixed body headings: `## Current Focus`, `## Top 3 Priorities`, `## Schedule`, `## Daily Drivers`, `## Activity Log`, `## Notes`, `## EOD Reflection`. The three numbered `1. [ ] text` priority rows must match frontmatter top3 in order, and nothing is marked complete by the planner. Calendar rows use `- HH:MM — Title` in sorted 24-hour Chicago time; all-day rows use `- (all-day) — Title`. Keep Schedule even when verified empty. New Activity Log and EOD Reflection are empty. Existing frontmatter progress/shipping counters remain untouched.

Default new-note drivers are Skool post, YouTube recording, Inbox triage and Daily review. Add unchecked conditional drivers supported by actual source notes: pending sponsor reply in `drafts/awaiting/`, review/ship an existing cascade draft, or upload/schedule a recorded but unuploaded video. Include the source note in the wording where useful; do not invent an obligation or claim it was performed. New Notes contains one paragraph connecting recent EOD themes, blockers and overdue work. The bridge preserves this complete validated new-note content.

For an existing note, the bridge merges only Schedule and empty Top 3 slots; existing drivers, reflections, frontmatter and Notes remain user-owned. Retain proposed extra drivers and a `### Plan Today refresh HH:MM` note under Notes in the complete artifact for review, without implying those additional suggestions were merged. This preserves the original refresh context while keeping the current guarded merge boundary explicit.

If the Calendar connector fails, start the result with `BLOCKED:` and include `(calendar fetch failed)` in the proposed Notes/context. Preserve useful planning evidence, but do not represent the failed read as an empty calendar or claim a note was saved. V2 intentionally leaves the destination unchanged on connector failure; it does not revive the retired GWS fallback or use the original `PLANNED` receipt instead of a full deliverable.
