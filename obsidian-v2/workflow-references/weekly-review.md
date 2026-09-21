# Weekly review — personal and channel rubric

Adapted from the vault's weekly-review v1.1.0, with the more specific long-form/Shorts rules from yt-week-review. Personal evidence window: seven America/Chicago calendar days ending today, today-6 through today. The YouTube section uses the seven completed days returned by its reader, excluding today's partial day. Label these two windows separately.

## Daily evidence and aggregates

Read each available daily note without modifying it. Extract effort (1–10), focus_blocks, posts_shipped per platform, videos_shipped_today, Top 3 and Daily Drivers checkbox states, and EOD reflections. Body checkbox state wins if frontmatter disagrees. Missing notes are `no note`; null effort is `no score`, never zero.

Report effort trend and average over recorded scores; focus-block total and average with the denominator stated; shipped totals for YouTube/blog/LinkedIn/X/Instagram/TikTok; videos shipped; Top 3 completed out of 21 possible weekly slots, alongside coverage/missing-day caveats; and drivers completed out of observed driver items. Do not present absent data as measured inactivity. Fewer than three notes warrants a limited-data caveat.

Find two to four themes: blockers repeated at least three times, clustered energy changes, wins and recurring friction. Trace stalled commitments across dates and connect effort patterns to concrete shipped output.

## YouTube evidence

Call the supplied agentic_vault `youtube_review_data` tool for the configured channel. It owns the existing connection; do not inspect credential files or infer missing access from a filtered shell environment. Follow its exact date window and the attached yt-week-review rubric: weekly uploads, last ten long-form baseline, 180-second format split, medians and Hit/Steady/Miss/Climbing classifications. If that reader fails, retain the personal review and label the channel section unavailable with the specific source failure. Gmail or Calendar access is not required for this channel section.

Do not infer channel-wide period views or subscriber gains from a single current snapshot. Label available upload-view totals precisely; comparisons require comparable saved or API-provided time windows. Title/thumbnail diagnoses are hypotheses; CTR and retention need separate analytics evidence.

Keep explicit **Subs gained**, **Avg time between uploads**, and **Pacing note** rows in the channel section. Compute subscriber gains only from matching period analytics or comparable saved snapshots, otherwise show unavailable. Compute upload spacing from verified publish timestamps in the stated window/baseline, include the interval count and format scope, and give an evidence-based pacing note; fewer than two uploads means no measured interval. Do not drop these rows merely because a metric cannot be obtained.

## Result structure

Frontmatter: date, window, skill: weekly-review, tags: [review, weekly].

1. TL;DR: three to five takeaways, strongest finding first.
2. Numbers: Metric / Value / Note table with effort average, focus blocks, posts, videos, Top 3 completion, drivers completion and coverage.
3. Effort Trend: one text-chart row per day; missing notes/scores explicit.
4. Themes: two to four evidence-supported patterns.
5. What shipped; What stalled.
6. Channel — YouTube: long-form Video / Views / vs Baseline / Likes / Comments / Verdict table, baseline sample size, top performer, underperformer only when clearly established, channel-wide signal and compact short-form snapshot.
7. Recommendations for next week: three to five concrete moves combining personal and channel evidence; two or three repackaging ideas for the winner, a specific retry/reframe/stop recommendation for a mature miss.
8. Raw data: compact per-day and per-video evidence, source timestamps and gaps.
