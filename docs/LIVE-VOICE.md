# Live voice

**Local** is the default. It uses Whisper and Kokoro on your computer for speech. **Live** uses GPT-Live for a two-way call and hands requests that need a saved report or an action back to Agentic OS.

## Before you start: an OpenAI API key

Live needs a key from OpenAI's API platform. That is a separate account from ChatGPT, and a ChatGPT subscription does not include it.

1. Sign in at [platform.openai.com](https://platform.openai.com).
2. Add credit under **Billing**. Calls are paid from that credit and stop working when it runs out.
3. Create a key on the [API keys page](https://platform.openai.com/api-keys) and copy it whole. It starts with `sk-`. Keep it out of chat: you paste it into a page on your own computer in the next step.

## Set up Live

The easiest way is to tell your coding agent **“set up Live voice”**. It runs the steps below with you.

1. From the starter folder, run `node aos.mjs openai-key` (or `aos openai-key` if you use the shortcut). Open the local page it gives you, review the disclosure, enter your OpenAI API key, and save your consent there. The page checks the key with OpenAI before it saves anything. A key OpenAI refuses is not saved, and the page tells you so, which lets you paste it again.
2. Open **···** beside the Obsidian orb or on the HUD Voice card. Choose **Live** and start a call from that screen. Grant microphone access when asked. Only one of the two screens can own a call at a time.
3. Use the call bar to **Mute** or **End call**. A call ends when you select **End call**, after your **End call after idle** time without speech, or when you close or reload its window. It also ends if you switch to **Local** in the voice menu or the bridge restarts. Clicking the orb, pressing Escape or Ctrl+Alt+J, opening a terminal, using another window and leaving the tab in the background all leave it running.
4. Try three things on your first call. Ask a general question. Ask “What’s on my plan today?”, which Live answers from what it already has. Then say “Run Inbox Brief”, which it hands to V2. Say “stop” within about 2.5 seconds if you don’t want that to run.

If a call will not start, the message on screen says why and what to do: a key OpenAI no longer accepts, no credit on the API account, or a key that is not allowed to use the Live model. `node aos.mjs doctor` has a **Live voice (OpenAI key)** line that checks the saved key at any time. It cannot see your credit; only a call shows that.

## Make it work the way you want

- **Just do it** is the default. Live announces the action right away. Say “stop” or “wait”, or select **Cancel**, within about 2.5 seconds to cancel before V2 carries it out. You can choose another mode in **Live settings → Confirm actions**.
- **Say yes** asks before V2 acts. After you say yes, you have 1.5 seconds to say “wait”, correct the request, or tap **Cancel**. **Tap to confirm** waits for a click. **Ask only for stops & edits** starts new work immediately and asks for a click before stops, replacements, note edits, and conversation switches.
- **Wake on voice** leaves the mic open in standby by default. Turn it off to mute the mic in standby. Click to wake it, or press **Ctrl+Alt+J** on Windows.
- **End call after idle** defaults to 30 minutes without speech. You can choose 15 or 60 minutes. Calls renew themselves before OpenAI's 2-hour session limit. **Remember today’s calls** is off by default. Turning it on can send a short summary of earlier Live exchanges from the same app when a new call begins.
- **Share task titles** is on by default. Turn it off to leave work in progress out of the snapshot.
- **Share morning brief** is off by default. Turn it on to give Live your whole morning brief at the start of each call, including its email section. Live can then answer “Any important email today?” or “What are my three moves?” straight away and offer to check for anything newer. That text goes to OpenAI. With it off, Live gets only the brief’s top headlines and hands those questions to V2.

## How Live handles tasks

Live acknowledges a task once, then you can keep talking while it runs. Ask “How’s that going?”, “Status of the research task”, or “What’s running?” for the current state. Say “slash today” or “run slash plan-tomorrow for next week” to start an installed skill in a fresh conversation with the selected provider.

In Jarvis, each request Live hands off shows a card beside the core: **Handing off** while V2 works out the request, then the name of the task it started or the note it answered from. The card clears by itself after a few seconds.

Live waits for a pause before saying what finished, what failed, or which task needs your input. Tasks that finish close together are announced together. In standby, a short chime and a card signal an update. Live speaks it when the call wakes and there’s a pause. After hangup, results stay on screen. In Jarvis, select a task chip in **Terminals** or **View** in the toast to inspect it. In Obsidian, check the work list or select **View** in its notice.

Use **Live settings → Task updates** to choose **Done & blockers** (default), **Screen only**, or **Check in on long tasks**, which adds a check-in every three minutes for tasks started in the call.

## What Live answers and what it hands off

| Live’s role | Examples |
|---|---|
| Answers directly | General knowledge, explanations, advice, brainstorming, conversation, and anything in the call’s snapshot. |
| Hands off to V2 | Your data beyond the snapshot, actions on your computer, web research, and current news beyond the snapshot. |
| Never | Guessing facts about you or your vault. |

If Live offers a concrete next step, say “go ahead” within a minute. An offer to read a result uses the latest result from the call. Other accepted offers route as fresh requests.

## What is sent and what it costs

Live sends audio, the vault snapshot, and answers to handed-off requests to OpenAI with `store:false`. At the start of every call the snapshot can include your **About me**, today’s top three priorities and schedule from the `/today` daily note, your Daily Drivers, up to five task titles with provider and status, counts of new notes in your vault’s `inbox/` folders for the last 24 hours (notes, not email), metrics and the latest video, headlines, radar, and any notes you added yourself. Task prompts, replies, and report paths stay out of the snapshot. The note counts contain no note names.

With **Share morning brief** on, the whole morning brief takes the place of the headlines: every section, including its email section, with links removed, up to 36,000 bytes. With it off, email contents stay on your computer.

### Choose what Live knows

The snapshot is yours to shape. Run `node aos.mjs live-context show` to see what a call reads, or ask your coding agent, for example *"add my goals note to Live"* or *"stop sending the radar to Live"*.

- **Turn parts off.** `node aos.mjs live-context section radar off` (or `today`, `inbox`, `numbers`, `news`). A part fed by a workflow you do not run is empty anyway.
- **Add your own notes and reports.** `node aos.mjs live-context add "projects/goals.md" --label "Goals"`. Add a folder instead of a note and Live reads the newest note in it, so a report one of your skills saves each day stays current. Up to six; each is read up to about 6,000 characters, so a short summary note works better than a long one.
- **See it exactly.** `node aos.mjs live-context show --full` prints the snapshot as it would be sent now.

Long-lived facts about you belong in About me; today's details belong in your daily note; anything else you want on every call goes in a note you add here.

Your Claude and Codex agents read **About me** from the vault’s `AGENTS.md`. Live reads up to 2,000 bytes of that section. Run `node aos.mjs about show` to see the text Live receives, or ask your coding agent “update my About me” to review and change it.

Typed requests use the regular V2 route and stay out of GPT-Live. Live receives short outcomes from the work it hands off. With Live selected, task updates stay on screen after hangup.

The call bar estimates **$0.05 per active minute** and **$0.02 per standby minute**. When OpenAI does not report a breakdown, the meter uses the active rate for all reported seconds. Pro and Business API credits require eligibility and activation on the linked OpenAI API organization. Check that organization's API usage page for actual charges.

For setup and playback errors, see [Live voice troubleshooting](TROUBLESHOOTING.md#live-voice).
