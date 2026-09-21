# Shared YouTube research connection

For YouTube discovery and public metadata, use the supplied agentic_vault `youtube_research_data` tool. It uses the existing local API connection internally for both providers. A filtered shell environment is not evidence that the connection is missing. Never inspect credential files or put keys in commands, prompts or reports. This source does not require Gmail or Calendar access.

- `operation: search` with `query`, optional `publishedAfter`, `order` (date, viewCount or relevance), and `maxResults` (1–50) finds candidate videos and enriches their metadata. Search is not an exhaustive scan; verify exact publication dates and relevance in the returned videos.
- `operation: videos` with `videoIds` (at most 50 observed IDs) reads video counters, durations and live status.
- `operation: channels` with `channelIds` (at most 50 observed IDs) reads public subscriber counts and channel identity. Hidden subscriber counts remain unavailable; visible counts may be rounded.
- `operation: channel_uploads` with one observed `channelId` and `maxResults` (up to 50) reads that channel's recent uploads for an outlier baseline. Exclude the candidate, live videos and ineligible durations according to the Outlier Radar rubric; state the resulting eligible sample size. Respect any coverage limit rather than claiming the whole channel was scanned.

Batch known IDs and reuse already collected metadata within the report. Use fresh, verifiable cached research when the workflow permits it. Preserve the workflow's topic, date window, configured source lists and scoring rules. A failed or quota-limited source is unavailable, not zero results. Missing counts remain unknown. Public lifetime counters do not establish channel-wide period growth, click-through rates or retention.

This tool provides metadata, not transcripts. Video-content analysis still requires actual captions, an installed transcript reader, or an authenticated existing NotebookLM source. Never substitute a title or description for the video's content. Own-channel weekly reviews use `youtube_review_data` instead.
