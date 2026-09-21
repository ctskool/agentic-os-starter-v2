# Morning routine — combined briefing

Adapted from the vault's morning routine. Use the attached morning-report and inbox-brief references directly; no external skill installation is required.

Run the independent trend briefing and inbox scan/qualification together when the provider supports parallel reads. Otherwise sequence them while preserving both outputs. Do not delegate work solely to bypass unavailable permission or connector access.

The trend branch performs the morning-report's 24-hour YouTube/web/X/GitHub scan. The inbox branch performs inbox-brief's scan, strict six-bucket classification and lead qualification only. Both stop at producing their reports; no email drafts, sending, labels, lead-database updates or scheduling occur automatically.

Return one unified note with frontmatter date, skill: morning, tags: [morning, brief], then:

```
# Good morning

## AI & Coding Agent Trends
<Complete morning-report sections, with links and source limitations>

## Inbox Brief (last 24h)
<Complete categorized inbox report, keeping separate numbered lead and sponsor lists>

## Proposed next actions
<Counts of leads worth pursuing and sponsor pitches worth a reply, linked to the numbered items>
```

Preserve the source sections rather than summarizing their summaries again. Avoid duplicate findings between branches. If a branch is unavailable, retain useful findings from the other branch but clearly mark the missing branch; do not claim a complete morning routine. Keep lead identity and thread references sufficient for a later explicit request while minimizing copied email content.

## Durable inbox handoff

Keep separate stable numbering for leads and sponsor pitches. After the complete categorized summary, return two named sections with valid fenced JSON arrays. Preserve the exact IDs from the authenticated source so a later request can select the same item rather than rediscovering it by subject. Use `[]` when none were found. Never fabricate a message ID, email, form answer or qualification verdict; use null for an unavailable identifier and list the missing field as a follow-up blocker.

### SPONSOR_PITCHES

```json
[
  {"number":1,"id":"<source message or thread id>","from":"<observed sender>","subject":"<observed subject>","firstName":"<verified first name or null>","messageIdHeader":"<actual RFC Message-ID header or null>"}
]
```

### LEADS

```json
[
  {"number":1,"source":"<agency or mentorship>","name":"<prospect name>","firstName":"<prospect first name or null>","email":"<prospect address parsed from submission>","formAnswers":{},"verdict":"PURSUE","rationale":"<evidence-based reason>","researchNote":"<concise observed web check or no web check>"}
]
```

`formAnswers` retains the qualification-relevant original question/answer fields; `verdict` is PURSUE, PURSUE? or PASS. Include every lead, including PASS, rather than dropping the unchosen ones. Do not replace the prospect with the form-service sender. Preserve the minimal needed handoff in the local report; this is not permission to publish private inbox data elsewhere.

## Follow-up grammar

After the unified report, include only non-empty bucket prompts:

- Leads: give the PURSUE count and offer `pursue all`, `pursue 1,3`, or `pass`.
- Sponsors: give the pitch count and offer `draft all`, `draft except 3,7`, or `skip`.

Interpret numbers against their respective saved JSON array, not a global combined list. `pursue all` selects the PURSUE leads; borderline PURSUE? entries stay identified for review. Explicit numbered choices identify those leads. `draft except 3,7` selects sponsor pitches other than those IDs. Unknown/ambiguous numbers or an undirected `all` require resolving the bucket; `pass`, `skip` or `no` makes no change to that bucket. If both arrays are empty, state “no leads or sponsor pitches today” and stop.

The initial report creates no drafts or remote mutations. For a later selected drafting request, use configured approved templates: lead outreach is a **new message** to the prospect, with a single personalized line grounded in formAnswers/researchNote (one specific business challenge or goal), verified firstName and booking link. Subjects are `Your project inquiry — next step` for agency and `Your mentorship application — next step` for mentorship. Sponsor copy is a **reply** using the actual messageIdHeader and configured media-kit link, not an unrelated thread ID. If an authenticated connector's draft API needs another identifier, resolve that mapping explicitly. Missing identifiers/templates/links stay blockers; do not invent them.

Default follow-up output can be complete local draft copy for the selected items. Creating Gmail draft records requires an explicit follow-up that requests that account action and an available authenticated capability; it is not automatically dispatched by the briefing or offered grammar. No drafting request implies sending, and the removed legacy GWS send/PDF automation is not restored. Report actual local copies or remote draft IDs and per-item failures truthfully; never call suggested copy a sent or created message.
