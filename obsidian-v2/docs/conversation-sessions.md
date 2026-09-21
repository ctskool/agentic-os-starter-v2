# Conversation session policy

Decision recorded September 16, 2026, for review finding L2.

Jarvis tabs share the web conversation selection for each provider. A newly opened tab or a browser reload **adopts the current unexpired selection**. Opening another browser view must not reset a conversation already being used elsewhere. A page opening is not conversational activity: it does not renew the 30-minute idle deadline, increment a context epoch, or restore a conversation cleared with **New conversation**. Existing expiry and active-work rules still apply. Explicit provider choices and new-conversation actions remain shared between Jarvis tabs.

Native Obsidian retains its existing fresh-start policy: reloading the plugin or reopening the app clears inactive automatic selection and quick-answer context, preserving active work and all saved terminal history. This policy is separate from Jarvis. A native request cannot opt into the web adoption mode.

The component preview at port 3218 is a view of the existing web state, not another lifecycle owner. Its entry point configures the work loader before component mounting; initialization reads `/work/current` and never posts `/work/session`. Preview actions explicitly performed by the user may still update the web selection. Opening or reloading the preview alone cannot reset it.

The bridge accepts `mode: "adopt"` on the web `/work/session` endpoint only. Omitting the mode preserves the existing fresh-session contract for native and legacy callers. Session retries remain idempotent and their stored IDs bounded. Authentication, origin checks and app ownership rules are unchanged.

This deliberate browser/native distinction avoids guessing whether a browser load is the first tab, a second tab, a duplicate, or a reload. No tab leases or extra polling are required. A separate independent-conversation-per-tab design remains outside this change.

Automated checks cover both providers, unchanged epochs and activity clocks across additional tabs, idle expiry during adoption, active work preservation, explicit new-conversation boundaries, native mode rejection, and the preview's actual work transport using reads only. Physical UI checks remain manual.
