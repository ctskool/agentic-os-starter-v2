# YouTube Pipeline — source selection and analysis

Ported from the YouTube pipeline selection and synthesis rubric. The default workflow reads existing NotebookLM content or actual video transcripts and returns a local research artifact. Creating a remote notebook, adding remote sources or generating remote artifacts is not part of this initial run. Those operations require a separately requested follow-up with available authenticated capabilities; the port does not establish full parity for them.

## Discover and select

Search for the supplied topic and collect roughly ten metadata results from the last six months by default. Use up to twelve months for evergreen material or broaden the query once if no useful results appear. Preserve a user-specified window. Record title, channel, subscribers if available, views, duration, upload date and URL. Missing engagement or subscriber data is unknown, not zero.

Choose five to eight strong sources when enough exist. Balance topical relevance, evidence of engagement, recency, substantial teaching (often ten minutes or longer), and channel diversity; do not select only the largest channels. Views/subscribers is one contextual signal when both are known, not proof of content quality. Explain the selection and list excluded/failed sources briefly.

## Obtain content

Read actual transcripts through the selected provider's available connector, installed transcript helper or caption downloader. If the user identifies an existing NotebookLM notebook with relevant source content, read/query it through the installed authenticated capability. Do not silently create a notebook or upload sources because one is unavailable. Analyze local transcripts directly instead. Label partial transcripts and content failures. If no source content can be obtained, return BLOCKED: with the failure and selected metadata; metadata alone is not a substantive video analysis.

## Synthesize

Compare core ideas, concrete examples and methods across the selected content. Identify recurring themes, agreement, contradictions, limitations, actionable takeaways and under-covered audience questions. Cite video links and reliable timestamps where available. Answer any explicit analysis goal without forcing an unrelated content angle.

Preserve the original goal-to-question mapping, whether analyzing transcripts locally or querying an existing authorized notebook:

| User goal | Questions to answer from the source content |
| --- | --- |
| What's the consensus? | Where do the creators agree, and where do they disagree? |
| Best practices | What actionable advice is shared, and what do the creators recommend? |
| How to | What step-by-step approaches, tools and methods are described? |
| No explicit goal | What are the key themes and main points; where do perspectives agree or differ; and which takeaways can someone apply immediately? |

Keep follow-up analysis tied to the selected sources and the user's explicit goal. This mapping does not authorize creating a notebook, uploading sources or generating a remote artifact.

Return **Selected videos** (metadata table and rationale), **Key takeaways**, **Agreement and disagreement**, **Practical implications**, **Content gaps/opportunities**, and **Source status**. Include enough analysis to be useful as the final artifact; do not substitute a notebook link or a short completion receipt. An existing notebook link can accompany the evidence but never stand in for it.
