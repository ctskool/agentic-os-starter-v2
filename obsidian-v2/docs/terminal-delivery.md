# Terminal request delivery and legacy attachment cadence

The delivery guard addresses a voice follow-up that reaches the correct conversation but remains in its input box. A successful PTY write is not proof the CLI accepted a request. See the [README](../README.md) for the current release and [direct native terminals](native-terminals.md) for the normal Obsidian launch path.

## Follow-up delivery

- Paste the request and its spoken-answer/artifact instructions, then schedule one Enter after 750 ms.
- Codex acceptance requires an exact new user-message record in that conversation's rollout. Observation starts at the pre-paste file boundary, ignores historical messages, and reads at most 256 KiB per poll with bounded line buffering.
- Claude acceptance requires its exact current `UserPromptSubmit` event, including request identity, prompt, and timestamp.
- If acceptance is unconfirmed after 10 seconds, surface a needs-input message explaining that the user should inspect the composer and press Enter once if the request remains there.
- Never retry Enter automatically. Approval prompts, manual input, completion, stopping, or a changed process cancel the pending submission. Complete cursor/device/color reports from the terminal are not human input.
- Manual editing retires the exact-text receipt watch but preserves the pasted artifact helper's request identity through submission. A later fresh typed turn gets a new identity.
- Closing a watch releases its buffers. The check adds no model request and does not read old conversation history into a model.

These checks apply to follow-ups in already-running terminals. Initial requests and resumed CLI prompts retain their launch path. Fast report lookups are unaffected; the 750 ms paste-settle interval belongs to complex terminal follow-ups, not to every voice answer.

## Compatibility attachment updates

Older bridge-attached Obsidian tabs still use `terminal-attach.mjs`. That compatibility client previously switched from 100 ms active polling to 600 ms idle polling after any empty response. Codex's animation frames can arrive farther than 100 ms apart, producing an empty response between frames and visible batches afterward. New direct native tabs do not use this screen-polling path.

The attachment now retains active polling for one second after output or input, then returns to the existing idle interval. Requests remain serial, rendering preserves delta order and backpressure, and stopped terminals retain the slower polling interval. No additional agent process or continuous rendering loop is introduced.

## Verification and limits

Tests cover fragmented exact receipts, bounded reads, stale identities, approvals between paste and Enter, manual edits, artifact registration identity, late completion, cancellation, protocol replies, sparse animation frames, idle return, and isolated real attachment PTYs. Use the current release's verification ledger for executed test counts, typecheck and build results; historical totals do not describe the current code.

The longer delay is a mitigation for CLI paste consumption timing, not a guarantee that every terminal will accept automated input. The receipt check makes failure visible without blind resubmission. Actual submission against the pinned interactive CLI and perceived smoothness in native Obsidian still require a manual check after activation.

To verify manually: wait for a completed terminal task, speak a short edit request, and confirm the CLI begins without an extra Enter. Check that its result opens normally and animation updates look smoother. If the text remains in the input box, verify the warning appears instead of an indefinite working state.
