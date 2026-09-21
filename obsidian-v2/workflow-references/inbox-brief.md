# Inbox brief — classification and qualification

Adapted from the vault's inbox-brief v1.2.0. This workflow's initial invocation is a read-only triage report. It does not create or send email, edit labels, or change templates/configuration.

## Scan

Discover the selected provider's authenticated Gmail read/search tools. Default to the last 24 hours of inbox messages, using 50-thread pages where supported and a maximum of 100 threads. State any truncation. For each thread capture latest-message subject, sender, date, snippet, message identifier, thread identifier, unread state and whether any message carries a SENT label. Read full threads when classification or lead extraction requires it. Do not infer a prior reply merely from thread length.

Use an explicitly supplied workflow configuration, or optional `system/workflow-config/inbox-brief.json`, for sender exclusions, lead fingerprints, lookback, templates and links. Do not read unrelated credential files, invent account details, or alter this configuration. Without configuration, use the defaults below and label missing sender verification.

## Exactly one category per thread, newest first

1. **Leads**, evaluated first: configured form fingerprints, including subject prefixes `New Agency Inquiry` and `New Mentorship Application`. Check configured sender restrictions. The prospect's identity is in the notification body, not its sender/recipient headers.
2. **Urgent**: concrete contract signatures, dated deadlines, security notices, affiliate-link changes or explicit calendar action items. State the action and due date.
3. **Warm threads**: an established partner or a thread the account has replied to that is pressing for a decision. New cold outreach does not qualify.
4. **Sponsor pitches**: first-touch outreach explicitly naming a brand and requesting a paid partnership, sponsored video or platform integration. Free trials, vague tool pitches, newsletters, coaches and mass blasts are excluded. Previously replied-to threads belong in Warm threads.
5. **Meetings**: accepted/declined/updated calendar notices and meeting follow-ups.
6. **Noise**: remaining newsletters, promotions, ambiguous or unrelated cold outreach. Count this bucket without reproducing every message.

When uncertain, choose the less aggressive category and explain material ambiguity.

## Lead qualification

Extract prospect name/email and form answers. Agency fields: Website, Services, Timeline, Budget, Challenge. Mentorship fields: Situation, Timeline, Biggest Challenge. Use at most two read-only web checks per lead: name plus business domain, or name plus a supplied company when using a free email address. Missing search access is `(no web check)`, not a fabricated identity check.

- Agency: a budget band of 5k–15k or above is a strong pursue signal; under-5k needs a credible business/domain and concrete challenge. Vague exploratory low-budget or personal-use requests lean PASS.
- Mentorship: a credible business/role, specific challenge and readiness to start lean PURSUE. Spam, inability-to-pay signals or generic copied answers lean PASS.
- Borderline: show PURSUE? for user review. Every lead, including PASS, stays visible; never silently discard it.

## Output

Use frontmatter date, skill: inbox-brief and tags: [inbox, brief]. Lead with `Inbox brief: N messages in the last Xh, Y unread.` Then Leads, Urgent, Warm threads pressing for reply, New sponsor pitches, Meetings, and Noise count. Number Leads and Sponsor pitches separately. Each lead row includes source, verified company/role or key form answer, verdict and one-line rationale; each sponsor row includes brand, requested platform and budget if stated. Preserve thread links/identifiers only where needed for later review.

End with reviewable proposed actions, including how many leads merit pursuit and how many pitches merit replies. If the user later explicitly requests drafts for named items, recipient identity, approved templates and missing booking/media-kit links must be resolved first; lead outreach is a new message to the prospect parsed from the body, while sponsor replies use the actual latest message identifier. That separate request never implies permission to send.

Preserve the original lead-template personalization: one specific line tied to the prospect's stated business challenge or goal, drawn from their form answers and verified research note. Substitute only observed firstName and the configured booking link; do not flatter generically or invent project knowledge. Agency subject: `Your project inquiry — next step`; mentorship subject: `Your mentorship application — next step`. Sponsor replies retain the configured template/media-kit link and actual thread identifier. If the briefing is part of the combined morning workflow, retain its numbered SPONSOR_PITCHES and LEADS handoff fields for later selection, with no automatic draft creation.
