# Generated output handoff

Voice work in either provider can register real local output and request that the originating dashboard display it. This is separate from terminal output and spoken acknowledgments.

## Execution

The worker receives a concrete, shell-quoted helper command with the Node executable, helper path, task ID, current request ID, and vault outbox path. It does not depend on shell environment inheritance. After saving the finished output it invokes this command with the actual local path, optional `--label`, and `--open` for a requested display. The helper validates the active request against this installation's task record and writes only to `system/v2/artifact-requests/<taskId>` in the vault. Registration does not mean the viewer has opened anything.

Final-response file links identify the finished deliverables. Images in that set are displayed; documents are displayed when explicitly requested through the helper or an inline embed. Intermediate revisions remain saved but are not opened or passed into follow-up context. Without final links, the last explicit helper display request is used, or otherwise the last discovered image. Multiple distinct final image links are preserved; repeated links to identical image content open once. A missing final file never silently substitutes an earlier draft. Workers should link all intended final outputs to distinguish them from intermediate versions and source material.

The scoped completion hook also reads the current conversation's completed turn for actual image-tool output paths. This recovers Codex image generation when the tool produced a PNG but the final reply omitted its link. Inspection is bounded to 32 MB, the exact session and turn, and a small date-derived rollout directory. There is no filesystem-wide polling and no extra model call.

The registry validates ownership, file type, size and real path, then saves an immutable copy in `system/v2/artifacts/files`. Identical content shares one copy across repeated requests. Per-turn references retain identity, label, MIME type, and whether they are final results. The last three final references are included in selected-conversation context and forwarded to the worker on follow-ups. Older references without this flag remain compatible.

The bridge accepts only registered IDs at `GET /artifacts/file`. The response contains the same bytes that passed hash validation. Supported formats are PNG, JPEG, WebP, GIF, PDF, Markdown and text. Files are limited to 20 MB; text is limited to 2 MB. HTML, SVG, arbitrary URLs, private configuration and linked paths are not previewed. The only external-file exception is the owning Codex conversation's `generated_images/<session>` directory.

## Display confirmation

`X-V2-Surface` binds voice work to its actual native/web surface. A separate durable queue serves `/artifacts/claim` and `/artifacts/ack`. An automatic reveal requires the original surface, active provider, current conversation and context epoch. The client must be visible, focused and idle. A new conversation, provider change, voice activation, hidden window or unload cancels an unfinished open.

Native Obsidian waits briefly for its file index, reveals an existing tab for that exact file if available, or otherwise opens one file tab and awaits the workspace operation. Jarvis opens a compact viewer and awaits image loading, PDF viewer navigation or committed text. PDF navigation does not prove every page rendered. Physical native rendering still requires a manual check.

Claims are persisted before delivery. While a client remains alive, a lost acknowledgment retries only that acknowledgment. A claimed result has a 60-second confirmation lease; when it expires, a five-second bridge sweep records failure and durably queues failed-display speech, even if the client never polls again. Late acknowledgments cannot convert that failure into success, and reloads never automatically reopen a previously claimed result. Pending, unclaimed reveals expire after five minutes. Saved file references remain available. A failed lease means display was not confirmed, not proof that the viewer never showed the file. Stable outcome identities prevent duplicate speech queue entries across restart. Opening confirmation has its own audio kind so ordinary task grouping cannot erase it. Worker qualifications remain in the spoken outcome.

Every completion passes through the presentation guard, including completions with no registered artifacts. Worker prose cannot confirm that a file appeared in a dashboard, screen or tab; only the viewer's acknowledgement can produce the opening confirmation.

## Storage and recovery

Only small references live in task history and bounded delivery receipts. Image bytes stay on disk and are read on demand. Saved generated files are retained when display receipts expire; history expiration does not silently delete user-created output. Repeated presentation reuses the existing content copy. A later follow-up requests a fresh display through the helper.

The implementation supports both Claude and Codex, and native Obsidian and Jarvis. Native microphone, focus and renderer behavior are checked manually rather than by automated computer use.

## Manual acceptance after activation

1. Confirm the loaded Obsidian V2 version matches the current release in the [README](../README.md); use `/services` native presence or the loaded plugin manifest, not only files on disk. Refresh Jarvis after activation.
2. Ask for an image and have it displayed. Verify the image actually appears and the spoken outcome does not claim opening before that happens.
3. Ask to show the same result again using an ordinary follow-up. Verify the existing tab is revealed without regenerating it or opening another copy. A task that revises one image should display only its finished version; an explicit request for two finished images should display both.
4. Repeat with the other provider and surface. Reload once and switch providers while work is pending; old results must not steal focus in the new conversation.

Automated coverage includes exact-turn image capture without a final link, helper registration, immutable content, percent-containing filenames, path/type/size validation, context propagation for both providers, display failure, acknowledgment loss, reload/cancellation races, and spoken qualification preservation.
