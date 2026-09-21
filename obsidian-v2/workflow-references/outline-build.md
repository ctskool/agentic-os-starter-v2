---
name: outline-build
description: Take a single chosen YouTube video angle (typically the output of `angle-brainstorm`, but also a freeform angle paragraph, a sentence, or a URL) and return a complete retention-aware long-form YouTube outline ready to hand off to scripting or recording. Output is a markdown outline with working title, hook seed, stakes, 3-5 numbered body beats (each with purpose + 2-4 sub-bullets + optional re-hook callout), payoff/demo, CTA, runtime estimates, and per-beat b-roll notes — explicitly shaped so downstream `yt-hooks` and `yt-titles` skills can consume it without reformatting. Use whenever the user says "outline this", "build an outline for", "outline build", "structure this video", "give me a video outline", "outline for [topic]", `/outline-build`, or has just picked one angle from `angle-brainstorm` output ("let's go with #2") and wants to move forward. Also trigger when the user pastes a single chosen angle block and asks "what's the structure" or "how would I shoot this" — even if the word "outline" isn't used. This is stage 3 of the content pipeline: ai-trend-scan → angle-brainstorm → outline-build → yt-hooks → yt-titles.
---

# outline-build

Take ONE chosen video angle and return a complete, retention-aware long-form YouTube outline. The output is the bridge between "I picked the angle" and "I'm ready to write a script / press record."

## Why this exists

`angle-brainstorm` produces 8-12 angles — shape options, not structure. Picking the angle answers "what kind of video", but the creator still has to figure out *how the video moves*: where the hook lands, where the stakes get set, what the 3-5 body beats are, where re-hooks go, where the payoff sits, and how long each section runs.

That structuring step is what kills most creators. They sit with the picked angle and freeze, or they rush into a script without retention scaffolding, then wonder why average view duration is 2:14 on a 12-minute video.

This skill produces the structural scaffold. It's intentionally one layer above script ("here's a beat called *show the broken orchestrator*") and one layer below hooks/titles ("hook seed: 1-2 sentences, not the final wording"). It hands off cleanly to `yt-hooks` (which reads the hook seed and stakes to generate the actual opening) and `yt-titles` (which reads the working title and body to generate A/B-ready title variants).

## When this skill activates

Trigger phrases (case-insensitive, partial matches OK):

- "outline this" / "outline this video" / "outline this angle"
- "build an outline for" / "build me an outline"
- "structure this video" / "how would I structure this"
- "give me a video outline" / "video outline for"
- "outline for [topic]" / "outline build"
- `/outline-build`

Also trigger when:

- The user just got an `angle-brainstorm` output and says "let's go with #2" or pastes a single angle block — the implicit next step is the outline.
- The user pastes a single angle (paragraph or angle-brainstorm block) with no instruction other than "what now" or "ok let's do this" — assume they want the outline.
- The user says "how would I shoot this" or "what's the structure" about a specific video idea.

Do NOT trigger when:

- The user wants the actual opening line → that's `yt-hooks`.
- The user wants title A/B variants → that's `yt-titles`.
- The user wants alternative framings of the same seed → that's `angle-brainstorm`.
- The user wants a full word-for-word script — say so, then offer to draft the script *after* the outline if they still want it. This skill stops at the outline.

The mental model: this skill answers "given this angle, what's the section-level shape of the video?" — not "what should the first sentence be" and not "what should the thumbnail say."

## Input

The user provides a **chosen angle** in one of three shapes:

1. **An `angle-brainstorm` angle block** — the full block including working title, bucket, desire, why-it-lands, and premise. Easiest case. Use every field.
2. **A freeform angle paragraph or sentence** — e.g. "I want to make a video showing how my Codex config breaks when I push more than 5 agents at it, then fix it live." Treat as the premise; infer bucket and desire yourself before outlining.
3. **A URL** — usually a news article, a blog post, an X thread, or a YouTube video the user wants to react to. Fetch it (use WebFetch) before outlining. Build the outline as if the user picked a news-reaction angle on that URL, *unless* they specify a different framing.

### Optional modifiers the user may pass

- **target runtime** — "make it 6 minutes" or "this should be 18 min". Honor it. Default is 8-15 min; news-reaction defaults to 6-10 min and frontloads the payoff (see Retention rules below).
- **bucket override** — if the angle block says "contrarian" but the user explicitly says "outline this as a how-to instead", treat as a how-to. Note the override at the top of the outline so they remember.
- **specific demo or example to include** — "make sure beat 3 is the writer→editor→publisher example". Honor it.
- **skip the CTA** or **skip b-roll notes** — honor selective skips, but always keep working title + hook seed + stakes + body beats (those are load-bearing for downstream skills).

If the angle is too thin to outline (e.g. user pastes "Codex" with no framing), ask ONE clarifying question: "What's the specific premise — what does the viewer see, and what do they get by the end?" Don't ask more than one. Guess if you have to.

## Retention rules

This skill exists to produce *retention-aware* outlines, not generic ones. Internalize these rules and apply them to every outline:

- **Re-hooks every 2-3 minutes.** A re-hook is a single line or beat-opener that reminds the viewer why they're still watching. Examples: "but here's where it gets weird", "I haven't shown you the part that broke yet", "we'll get to the punchline, but first watch this happen". Flag every place a re-hook should land in the outline body.
- **Open loops in the first 90 seconds.** State a question or promise early that the video answers later. "By the end of this I'll show you the one config setting that made the difference — but first…". Mark the open loop in the hook seed and mark where it closes in the body.
- **Pattern interrupts every 2-3 minutes.** A pattern interrupt is a visual or audio break — cut to b-roll, switch to a different demo, change camera angle, drop a chyron, jump to a screen recording. Flag these in the b-roll/visual notes column. The cost of pattern interrupts is that they add edit overhead; the cost of skipping them is a 40% drop-off at the 4-minute mark.
- **Frontload the payoff for news-reaction.** If the angle is news-reaction (or the seed is a URL about something that happened in the last 72 hours), default to 6-10 min and put the "what's actually new / what to do about it" in beat 1 or 2, not beat 4. News-reaction viewers bail early on slow setups. Save the contextual setup for beat 2 or 3 *after* the take has already landed.
- **Don't frontload the payoff for evergreen.** For how-to, explainer, story, behind-the-scenes, contrarian, prediction: the payoff is the destination, not the opener. Pace toward it. The video can be 12-15 min if the journey is paid off.
- **Stakes in the first 60 seconds.** Right after the hook, the viewer needs to know what they get if they stay. Don't bury stakes — they belong in the section directly after the hook seed, before beat 1.
- **CTA goes after the payoff, not in the middle.** Don't interrupt the body with subscribe asks. Place the CTA in the last 30-60 seconds, ideally tied to the next video or a concrete next action ("the one config setting we didn't cover today gets its own video — link in the description").

## Workflow

### Step 1 — Read the angle and pin down the essentials

If the input is an `angle-brainstorm` block, read every field. The bucket tells you the structural shape (a how-to outline looks very different from a contrarian outline). The desire tells you what the viewer is here for (mastery → demos and concrete sub-steps; status → the "you'd be ahead of others if you knew this" framing; FOMO → consequences of not watching).

If the input is a freeform paragraph or sentence, do the bucket-and-desire tag yourself in your head before drafting. Don't ask the user — just commit. The 8 buckets are: contrarian, how-to, story, listicle, news-reaction, explainer, behind-the-scenes, prediction (see `angle-brainstorm` SKILL.md for definitions if you need them).

If the input is a URL, WebFetch it first. Read enough to know what happened, what the consensus reaction is, and what's genuinely new. Then outline as a news-reaction unless the user says otherwise.

### Step 2 — Decide target runtime and beat count

- News-reaction → 6-10 min → 3 beats default.
- How-to → 10-15 min → 4-5 beats default (one per major step in the process).
- Story, behind-the-scenes → 8-12 min → 3-4 beats (setup, turn, resolution, lesson).
- Explainer, contrarian, prediction → 10-15 min → 3-5 beats.
- Listicle → 8-15 min → 3-5 beats (typically one beat per 2-3 list items, not one beat per item — beats are structural, list items live inside beats).

Honor explicit runtime overrides from the user. If you increase runtime, add beats; if you decrease, consolidate.

### Step 3 — Draft each section

Use the output template in the next section. For each beat:

- Write a **beat title** that captures what the beat *does* (not just what it's about). "Show the orchestrator break" is better than "About orchestrators."
- Write a **one-line purpose**: what does this beat do for retention or payoff? E.g. "Sets up the open loop that beats 3-4 will close" or "Pays off the open loop set in the hook."
- Write **2-4 sub-bullets** with specific content, demos, examples. Don't write generalities ("explain the concept") — write the actual moves ("show the 6-line skill that I shipped Monday, then point at the one block that's now redundant").
- Decide if this beat **needs a re-hook or open-loop callout**. Flag it. Not every beat needs one — flag the 1-2 places in the body where retention is most at risk (typically the 30%-mark and the 60%-mark).
- Write **b-roll / visual notes** for the beat: what's on screen, what the cut feels like, what the pattern interrupt is. Tie to the pattern-interrupt cadence (every 2-3 min).

### Step 4 — Set runtimes per section

Eyeball runtime per beat in 30-second increments. The total of (intro + stakes + body beats + payoff + CTA) should match the target runtime. Show the breakdown in the output so the user can sanity-check.

Default runtime distribution for an 8-15 min long-form video:

| Section | Default share | Notes |
|---|---|---|
| Hook | 0:15 - 0:30 | Hook seed is short on purpose; `yt-hooks` will expand it. |
| Stakes / why-watch | 0:30 - 1:00 | Right after the hook, before beat 1. |
| Body beats (combined) | 60-75% of total | If video is 12 min, body is ~8-9 min. |
| Payoff / demo | 1:00 - 2:00 | The "show, don't tell" moment. Has to land. |
| CTA | 0:20 - 0:45 | Don't pad. Tie to next action. |

For news-reaction (6-10 min), compress stakes (0:20-0:30), compress the body, and treat the payoff as integrated into beat 1 or 2 rather than as a separate end-of-video section.

### Step 5 — Output

Use the template in the next section verbatim. Don't reshape the field names or order — `yt-hooks` and `yt-titles` parse this structure and will silently miss fields that are renamed.

## Output template

```markdown
# Outline: [Working title — 5-10 words, punchy, not finalized]

> _Angle bucket: [contrarian / how-to / story / listicle / news-reaction / explainer / behind-the-scenes / prediction]_
> _Dominant desire: [mastery / FOMO / status / curiosity / fear / aspiration / belonging]_
> _Target runtime: [N minutes]_
> _Bucket override (if any): [note here, else delete this line]_

---

## Hook seed (1-2 sentences — `yt-hooks` will finalize)

[1-2 sentence rough hook. State the promise or the open loop. Don't try to write the final wording — that's `yt-hooks`'s job. Example: "I shipped 12 Codex skills this year and the one that 10x'd my output was the one I almost deleted. Here's why."]

**Open loop to close later:** [One sentence — what question does the hook leave open that the body will answer?]

---

## Stakes / why-watch (0:30-1:00)

[2-4 sentences. What does the viewer get if they stay? Be concrete. "By the end you'll have a 5-agent Codex pipeline running on your machine" beats "you'll learn about agents." Tie to the dominant desire.]

---

## Body

### Beat 1 — [Beat title that captures what the beat does]

- **Purpose:** [One line. What this beat does for retention or payoff.]
- **Runtime:** [e.g. 1:30 - 2:30]
- **Content:**
  - [Sub-bullet 1 — specific, not generic. Include the actual example or demo.]
  - [Sub-bullet 2]
  - [Sub-bullet 3]
  - [Sub-bullet 4 — optional, only if needed]
- **Re-hook / open-loop:** [If this beat opens or closes a loop, note it. Otherwise delete this line.]
- **B-roll / visual notes:** [What's on screen during this beat. Pattern interrupts. Screen recordings. Cuts. Chyrons.]

---

### Beat 2 — [Beat title]

- **Purpose:** ...
- **Runtime:** ...
- **Content:**
  - ...
- **Re-hook / open-loop:** ...
- **B-roll / visual notes:** ...

---

### Beat 3 — [Beat title]

[same structure]

---

[... through beat N (3-5 total) ...]

---

## Payoff / demonstration (1:00-2:00)

[The "show, don't tell" moment. The single thing the viewer remembers. For how-to: the finished build running. For contrarian: the demonstration that the consensus take was wrong. For story: the resolution. Be concrete — name the artifact, the screen recording, the side-by-side comparison.]

- **What the viewer sees:** [Specific visual.]
- **What the viewer feels:** [Tied to the dominant desire — "I now know what to build", "I'm relieved I won't make this mistake", "I want to ship the same setup."]

---

## CTA (0:20-0:45)

[Tied to next action. Don't pad. One of:
- "Next video tease" — what's the natural sequel? Tease it.
- "Comment prompt" — a specific question the viewer can answer in comments.
- "Subscribe / link in description" — only if you're pointing at a concrete resource (the skill file, the config, the doc).]

---

## Runtime summary

| Section | Runtime |
|---|---|
| Hook | 0:30 |
| Stakes | 0:45 |
| Beat 1 | 2:00 |
| Beat 2 | 2:30 |
| Beat 3 | 2:30 |
| Payoff / demo | 1:30 |
| CTA | 0:30 |
| **Total** | **~10:15** |

---

## Retention scaffolding (summary)

- **Open loop opened in:** Hook seed
- **Open loop closed in:** [Beat N or Payoff]
- **Re-hooks placed at:** [Beat numbers, roughly the 30% and 60% marks]
- **Pattern interrupts at:** [Approximate timestamps — every 2-3 min — based on body beat cuts and b-roll]

---

> Next step: feed this outline into the `yt-hooks` skill to finalize the opening, then into `yt-titles` to generate A/B-ready title variants. Both downstream skills read the **working title**, **hook seed**, and **stakes** fields directly — don't rename them.
```

## Output rules

- **Don't write the script.** Outlines stop at beat-level structure with specific sub-bullets. If the user wants the actual script, that's a separate ask — say so and offer to draft it after they sign off on the outline.
- **Don't finalize the hook or the title.** The hook seed is intentionally rough (1-2 sentences) because `yt-hooks` finalizes it. The working title is intentionally placeholder because `yt-titles` produces the A/B variants. Don't pre-empt those skills.
- **Sub-bullets must be specific, not generic.** "Explain the concept" is not a sub-bullet — that's a topic. "Show the 4-line skill from Tuesday's video; point at the trigger phrase block; explain why it didn't fire" is a sub-bullet. If you find yourself writing generic sub-bullets, you don't understand the angle well enough yet — re-read the angle block or ask the user one clarifying question.
- **3-5 body beats, not 7+.** YouTube viewers' working memory caps around 5 chunks. More than 5 beats and the structure starts feeling like a slog. If the content seems to need 6+ beats, consolidate (two related beats become one with sub-sections).
- **Honor target runtime.** If the user says "6 minutes", don't output a 12-minute structure. Compress beats, consolidate, drop the CTA's length, frontload the payoff.
- **Runtime per beat in 30-sec increments.** Don't write "Beat 1: 2:17 - 2:43." Write "Beat 1: 2:00 - 2:30." Precision is fake; round honestly.
- **B-roll notes are mandatory unless the user explicitly skips them.** Pattern interrupts are what keep the video watchable; if you skip the b-roll column, you've removed the retention scaffolding.

## Examples

### Example 1 — Input is an `angle-brainstorm` block (contrarian)

**Input:** (the user paste)

```
## 1. Why sub-agents kill the orchestrator pattern (and what replaces it)
- Bucket: contrarian
- Desire: status
- Why this lands: Most takes today will be "look how cool" — a take that says "orchestrators are now dead weight" both fits the moment and positions the creator as the person who saw through the hype.
- Premise: Argue that sub-agents make hand-rolled orchestrator skills obsolete overnight. Show one orchestrator skill from the creator's own setup that's now redundant. End with the new pattern: orchestrator → router, with sub-agents doing the real work.
```

**Strong output (abbreviated, showing the working title, hook seed, beat 1, and the runtime summary):**

```
# Outline: Sub-Agents Kill the Orchestrator Pattern

> _Angle bucket: contrarian_
> _Dominant desire: status_
> _Target runtime: 11 min_

## Hook seed
"Everyone is celebrating sub-agents this week. Almost no one is saying the quiet part out loud: most of the orchestrator skills you've been writing for the last 6 months are now dead weight. Let me show you exactly one of mine that I deleted yesterday — and the pattern I'm replacing it with."

**Open loop to close later:** What's the replacement pattern that orchestrators become?

## Stakes / why-watch (0:45)
You'll see one concrete orchestrator skill (mine) that became obsolete in 48 hours, why it was already structurally weak, and the new shape — orchestrator-as-router with sub-agents doing the real work — that's about to eat the skill ecosystem. By the end you'll know whether your own orchestrators are at risk and what to replace them with.

## Body

### Beat 1 — The orchestrator skill I just deleted
- Purpose: Pays off the hook's promise immediately. Specificity earns trust for the contrarian take in beats 2-3.
- Runtime: 1:30 - 2:30
- Content:
  - Open the actual skill file on screen (content-cascade orchestrator from a prior video).
  - Read the 4 stages it coordinated: research → outline → draft → critique.
  - Show the new sub-agent version doing the same thing in 1/3 the file size.
  - Side-by-side: 80 lines of orchestrator vs. 1 router + 4 sub-agents.
- Re-hook / open-loop: Mid-beat: "And this is the cheap example — the expensive one is coming."
- B-roll / visual notes: Screen recording of skill file. Side-by-side diff. Cut to webcam at the "this is the cheap example" line for pattern interrupt.

[... beats 2-4 ...]

## Runtime summary
| Section | Runtime |
|---|---|
| Hook | 0:30 |
| Stakes | 0:45 |
| Beat 1 | 2:00 |
| Beat 2 | 2:30 |
| Beat 3 | 2:30 |
| Beat 4 | 1:30 |
| Payoff / demo | 1:00 |
| CTA | 0:30 |
| **Total** | **~11:15** |
```

Notice: the contrarian framing drives the structure — Beat 1 pays off the hook immediately (you can't make people sit through 4 minutes of setup for a contrarian take, they'll bail). The open loop is closed late so the viewer has a reason to stay until beat 4. Pattern interrupts are noted in the b-roll column. The CTA isn't padded.

### Example 2 — Input is a news URL

**Input:** "outline this: https://www.anthropic.com/news/sub-agents-Codex"

**Process:**

1. WebFetch the URL. Read what shipped, when, and what the consensus reaction looks like.
2. Default to news-reaction framing. Target runtime: 6-10 min. Frontload the payoff.
3. Beat structure: 3 beats. Beat 1 = "what shipped + the take" (payoff up front). Beat 2 = "what this means for your setup" (concrete consequences). Beat 3 = "what to do this week" (action items).

The output follows the same template as Example 1 but compresses stakes (0:20) and CTA (0:20), and the payoff is structurally inside Beat 1 rather than a separate end-of-video section.

### Example 3 — Input is a freeform paragraph (how-to)

**Input:** "I want to show people how to build a 5-agent content pipeline in Codex in under an hour, starting from scratch, with the parent agent handing off to one sub-agent per stage."

**Process:**

1. Tag bucket: how-to. Tag desire: mastery.
2. Target runtime: 12-14 min (how-to gets full runtime for the demo to land).
3. Beat structure: 4-5 beats — one beat per major stage of the build (setup → first sub-agent → handoff pattern → remaining sub-agents → running the full pipeline live).
4. Payoff: the full pipeline running end-to-end at the end. Mandatory live demo, not just talking through it.

The output follows the same template with how-to's typical retention pattern: open loop = "by the end you'll see all 5 agents run in 30 seconds", closed in the payoff.

## Edge cases worth knowing

- **Angle is too thin to outline.** If the user pastes "outline this: Codex" with no framing, ask the one clarifying question (see Input section). Don't outline a topic — outline an angle. If they refuse to specify, default to how-to + mastery + 12-min and note the assumption at the top.
- **Angle conflicts with target runtime.** If the user says "outline this contrarian angle in 4 minutes", warn them: contrarian needs setup to earn the take. 4 minutes risks looking like a Twitter hot take. Offer 6-7 min as a compromise.
- **Multiple angles pasted at once.** If the user pastes 3 angles and says "outline these", outline only the FIRST. Then ask if they want the other two. Don't crank out three full outlines unprompted — they'll likely revise the first and discard the rest.
- **News URL is older than 72 hours.** The news-reaction default decays. Either ask the user whether they still want news-reaction framing, or default to explainer (the topic, not the news) since explainer ages better. Note the downgrade at the top.
- **Runtime is unusually long (>20 min).** Push back gently. Long-form on the creator's channel performs best at 8-15 min. If the user insists on 25 min, structure as 6-7 beats with explicit re-hooks every 3 min, and warn them that average view duration on 25-min videos drops fast.
- **Listicle angle.** Beats are still structural, not per-item. A 7-item listicle should have 3 beats, each covering 2-3 items, with a re-hook between beats. Don't make 7 beats — that's a list inside an outline, not an outline.
- **Behind-the-scenes / story.** Stakes get reshaped — the stakes aren't "you'll learn X" but "I'm about to show you what actually happened, and it has a turn." The hook seed should explicitly tease the turn. The turn lands in beat 2 or 3, not beat 1.

## Handing off to the next step

This skill ends at the outline. The downstream handoff:

- **`yt-hooks`** reads the **hook seed**, **stakes**, and **dominant desire** to generate the Three Hook Alignment (visual + spoken + text), Four Commandments check, and the five desire-based variations. Keep those three fields stable and accurate — `yt-hooks` will produce a worse hook if the seed is generic.
- **`yt-titles`** reads the **working title** and the **body beats** (specifically the beat titles and the payoff section) to generate framing-diversified title variants and the A/B test plan. Keep the working title punchy and the beat titles concrete, since `yt-titles` mines them for specificity signals.

If the user picks up the outline and goes straight to recording without running `yt-hooks` or `yt-titles` first, that's fine — the hook seed is shootable as written, just rough. But for any video the creator plans to ship to the channel, both downstream skills should run on this outline before the script gets written.
