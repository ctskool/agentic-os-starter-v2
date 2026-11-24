---
name: yt-search
description: Search YouTube and return structured video results with metadata. Use this skill whenever the user wants to search YouTube, find videos on a topic, research what's trending on YouTube, compare YouTube videos, or look up YouTube creators/channels. Triggers on phrases like "search YouTube for", "find videos about", "what videos are there on", "YouTube results for", or any request involving YouTube video discovery or research.
---

# YouTube Search

Search YouTube through the YouTube Data API v3 and return structured, formatted results with engagement metrics.

## How to use

Run the search script. `<this skill's folder>` is the folder this SKILL.md is in.

```bash
python "<this skill's folder>/scripts/search.py" <query> [--count N] [--months N] [--days N] [--no-date-filter] [--order relevance|date|viewCount|rating] [--lang en] [--no-shorts] [--json]
```

### Parameters
- `<query>`: search terms (required)
- `--count N`: number of results to return (default: 20)
- `--months N`: only videos from the last N months (default: 6)
- `--days N`: only videos from the last N days (overrides `--months`)
- `--no-date-filter`: include videos of any age
- `--order`: `relevance` (default), `date`, `viewCount` or `rating`
- `--lang en`: prefer results in that language (a ranking hint, not a hard filter)
- `--no-shorts`: drop videos of 3 minutes or less
- `--json`: print JSON (adds title length, age in days, channel ID and thumbnail URL)

### Examples

```bash
# Basic search (top 20, last 6 months)
python "<this skill's folder>/scripts/search.py" claude code tutorial

# Fewer results, shorter window
python "<this skill's folder>/scripts/search.py" obsidian workflow --count 5 --months 3

# Competitor collision scan: what's hot on a topic in the last 14 days
python "<this skill's folder>/scripts/search.py" claude code projects --days 14 --count 15 --order viewCount --lang en --no-shorts

# All time, no date filter
python "<this skill's folder>/scripts/search.py" AI agents --count 10 --no-date-filter
```

## Output format

Each result includes:
- Title
- Channel name and subscriber count
- View count
- Duration
- Upload date
- Engagement ratio (views / subscribers): higher means the video outperformed the channel's usual audience
- Direct URL

Results are separated by dividers for easy scanning. Status messages go to stderr; the formatted results go to stdout.

## Exit codes and failures

The script fails loudly. It never prints an empty result and exits 0.

- `0`: results printed
- `1`: setup or API error (missing `YOUTUBE_API_KEY`, HTTP error, quota exhausted). Report it; don't fall back to guessing.
- `2`: bad arguments
- `3`: the API really returned no videos. Broaden the query or the window and retry.

## Notes

- Needs `YOUTUBE_API_KEY` in the environment or `~/.claude/.env`, the same key the dashboard's YouTube workflows use.
- Quota: each search page (up to 50 results) costs 100 units; the stats lookups cost about 2 more. The default daily quota is 10,000 units, shared with the other YouTube skills.
- Public view counts include every view from the first frame since 2026-08-24. Ratios for older videos used the stricter count, so they read a little lower.
