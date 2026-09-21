# AI Trend Scan — ranked content seeds

Adapted from the original 24-hour YouTube/X scan rubric. Use available research tools; do not assume a private helper script or another provider's tool name exists.

## Collect evidence

Read an explicitly configured source list if available; otherwise use current AI/agent-tooling topics including Claude/Anthropic, Codex/OpenAI, Gemini/Google and open models. Apply conversation overrides in memory only. Search YouTube and X concurrently when supported, usually the last 24 hours and up to five results per source. Verify publication timestamps: date-only evidence is approximate and should be labelled, not reported as exact hourly freshness.

When no configured list is available, restore the original defaults: YouTube creators **AI Explained, Matthew Berman, David Ondrej, Yannic Kilcher, Wes Roth**; YouTube topic queries **Claude Code, Codex, Anthropic, Claude 4.7, AI agents news**; X handles **@AnthropicAI, @alexalbert__, @simonw, @karpathy, @swyx**; X topic queries **Claude Code, Codex, Anthropic**. These are search seeds, not claims that a named model is current. A configured list or explicit user override wins; retain provider/topic coverage beyond these defaults where relevant.

Search both `site:x.com` and `site:twitter.com` with the handle/topic and today's date, and inspect available post content to verify dates/counters. For YouTube metadata that contains only `upload_date`, retain the original **12-hour cutoff grace** for coarse day-resolution dates, but mark the age approximate and the grace-window inclusion. It is not permission to label a 36-hour item as verified last-24-hour news or manufacture exact hourly velocity.

Record platform, title/post premise, creator, direct URL, verified publication time, views or likes/reposts, and one sentence explaining relevance. Missing counters are unknown, not invented estimates. If one source fails, return useful partial results and identify the failure; if neither works, return BLOCKED:.

## Rank, deduplicate, cluster

YouTube velocity = views / max(age hours, 1). X velocity = (likes + reposts) / max(age hours, 1). Default noise floors are 100 YouTube views/hour and 50 X engagements/hour when those measurements are available. Do not compare these different units as an objective cross-platform popularity score; use them to rank within their platform, then explain the editorial combined order.

Deduplicate exact URLs and near-identical headlines (the original title-similarity threshold was 0.78). Prefer the strongest primary source while retaining corroborating links when a reaction adds evidence. Cluster into Claude Code & Anthropic; OpenAI / Codex / GPT; Gemini / Google; Open weights & local; Agents & tooling; Other. Omit empty themes.

## Result

Return # AI Trend Scan with the top 15 seeds or fewer if evidence is sparse. Each numbered seed includes platform, linked title/premise, creator, measured engagement, age/precision, velocity when calculable, and Why this matters. Include coverage and source-status notes. Deliver raw seeds, not hooks, scripts or a silently modified source configuration.
