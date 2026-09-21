---
name: angle-brainstorm
description: Take a seed (URL, news headline, sentence-long topic, or output from the ai-trend-scan skill) and return 8-12 genuinely distinct YouTube video angles for it, each from a different framing bucket (contrarian / how-to / story / listicle / news-reaction / explainer / behind-the-scenes / prediction) with the audience desire it hits and a one-line "why this lands" justification. Use whenever the user says "brainstorm angles", "give me angles for", "video angles for", "angle brainstorm", "what angles can I take on", "ways to cover this", "different ways to cover X", "/angle-brainstorm", or invokes the angle step of the content pipeline. Also trigger when the user has just run ai-trend-scan and picked a seed, when they paste a news URL and ask how to cover it, or when they're stuck on "I have the topic but don't know what kind of video to make" — even if they don't use the word "angle" explicitly. This is the second stage of the content pipeline: ai-trend-scan → angle-brainstorm → outline-build → yt-hooks → yt-titles.
---

# angle-brainstorm

Take a single seed (one URL, one headline, one sentence, or one item picked from `ai-trend-scan`) and return 8-12 genuinely different video angles, each from a different framing bucket. The goal is to give the user shape diversity, not minor rewordings — they should be able to look at the list and pick a true direction, not pick a synonym.

## Why this exists

A seed is not a video. "Anthropic shipped sub-agents" is a topic; "Why Anthropic's sub-agents quietly kill the orchestrator pattern" is an angle. Most creators skip this step and default to the first angle that pops into their head — usually a how-to or a news-reaction — and end up making the same video everyone else makes off the same seed.

This skill forces breadth. For every seed it generates angles across the framing space so the user can see, in one glance, what's available. The user picks one, then feeds it into `outline-build` to make the actual structure.

It also pre-tags each angle with the audience desire it hits, because the creator's audience (Claude Code / agentic-AI viewers) responds to certain desires more reliably than others — mastery and FOMO win; status and curiosity are close behind; pure aspiration and belonging are weaker for this niche. Surfacing the desire upfront makes the pick easier.

## When this skill activates

Trigger phrases (case-insensitive, partial matches OK):
- "brainstorm angles" / "angle brainstorm"
- "give me angles for [seed]"
- "video angles for [seed]"
- "what angles can I take on [seed]"
- "ways to cover this" / "different ways to cover X"
- "how should I frame this video"
- `/angle-brainstorm`

Also trigger when the user has just run `ai-trend-scan` and points at one of the seeds ("let's go with #3"), or pastes a single news URL and asks "what kind of video should I make from this".

Do NOT trigger when:
- The user wants hooks or opening lines → that's `yt-hooks`
- The user wants title options → that's `yt-titles`
- The user wants a full outline → that's `outline-build`
- The user wants to brainstorm TOPICS (i.e. they don't have a seed yet) → that's `ai-trend-scan`

The mental model: this skill answers "given this seed, what video could I make?" — not "what topic should I pick?" and not "how does the video open?".

## Input

The user provides a **seed** in one of four shapes:

1. **URL** — usually a news article, X post, YouTube video, or blog post. Read it (use WebFetch) before generating angles so you understand what actually happened, not just the headline.
2. **Headline / sentence** — e.g. "Anthropic just shipped sub-agents for Claude Code". Take at face value.
3. **A single trend-scan item** — e.g. the user says "go with #3 from the scan" and pastes the item, or refers to a prior `ai-trend-scan` output in the conversation. Use the `why this matters` field as a strong signal for which framings will land.
4. **Trend-scan markdown block** — the user pastes the whole scan and points at one entry. Same as case 3.

### Optional modifiers

The user may also pass:
- **count override** — "give me 15 angles" or "just 6". Default is 8-12; honor explicit asks up to 20.
- **framing-bucket filter** — "only contrarian and prediction angles" or "no listicles". Honor it.
- **audience override** — the creator's default audience is "Claude Code / agentic-AI YouTube viewers". If the user explicitly retargets ("this is for the LinkedIn audience" or "treating this as a beginner explainer for non-devs"), shift accordingly.

If the seed is ambiguous (e.g. just "Claude Code" with no context), ask ONE clarifying question: "What's the specific angle of Claude Code you want to cover — a launch, a workflow, a comparison, a take? Or is the topic itself 'Claude Code generally'?" Don't ask more than one question — guess if you have to.

## The framing buckets

Every angle gets exactly one bucket tag. The eight buckets are intentionally non-overlapping in shape:

| Bucket | What it is | Looks like |
|---|---|---|
| **contrarian** | A take that argues against the obvious consensus reaction. Has to actually disagree, not just hedge. | "Why everyone celebrating sub-agents is going to regret it in 3 months" |
| **how-to** | Hands-on, step-by-step, the viewer does something by the end. Most reliable framing for the creator's audience. | "Build a 5-agent Claude Code pipeline in under an hour" |
| **story** | First-person narrative with a turn. Has a beginning/middle/end and a personal stake. | "I rebuilt my entire content workflow on sub-agents — here's what broke" |
| **listicle** | Numbered set of items. Works best when the number is specific and the items are concrete. | "7 sub-agent patterns I'll actually use (and 3 I won't)" |
| **news-reaction** | Direct response to the news event. Hot take, breakdown, what-it-means. Time-sensitive — decays fast. | "Anthropic just dropped sub-agents — here's what's actually new" |
| **explainer** | Teach the underlying concept, not the news. Evergreen-leaning. | "What sub-agents actually are (and why orchestrators were a dead end)" |
| **behind-the-scenes** | Show the process / setup / failures behind something the user built or did. Status + voyeurism. | "My exact Claude Code config after rebuilding it 4 times" |
| **prediction** | "What this means for X in 6/12 months." Speculative but grounded. | "Where Claude Code goes after sub-agents — my 12-month bet" |

### Audience desires

Tag each angle with the dominant desire it triggers. Use ONE primary desire per angle (you can mention a secondary in the premise if it helps):

- **mastery** — viewer leaves better at the craft. Strongest for this audience.
- **FOMO** — "I'd be behind if I didn't watch this." Strong for news-reaction and prediction.
- **status** — "watching this makes me the person who's ahead." Strong for contrarian and behind-the-scenes.
- **curiosity** — "I genuinely don't know what's behind this thumbnail." Strong for explainer with a twist.
- **fear** — "if I don't fix this, something bad happens." Strong for contrarian and some how-to (e.g. "you're configuring this wrong").
- **aspiration** — "I want to be the kind of person who does this." Story works here.
- **belonging** — "this is for people like me." Weaker for the creator's niche but legitimate for community content.

## Workflow

### Step 1 — Understand the seed

If the seed is a URL, fetch it. Read enough to know:
- What actually happened (not just the headline)
- Who the players are
- What the consensus reaction looks like (so you know what "contrarian" means here)
- What's genuinely new vs. what's already been said

If the seed is a sentence, take it at face value but interpret it generously. If it's a trend-scan item, lean on the `why this matters` annotation.

This step matters because angles generated without understanding the seed end up generic ("here's everything you need to know about X"). The angles should feel like they were written by someone who actually read the source.

### Step 2 — Generate one strong angle per bucket, then prune

Aim to produce one candidate per bucket first (eight candidates), then look at the set as a whole and:
- **Add 2-4 more** from the strongest buckets for this specific seed (a news seed deserves 2 news-reactions if there are genuinely different reactions to give, but never 4 — at that point you're rewording).
- **Drop** any candidate that's weak or duplicative.
- **Reorder** so the strongest framing for THIS seed is on top.

The order matters. the creator will skim the top of the list first; put the angle you'd actually pick first.

### Step 3 — Mandatory diversity rules for news seeds

If the seed is a news event, the output **must include**:
1. At least one **contrarian** angle (argues against the obvious reaction)
2. At least one **how-to** angle (a hands-on spinoff — "use the new thing to build X")
3. At least one **prediction** angle ("what this means for [agentic AI / dev tools / the creator's audience] in 6-12 months")

This is non-negotiable for news seeds because those three are the framings most likely to outperform the swarm of generic news-reaction videos that will saturate the topic within 48 hours.

For non-news seeds, the diversity rule is softer: just make sure you hit at least 5 of the 8 buckets across the final set.

### Step 4 — Format and output

Output as markdown, ranked best-first. Use the exact template in the next section.

## Output template

```markdown
# Angles for: [one-line seed restatement]

_Seed type: [URL / headline / trend-scan item / sentence]. [If URL, one-line source recap.]_

---

## 1. [Working title — punchy, not finalized]

- **Bucket:** [contrarian / how-to / story / listicle / news-reaction / explainer / behind-the-scenes / prediction]
- **Desire:** [mastery / FOMO / status / curiosity / fear / aspiration / belonging]
- **Why this lands:** [One-line justification rooted in the desire. What pull does this exert on the viewer?]
- **Premise:** [2-3 sentences. What the video actually is. What the viewer gets. What the turn / payoff is.]

---

## 2. [Working title]

- **Bucket:** ...
- **Desire:** ...
- **Why this lands:** ...
- **Premise:** ...

---

[... through angle N ...]

---

## Recommended pick

**[Number and title of the angle you'd film first.]** [One sentence why — usually: this is the framing least likely to be duplicated by other creators in the next 48h AND it hits the strongest desire for the seed.]

> Next step: feed the picked angle into the `outline-build` skill to generate the section-level structure.
```

The `Recommended pick` line at the end is important — it gives the creator a directional default so he doesn't have to re-read the whole list to decide.

## Output rules

- **Working titles, not final titles.** Titles here are for sorting and orientation. The `yt-titles` skill produces the actual A/B variants later. So: keep working titles punchy and clear (~5-10 words), but don't try to optimize for SEO or CTR yet. If the working title accidentally sounds great, leave it — `yt-titles` can use it as a starting point.
- **Genuinely different angles, not synonyms.** If two angles share the same bucket AND the same desire AND the same premise shape, kill one. The whole point of this skill is breadth.
- **Premises must be specific.** "Explain sub-agents" is not a premise — that's a topic. "Explain why sub-agents kill the orchestrator pattern, walk through one concrete example (the writer→editor→publisher chain), and end with the open question: do orchestrators die or become routers?" is a premise.
- **One bucket per angle.** No "contrarian + listicle" hybrids. Pick the dominant frame.
- **Don't generate hooks or titles here.** Those are downstream skills. Stay in your lane — pick the shape of the video, not the opening line or the thumbnail copy.
- **No filler angles to hit a count.** If the seed genuinely only supports 8 good angles, output 8. Don't pad to 12 with weak entries — the creator will notice and lose trust.

## Examples

### Example 1 — News seed

**Input:** "Anthropic shipped sub-agents in Claude Code today"

**Strong output shape (abbreviated, showing only top 3):**

```
## 1. Why sub-agents kill the orchestrator pattern (and what replaces it)
- Bucket: contrarian
- Desire: status
- Why this lands: Most takes today will be "look how cool" — a take that says "orchestrators are now dead weight" both fits the moment and positions the creator as the person who saw through the hype.
- Premise: Argue that sub-agents make hand-rolled orchestrator skills obsolete overnight. Show one orchestrator skill from the creator's own setup that's now redundant. End with the new pattern: orchestrator → router, with sub-agents doing the real work.

## 2. Building a 5-agent Claude Code pipeline in 45 minutes (using sub-agents)
- Bucket: how-to
- Desire: mastery
- Why this lands: The audience watched the announcement; they want to do the thing. First how-to-with-sub-agents video into the slot wins the search traffic for the next 90 days.
- Premise: Live-build a content pipeline (research → outline → draft → critique → publish) using one sub-agent per stage. Show the parent agent. Show the handoff. End with the skill file the viewer can copy.

## 3. What sub-agents mean for solo creators in 12 months
- Bucket: prediction
- Desire: FOMO
- Why this lands: The audience is asking "is this the moment things change" — give them a concrete answer with timestamps, not a hedge.
- Premise: Three predictions on a 12-month horizon: (1) most "AI agency" services collapse into single-creator setups, (2) the orchestrator-skill economy on plugin marketplaces shrinks, (3) Claude Code becomes the default IDE for non-devs. Each prediction with one falsifiable signal to watch.
```

Notice how each of these three is a genuinely different video — different shape, different desire, different shooting plan. That's the bar.

### Example 2 — Sentence seed (not news)

**Input:** "I want to make something about why most Claude Code skills suck"

This is a sentence seed with an opinion baked in. The angles should respect the opinion but surface different shapes for expressing it:

- A **contrarian** angle ("the skill ecosystem is built on a fundamentally broken metaphor")
- A **listicle** angle ("9 anti-patterns I see in 90% of skills")
- A **story** angle ("I shipped 30 skills this year — here are the 4 that actually got used")
- A **how-to** angle ("how to write a skill someone will actually trigger")
- A **behind-the-scenes** angle ("my skill writing process, on tape")
- An **explainer** angle ("what skill triggering actually is, and why most skills get ignored")

You'd output ~8-10 of these. The contrarian and the listicle are probably the strongest for this specific seed because the input itself is opinionated; lean into that with the order.

## Edge cases worth knowing

- **Seed is too thin.** If the user's seed is "AI agents" (no specificity), ask the one clarifying question (see Input section). Don't generate angles off a topic that broad — every angle will be generic.
- **Seed is already an angle.** If the user pastes "I want to make a contrarian video about why orchestrators are dead", they already have an angle. Either (a) confirm and skip to `outline-build`, or (b) offer to brainstorm sibling angles at the same framing level. Default to (a) unless they explicitly want alternatives.
- **Seed has decay risk.** News-reaction angles decay in 48-72h. If the seed is >72h old, downrank news-reaction angles and uprank explainer and how-to (which age better).
- **Seed overlaps with a recent the creator video.** If the user mentions they've already covered this from one angle, skip that bucket entirely. Don't generate variations of a video the creator already shipped.
- **Audience override is non-trivial.** If the creator says "this one's for the X audience, not YouTube", desire weights shift: mastery and status weaken on X; curiosity and contrarian-as-thread-bait strengthen. Adjust the order, not the bucket set.
- **Too few buckets supported by the seed.** Some seeds are bucket-hostile (e.g. a pure announcement doesn't really support a "story" angle without invention). It's fine to skip a bucket if forcing it would produce a weak entry. Hitting all 8 is not the goal — hitting 5+ with genuinely strong entries is.

## Handing off to the next step

This skill ends at the markdown list. When the user picks an angle (e.g. "let's go with #2"), that's a cue to hand off to `outline-build`, which consumes a single angle and produces section-level video structure.

The output template above is designed so `outline-build` can consume a single angle block (title + bucket + desire + premise) directly without reformatting. Keep the field names and order stable across runs — downstream skills depend on the shape.

If `outline-build` doesn't exist yet, just stop after producing the angle list and tell the user the next step is to pick one and run `outline-build` (or, in the meantime, feed the chosen angle into `yt-hooks` for hook generation).
