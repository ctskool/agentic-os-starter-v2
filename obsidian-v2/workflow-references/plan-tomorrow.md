# Plan tomorrow — carryover rubric

Adapted from the vault's plan-tomorrow v1.0.0. The current execution contract controls persistence.

Compute tomorrow from today's America/Chicago calendar date. **STOP if tomorrow's note already exists** at `daily-notes/YYYY-MM-DD.md`. Report the existing path and leave it unchanged; this workflow creates a plan only when absent, it does not merge into a pre-existing tomorrow. Do not delete an existing note as a workaround. The user can review/edit it separately. The bridge checks this before dispatch and again before exclusive creation.

When absent, read today's unfinished Top 3, unfinished Daily Drivers and Notes; projects modified within seven days that are in progress or due on/before tomorrow; and existing sponsor obligations documented in the vault.

Use the selected provider's authenticated Calendar connector for tomorrow's actual recurring instances and all-day events. Paginate the date window; sort in Chicago time. If access fails, return a blocked result. A successful query with no events is a valid empty schedule.

Rank candidate priorities in this order:

1. Today's incomplete Top 3.
2. Projects due tomorrow or overdue.
3. Preparation for tomorrow's calendar commitments.
4. Documented sponsor obligations.

Choose up to three distinct, impactful commitments; leave weak slots empty. Do not carry a completed item over as unfinished. Do not edit today's note. Never overwrite or refresh an existing tomorrow's note.

Return the complete proposed note using the frozen v1 planner frontmatter, including all fields even though some are optional for generic daily-note readers:

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

Follow with `# YYYY-MM-DD`, then exact body headings in order: `## Current Focus`, `## Top 3 Priorities`, `## Schedule`, `## Daily Drivers`, `## Activity Log`, `## Notes`, `## EOD Reflection`. Include three numbered unchecked priority rows matching top3 in order. Timed events use `- HH:MM — Title`; all-day rows use `- (all-day) — Title`. Keep Schedule on empty days. Driver defaults: Skool post, YouTube recording, Inbox triage, Daily review; add only evidenced open content/sponsor commitments as unchecked drivers. Notes describes today's drift, blockers and momentum. Activity Log and EOD Reflection start empty; effort/focus counters remain null and shipping counters zero. The bridge saves the entire validated new note, not a stripped minimal skeleton.

If calendar access fails, return `BLOCKED:` plus useful proposed context with `(calendar fetch failed)` in Notes. Do not claim the unavailable calendar is empty or the proposed note was saved. V2 preserves the destination on connector failure and does not revive the retired GWS path or substitute a `PLANNED` receipt for the note.
