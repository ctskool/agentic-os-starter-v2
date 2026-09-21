// V1 workflow content adapted for either provider. Persistence belongs to the caller.
import {TIME_ZONE} from '../shared/timezone.mjs';
const todayDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:TIME_ZONE}).format(new Date());
const tomorrowDate=()=>{const [y,m,d]=todayDate().split('-').map(Number);return new Date(Date.UTC(y,m-1,d+1)).toISOString().slice(0,10)};
const slugify=s=>String(s||'request').toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,48);
export function deliverablePathFor(intent) {
  const id8 = (intent.id || "x").slice(0, 8);
  const date = todayDate();
  const args = intent.args || {};
  switch (intent.skill) {
    case "plan-today":
    case "refresh-schedule":
      return `daily-notes/${date}.md`;
    case "plan-tomorrow":
      return `daily-notes/${tomorrowDate()}.md`;
    case "morning":
      return `inbox/reports/morning/${date}-${id8}.md`;
    case "morning-report":
      return `inbox/reports/morning/${date}-morning-report-${id8}.md`;
    case "inbox-brief":
      return `inbox/reports/inbox-briefs/${date}-${id8}.md`;
    case "deep-research-chase":
      return `inbox/research/${date}-${slugify(args.topic)}.md`;
    case "content-cascade":
      return `inbox/reports/cascades/${date}-${id8}.md`;
    case "weekly-review":
      return `inbox/reports/weekly/${date}-weekly-review.md`;
    case "yt-pipeline":
      return `inbox/research/${date}-yt-pipeline-${slugify(args.topic)}.md`;
    case "vault-cleanup":
      return `inbox/reports/vault-cleanup/${date}-cleanup-${id8}.md`;
    case "metrics-pull":
      return `inbox/reports/metrics/${date}-pull-${id8}.md`;
    case "yt-week-review":
      return `inbox/reports/yt-reviews/${date}-yt-week-review.md`;
    case "github-trending":
      return `inbox/research/github-trending/${date}-trending.md`;
    case "ai-trend-scan":
      return `inbox/reports/trend-scan/${date}-trend-scan-${id8}.md`;
    case "morning-intel":
      // converged 2026-08-14: interactive /morning-intel writes here natively;
      // the runner now matches (was inbox/reports/morning/) so the voice
      // "open morning intel" target and the briefing reader have ONE home
      return `inbox/research/morning-intel/${date}-intel-${id8}.md`;
    case "outlier-radar":
      return `inbox/research/outlier-radar/${date}-outliers.md`;
    case "lead-research":
      return `inbox/reports/lead-research/${date}-leads-${id8}.md`;
    case "voice-ask":
      return `inbox/voice/${date}-${slugify(args.prompt || "ask")}-${id8}.md`;
    case "angle-brainstorm":
      return `inbox/reports/angles/${date}-angles-${slugify(args.seed || args.topic || id8)}.md`;
    case "outline-build":
      return `inbox/reports/outlines/${date}-outline-${slugify(args.angle || args.topic || id8)}.md`;
    default:
      return null;
  }
}

// Keep content requirements separate from transport-specific output contracts.
// The worker returns the deliverable; neither this layer nor its references tell
// a model to write the bridge-owned destination or substitute a save receipt.
export function originalPrompt(intent) {
  const args = intent.args || {};
  switch (intent.skill) {
    case 'plan-today':
      return "Propose today's complete daily note using the attached planning rubric and the vault's daily-note schema. Read the last three daily notes, recent active/due projects, and today's authenticated calendar. Preserve existing user priorities and checked items. The bridge applies only the schedule and empty priority slots.";
    case 'refresh-schedule':
      return "Return today's complete daily note with a refreshed ## Schedule using the authenticated calendar in "+TIME_ZONE+". Sort timed events in 24-hour format; label all-day events. Retain the current note's other content exactly. A confirmed empty calendar is an empty schedule; unavailable access is blocked, not an empty calendar.";
    case 'plan-tomorrow':
      return "Create tomorrow's complete daily note only when absent, using the attached frozen-schema rubric: unfinished work, due projects, documented commitments, and tomorrow's authenticated calendar. STOP if tomorrow's note already exists; leave it unchanged and report its path. Return the complete new note for the bridge to validate and save; do not merge, overwrite or delete an existing note.";
    case 'morning':
      return 'Produce one consolidated morning briefing from the attached Morning Report and Inbox Brief rubrics. Research the trends and read-only inbox triage concurrently when supported; combine the complete results and number proposed follow-up actions.';
    case 'morning-report':
      return 'Produce the complete current AI and agent-building morning report using the attached 24-hour source and output rubric.';
    case 'inbox-brief':
      return 'Read and triage the last 24 hours of the authenticated inbox using the attached categories, lead scoring, and report rubric. Return the triage and suggested actions; do not create drafts or send messages in this initial run.';
    case 'deep-research-chase':
      return args.topic?.trim() ? `Research this topic across YouTube, web, X and GitHub using the attached research rubrics: ${JSON.stringify(args.topic)}. Return the full cited synthesis, selected sources, disagreements and content opportunities. Read existing NotebookLM sources or available transcripts; creating a remote notebook is a separate explicitly requested follow-up.` : null;
    case 'content-cascade':
      return args.url?.trim() ? `Obtain the actual transcript for ${JSON.stringify(args.url)} and produce the complete blog draft, X post and reply, LinkedIn post and first comment using the attached editorial rubric. Return all draft copy and metadata in one complete Markdown bundle. If all transcript methods fail, return BLOCKED: with the source failure. Publishing, scheduling and database mutations are outside this initial workflow.` : null;
    case 'weekly-review':
      return 'Review the last seven Chicago calendar days of daily notes and the YouTube channel using the attached personal-review and channel-review rubrics. Distinguish missing data from zero. Return the complete review with evidence, themes and practical recommendations.';
    case 'yt-week-review':
      return 'Review the channel uploads from the seven completed '+TIME_ZONE+' calendar days against the last ten long-form uploads using the attached YouTube weekly rubric. Call the supplied agentic_vault youtube_review_data tool first: it owns the configured read-only connection and returns the source data without credentials. Do not require Calendar or Gmail, inspect credential files, or assume YouTube is unavailable because shell environment variables are filtered. Preserve the required dashboard headings and short performer explanations.';
    case 'yt-pipeline':
      return args.topic?.trim() ? `Find and select the strongest YouTube sources for ${JSON.stringify(args.topic)} and analyze their actual transcripts or existing NotebookLM source content using the attached rubric. Return the complete research report locally. Remote notebook creation, source uploads and generated remote artifacts require a separate explicitly requested follow-up.` : null;
    case 'vault-cleanup':
      return 'Inspect eligible stale files and return a reviewable cleanup manifest using the attached rubric. This initial run is preview-only: do not move, rename or delete any source file. List proposed source/destination paths, age, reason, linked assets and skipped-file reasons. Stop after the preview so the user can select moves in a follow-up.';
    case 'metrics-pull':
      return 'The deterministic metrics integration owns execution. Return its actual per-source statuses and available before/after values; never replace it with a model-generated estimate.';
    case 'github-trending':
      return 'The deterministic GitHub integration owns execution and its dated snapshot. Return its actual complete report.';
    case 'ai-trend-scan':
      return 'Scan current YouTube and X AI trends using the attached velocity, deduplication and clustering rubric. Return the ranked seed list; leave angle selection and outlines for their own workflows.';
    case 'morning-intel':
      return 'Produce the full AI intelligence brief from current news, Hacker News, YouTube, small-channel outliers, GitHub and read-only inbox triage. Follow the attached source/status and content-plan rubrics; include useful partial findings and identify each unavailable source.';
    case 'outlier-radar':
      return 'Find recent small-channel AI YouTube outliers using the attached eligibility, lifetime-baseline and early-velocity rubric. Return the complete dated report with evidence, source coverage and comparisons to existing reports when available.';
    case 'lead-research':
      return 'Read available authorized lead records and research them using the attached pre-call rubric. Return the complete briefing per lead. If lead connectivity is unavailable return BLOCKED:. This initial run does not update remote lead records.';
    case 'angle-brainstorm':
      return args.topic?.trim() ? `Develop 8–12 distinct YouTube angles for ${JSON.stringify(args.topic)} using the attached framing and audience-desire rubric. Return the complete angles with a desire tag and evidence-based justification for each.` : null;
    case 'outline-build':
      return args.topic?.trim() ? `Develop the chosen angle ${JSON.stringify(args.topic)} into a complete retention-aware YouTube outline using the attached rubric: working title, hook, stakes, body beats, re-hooks, payoff/demo, CTA, runtime and per-beat visual notes.` : null;
    case 'voice-ask':
      return args.prompt?.trim() ? `Complete this transcribed voice request: ${JSON.stringify(args.prompt)}. Use recent conversation only as context: ${JSON.stringify(args.context || '')}. Return the full result, evidence and useful source links. Do not invent a completed action or a destination URL. The voice reply is summarized separately from this full artifact.` : null;
    default:
      return null;
  }
}
