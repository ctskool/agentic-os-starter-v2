# Outlier Radar — small-channel evidence

Adapted from the original outlier-radar eligibility and scoring rules. Read existing configured seeds/watchlists and previous reports when available, then use authenticated YouTube metadata tools or the configured API. Do not assume a private scanning script or scheduled task ran, and do not change watchlists or seen-item state in this report workflow.

## Eligible videos and baselines

Look at the last seven days of AI/agent-building uploads from channels with 200–100,000 subscribers. Exclude live videos and durations of 180 seconds or less; require at least 500 views. Report subscriber counts as returned, including rounding. Seek diverse channels using topic searches and any configured watchlist (original cap 75). Compare prior reports over 30 days to label already-seen findings.

For each candidate, collect a comparable recent channel baseline from up to 50 uploads, excluding the candidate and ineligible live/short-form items. Reuse verifiable metadata no older than 24 hours where available. Main multiplier = candidate lifetime views / median lifetime views of the eligible recent baseline. A main outlier is at least 1.5×. Report sample size and avoid a confident multiplier for a missing, zero or inadequate baseline.

Early detection for a video under 48 hours old can flag at least 10× relative views-per-hour, but this is a secondary velocity signal. Young videos front-load views, so it is not interchangeable with the lifetime multiplier. Never substitute views/subscribers for this channel-baseline method.

## Result

Return a dated report with linked title, channel/subscribers, upload time/age, duration, views, lifetime multiplier, optional early velocity, baseline size, and discovery method. Explain what the topic suggests without treating correlation as proof that the topic caused performance. Separate main outliers from young velocity candidates and previously seen items. State query coverage, missing API access/quota, stale data and confidence. A verified zero-result scan is “no new outliers”; an unavailable source is not zero. The bridge stores the complete report.
