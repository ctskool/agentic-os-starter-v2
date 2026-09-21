# Content Cascade — transcript to complete drafts

Ported from the content-cascade skill and its blog/LinkedIn editorial prompts. These are content requirements, not publishing or database instructions. The initial workflow returns one complete Markdown draft bundle; the bridge owns its persistence. No remote posts, schedules, database writes, pending-marker deletion or status updates occur in this run. Those capabilities are not established by this port and require a separately requested follow-up.

## Verify the source

Use the supplied video URL to obtain its actual transcript and metadata. Try available transcript connectors/helpers, then an installed YouTube transcript reader or caption download tool; prefer original captions before generated captions. Check the opening sentences against the video title and identify the transcript method and coverage. A title, thumbnail or description is not a transcript. If all methods fail, return BLOCKED: and the source failure; never invent the video content.

Preserve product, model, tool and version names as spoken; verify unfamiliar names through primary sources instead of replacing them with familiar names. Extract the teaching, real demonstrations, examples and outcomes. Remove filler, repetition and sponsor reads. Describe visual steps only when supported by the transcript or inspected video. Never invent personal experiences, claims or statistics.

## Voice

Write in the creator's direct, conversational, practical voice, with contractions and concrete details. Use first-person experiences only when they appear in the source. Talk to the reader. Avoid corporate filler such as “game-changer”, “unlock”, “leverage”, “deep dive”, “in today's landscape” and generic motivational content. Do not imitate a claim of personal experience the source never made.

## Blog draft

- Start the blog body with one H1 title. Keep the body text-only: no inline images or blockquotes. Use bold labels inside lists when introducing a named step or concept, and give code fences an appropriate language tag. These formatting conventions apply to the blog copy, not the surrounding bundle metadata.
- Target 1,500–2,500 words without padding. Reorganize for reading logic and expand compressed teaching points.
- Put a direct answer to the main question in the first 40–60 words, then a grounded hook. Use natural question-shaped H2s, self-contained sections, paragraphs of 2–4 sentences, practical steps and at least two useful bold definitions.
- Include a concrete source example as Problem → Action → Result. Aim for a real data point every 150–200 words, but evidence takes priority: use [STAT NEEDED: topic] in review notes when a number is unavailable, never manufacture one.
- Finish with 3–5 H3 FAQs and concise answers. Use the configured creator/community CTA if available. If the vault file `system/v2/profile.json` has a `cta` text, close with it and adapt only the topic area; otherwise close without a community plug.
- Include metadata: title/meta title under 60 characters where possible; meta description 150–160 characters; primary keyword; 3–5 secondary keywords; lowercase hyphenated slug under 60 characters; 1–2 sentence excerpt; 3–7 tags; suggested internal-link topics; schema type; verified original video date and thumbnail URL when available.

## X post and reply

Write one strong outcome or grounded claim, usually under 140 characters and at most two short lines. No announcement opener, hashtags, emojis or YouTube URL in the post body. Provide the full video URL as a separate reply. Do not claim a video was posted.

## LinkedIn post and first comment

Mirror the video's full premise and adapt its opening 30–60 second hook. Cover each major idea with substance; do not replace a full framework with one minor point. Make it useful without watching, then point to the deeper video. Aim for 1,200–2,000 characters, but do not pad. The opening ~150 characters must work without prior context. Use one idea per line, no hashtags, and no Markdown decoration inside the copy.

Use the established CTA only when its offer is supported by the transcript or configured profile; do not invent a downloadable resource:

If you want access to [RELEVANT OFFER]:

1️⃣ Connect with me
2️⃣ Comment "agent"

Link to the full video breakdown is in the comments.

Keep the video URL out of the body. Include the exact separator on its own line, followed by the comment:

=== FIRST COMMENT ===
Full video here: <verified video URL>

## Complete result

Return a source/coverage summary, complete **Blog metadata**, **Blog draft**, **X post**, **X reply**, **LinkedIn post**, **First comment**, and **Review notes**. Keep the actual draft copy in the result, not merely links, a short index or a completion receipt. This draft workflow has no automatic publication or scheduling phase.
