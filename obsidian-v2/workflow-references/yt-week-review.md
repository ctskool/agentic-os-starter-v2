# YouTube weekly review — scoring and format

Adapted from the vault's yt-week-review v1.0.0. Analyze the seven completed America/Chicago calendar days, excluding today's partial day. First call the supplied agentic_vault `youtube_review_data` tool; it returns the exact window, configured channel, weekly uploads and ten-long-form comparison data. This trusted read-only tool uses the existing connection without exposing credentials. Shell environment filtering does not mean the YouTube connection is absent. Never inspect credential files or include keys in commands, reports or prompts. This channel review does not need Gmail or Calendar; do not probe those connectors or block on their scopes. If the YouTube tool itself cannot return channel data, identify its specific source error rather than fabricate analytics. Respect coverage warnings and unavailable fields in the returned snapshot.

## Collection and segmentation

For a configured channel beginning UC, its uploads-playlist identifier uses UU with the remaining suffix. Page the uploads playlist until the weekly window and baseline candidates are covered. Fetch statistics, contentDetails and snippet for selected IDs, batching up to 50 where supported. Retain title, URL, publication timestamp, views, likes, comments and ISO-8601 duration.

Parse durations into seconds. For this dashboard's editorial convention, Short-form is <=180 seconds and Long-form is >180 seconds. This is an analysis bucket, not proof of YouTube's actual format classification. The main upload table, baseline and outlier analysis use long-form only. Fetch enough history for ten long-form uploads where available; otherwise report the smaller sample.

## Baseline and verdicts

- baseline_views: median views of the ten most recent long-form uploads.
- baseline_likes: median likes of those uploads.
- baseline_engagement: median per-video (likes + comments) / views, omitting zero-view denominators.
- views_pct_of_baseline: weekly upload views / baseline_views ×100. With a zero or unavailable baseline, report unavailable instead of dividing or inventing a verdict.
- **Climbing**: less than 24 hours old; this takes precedence over settled verdicts.
- **Hit**: at least 150% of baseline.
- **Steady**: at least 60% and below 150%.
- **Miss**: below 60%, only after the initial 24 hours.

Top performer is highest absolute long-form views in the window. Propose two or three specific repackaging ideas. Only label an underperformer when it is a mature Miss; offer one or two diagnostic questions and one concrete move. Title/thumbnail/topic/timing explanations are hypotheses, not measured CTR or retention.

## Result structure

Frontmatter: date, window, channel, skill: yt-week-review, tags: [review, youtube, weekly].

- TL;DR: three or four bullets.
- Uploads this week: Video | Views | vs Baseline | Likes | Comments | Verdict. Include baseline medians and sample size below it.
- Top performer — title: `Why it worked (best guess)` must be one sentence under 140 characters; then Repackaging plays.
- Underperformer — title, if any: `Likely culprit` must be one sentence under 140 characters; then Move: retry/reframe/stop, with rationale.
- Channel-wide signal: distinguish lifetime views of this week's uploads from period channel views. Only show prior-week comparisons, subscriber gains or upload pacing when supported by comparable data. Public subscriber values may be rounded; do not invent precision.
- Short-form snapshot: one line with count, combined views and a brief verdict.
- Recommended next 7 days: three concrete next moves.

No claims about CTR, watch time or retention without actual authorized analytics data. No uploads, metadata edits or publishing occur in this review.
