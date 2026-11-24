# Troubleshooting

Start with `node aos.mjs doctor`. Every FAIL line carries its own fix, and a check that could not run is printed as SKIP with the reason. The command exits with code 1 when anything failed; the last line says whether a *core part* failed or only an *optional part* (voice, Jev, a second provider). If the doctor says a failure is the same as last time, do not run it again: do what that line says. This page covers what the doctor cannot see.

## Where to look

| What | Where |
|---|---|
| Which services are up | `node aos.mjs status` |
| Why a service keeps restarting | `obsidian-v2/.runtime/service-supervisor.jsonl` (one line per event) |
| Monitor would not start at login | `obsidian-v2/.runtime/service-supervisor-startup-error.log` |
| A workflow failed | the HUD (http://127.0.0.1:3217) → Terminals → History → open the task |
| What setup recorded | `obsidian-v2/.runtime/aos-setup.json` (no secrets) |

Keep `jev.json`, `openai.json`, `bridge-auth.json`, and `speech-auth.json` private. They hold API keys or local access secrets.

## Live voice

| What you see | What to do |
|---|---|
| Live asks you to run `aos openai-key`, or says consent is missing | Run `node aos.mjs openai-key` from the starter folder. Enter a valid OpenAI API key and save your consent on the local page, then select **Live** again. |
| The key page says “OpenAI did not accept that key” | The key was mistyped, cut short or revoked. Nothing was saved. Copy it whole from [platform.openai.com/api-keys](https://platform.openai.com/api-keys), or create a new one there, and paste it again. |
| The key page says “That is an OpenRouter key” | That key is for Jev. Live needs a key from OpenAI's API platform. See [Before you start](LIVE-VOICE.md#before-you-start-an-openai-api-key). |
| A call says “OpenAI did not accept the API key” | The saved key stopped working. Run `node aos.mjs openai-key` and enter a current one. |
| A call says the OpenAI API account “has no credit” | Add credit under **Billing** at platform.openai.com, then start the call again. On ChatGPT Pro or Business, check that the included API credits were claimed and that the key comes from the API account linked to your ChatGPT plan. |
| A call says the key “is not allowed to use the Live model” | The key belongs to a project without access to `gpt-live-1.1`, or it is a restricted key without that permission. Create a key in a project that has access and save it with `node aos.mjs openai-key`. |
| A call says OpenAI “is limiting requests” or “had a problem on its side” | Wait a minute and start the call again. Nothing is wrong with your setup. |
| You want to know whether Live is set up correctly | Run `node aos.mjs doctor` and read the **Live voice (OpenAI key)** line. It checks the saved key with OpenAI. It cannot see your credit. |
| Windows says “Update the voice service” | Run `node aos.mjs doctor` to see which voice service this installation is using. If it is sharing an older one, update or stop that service from its own installation. When your tasks are finished, run `node aos.mjs stop` and `node aos.mjs setup --voice yes` from this starter so it can run the current voice service. |
| Microphone access is denied | Allow microphone access for Obsidian in your system settings, or for `127.0.0.1:3217` in your browser. Make sure the right mic is selected, then click to start a new call. |
| Live audio playback is blocked | Allow sound and autoplay for the HUD in your browser, or check Obsidian’s audio output and system volume. Keep the window in front and click to start a new call. |
| The meter differs from the OpenAI usage page | The call bar is an estimate. It uses the active rate for all reported time if standby time is missing. Check the usage page for the organization linked to the saved key. |

See [Live voice setup](LIVE-VOICE.md) for the settings and data disclosure.

## Common situations

**Python is installed, but voice setup cannot find it on Mac.** After `brew install python@3.12`, check `python3.12 --version`; `python3` can still be Apple's older Python. Setup tries the versioned name when the generic commands are missing or too old. If setup runs with a different `PATH`, prefix your original setup command with `AOS_V2_PYTHON="$(brew --prefix python@3.12)/bin/python3.12"`, keeping its other arguments. For a non-Homebrew installation, use the absolute Python executable path instead. This selects the interpreter for a new private voice environment; it does not replace an existing environment or the system Python.

**The cockpit says the bridge is offline.** `node aos.mjs start`, wait 20 seconds, reload the plugin (or restart Obsidian). If it says "authentication required", run `node aos.mjs setup` again: it re-copies the local access token into the plugin.

**A conversation will not open inside Obsidian, or a notice names the Terminal plugin.** Conversations inside Obsidian need the Terminal community plugin (by polyipseity), a stable 3.x release from 3.27.1 on. "Too old": update it in Settings → Community plugins. "Pre-release" or "has not been verified": install the regular release, or use the same button in the HUD (http://127.0.0.1:3217) until `node aos.mjs update` brings support. "Newer than the versions tested": it should work; if a conversation misbehaves, use the HUD and run the doctor. "Cannot follow it": the conversation may still be running in that tab, so check it and close it before trying again. The doctor's "Terminal plugin" line shows what is installed.

**Services never start after choosing start-at-login on Windows ("The recovery monitor did not become available").** Older versions registered the Windows login task in a way a fresh Windows (scripts blocked by default) refuses to run. `node aos.mjs start` now repairs that task by itself and starts the services directly if the task still does nothing. If you updated from an older version, run `node aos.mjs setup` once after the update so the new setup code runs.

**"Found Python 3.14 …, but voice needs Python 3.10-3.13".** The voice libraries do not support Python 3.14 yet, which python.org and Homebrew now install by default. Install 3.12 next to it (Windows `winget install Python.Python.3.12`, Mac `brew install python@3.12`) and run setup again with `--voice yes`; setup picks 3.12 by itself. If it says the voice service may still be running, run `node aos.mjs stop` first.

**The buttons use Codex but you only have Claude Code (or the reverse).** `node aos.mjs setup --provider claude` (or `codex`) switches them. Setup never changes your choice on its own.

**"Stop active tasks in Terminals first."** A conversation is still open. Close its tab in the HUD (× ends it) or in Obsidian, then repeat the command.

**"Port 3221 belongs to another installation."** A second copy of this system is running from another folder, and only one copy can run at a time. The message names the folder (`It runs from "..."`); you can also open http://127.0.0.1:3221/status, where `runtimeDir` is that copy's `obsidian-v2/.runtime` folder. Run `node aos.mjs stop` in that copy's folder.

**The doctor says voice is a "shared service".** Another program on this computer already runs a compatible speech service (for example an earlier Jarvis install on port 3108), so this installation uses it instead of starting a second copy of the same models. Setup downloads nothing for voice in that case. If that other program goes away, run `node aos.mjs stop`, then `node aos.mjs setup --voice yes`: with nothing to share, this installation gets a voice of its own.

**Voice: the microphone does nothing.** Check the browser's site permission for `127.0.0.1:3217`. Mac: *System Settings → Privacy & Security → Microphone* must list your browser and Obsidian. The first request after a start can take a minute while the speech models load.

**Mac global voice shortcut.** With this installation's own voice service, press **Control–Option–J** once, speak, and pause to send. Keep the Obsidian orb enabled or the HUD visible. The selected app records, so allow microphone access for Obsidian or your browser. Rebuild/reload both cockpits when updating the shortcut protocol. `node aos.mjs doctor` reports registration failures, including a combination owned by another app. See [Mac voice setup and testing](MAC-VOICE.md).

**Voice hears nothing: the doctor fails "Speech to text hears it back" with status 500.** An audio library released a version the speech-recognition package cannot use. Update the starter, then run `node aos.mjs stop` and `node aos.mjs setup --voice yes`: it reinstalls the voice packages with the right version.

**Mac: voice and everything else feels slow, although the same Mac is fast otherwise.** Older versions registered the start-at-login item as a background job, which macOS runs at low priority (speech took about eight times longer). Update the starter, then run `node aos.mjs stop` and `node aos.mjs start`. The start replaces the login item; the stop is what lets the services come back at normal speed.

**Mac: nothing is running after a restart or after logging out and in.** Older versions treated the Mac shutting down as you pausing the system. Update the starter and run `node aos.mjs start` once; from then on it comes back by itself after a restart.

**Voice answers something I did not say, or I speak another language.** Voice hears and speaks English unless the vault says otherwise. To change it, add `"speechLanguage": "pt"` to `system/v2/profile.json` in your vault (`es` Spanish, `fr` French, `it` Italian, `pt` Brazilian Portuguese), then run `node aos.mjs stop` and `node aos.mjs setup --voice yes`, which downloads the speech model for that language (about 460 MB) and starts voice in it. `node aos.mjs doctor` then speaks and listens in that language, and tells you if the setting and the running voice disagree. Two limits: the instant spoken commands ("open …", "stop") are English, so in another language every request takes the slower route through your Claude or Codex model; and a shared speech service run by another program keeps its own language.

**I want Plan Today (or the Intel Brief) to run by itself every morning.** `node aos.mjs schedule add plan-today 07:00 --days weekdays`, then `node aos.mjs schedule` to see what is scheduled, when each runs next and how the last run went. A scheduled run is the same background run the button starts, so its report appears where the button's would. It happens only while the services are running (turn on start-at-login with `node aos.mjs autostart on` if you want it every day), and it uses your Claude or Codex plan the same as pressing the button. If the computer was off at the set time, the run is caught up when the services start, the same day, up to three hours late. `node aos.mjs schedule pause` stops all of them.

**I want replies written, not spoken (shared room, on a call).** Open the voice menu (··· next to the orb in Obsidian, ··· on the Voice card in the HUD) and switch **Spoken replies** off, or run `node aos.mjs voice mute`. Voice still hears you and the shortcut still works; only the sound is skipped. It applies to both screens.

**I want a different voice, or a faster one.** The same menu has **Voice** and **Speed**; you hear a short sample after each change. From a terminal: `node aos.mjs voice use af_heart` and `node aos.mjs voice speed 1.1`. Only voices recorded for your voice language are offered.

**Voice keeps mishearing a name.** Voice listens for the unusual words in the titles of your notes, so a name that appears in a couple of note titles is usually learned by itself (`node aos.mjs voice` shows the list). Teach it one directly with `node aos.mjs voice teach "Zettelkasten"`, and remove one that causes trouble with `node aos.mjs voice forget "<word>"`. The list stays on your computer.

**Voice answers are slow to start.** Without an OpenRouter key every request is routed by your Claude/Codex model (about five seconds). `node aos.mjs jev-key` fixes that. `node aos.mjs doctor` tells you if the key is refused or out of credit. Two speed-ups are on by default: the small model's answer is taken the moment its turn has ended, and speaking starts after the first sentence. If either ever misbehaves, `node aos.mjs voice fast off` turns them off (`--early off` or `--stream off` for one), and `node aos.mjs voice` shows their state. A third is off by default and yours to try with Claude: `node aos.mjs voice fast --prestart on` starts the small model's program the moment a spoken request arrives. On a fast computer it saves about a quarter of a second, and only when your words are ready within two seconds; it may help more on a computer where programs start slowly.

**Claude is "not installed" on Windows although `claude` works in my terminal.** The npm version installs a `.cmd` shim the bridge cannot launch. Install Claude Code with the native installer, open a new terminal, then `node aos.mjs stop` and `node aos.mjs start`.

**Plan Today says the calendar is unavailable.** Connect Google Calendar in your coding tool (Claude Code: `/mcp`; Codex: connector settings), then run it again.

**The calendar is connected and Plan Today still says it is unavailable.** Run `node aos.mjs doctor` and read the **Claude connectors in background work** line. If your computer has a saved `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), a Claude Code started with it gets none of your account's connectors. The system uses your normal Claude sign-in for workflows instead whenever you have one. If the line fails, open a terminal, run `claude`, sign in with `/login`, and run the doctor again. The saved token can stay for your other tools.

**The weekly-usage meter says "unavailable".** Codex: sign in to the Codex CLI once. Claude on Windows: run `claude` once; the meter renews its sign-in by itself afterwards. Claude on Mac: not supported yet. Claude Code keeps its sign-in in the Mac Keychain, which this system does not open; hover the meter to read that, and type `/usage` in Claude Code to see your usage. Everything else works as normal.

**After moving the repository folder.** Run `node aos.mjs autostart off` from the old location first if you can, then `node aos.mjs setup --vault "<path>" --autostart yes` from the new one.

**Uninstall.** `node aos.mjs stop`, `node aos.mjs autostart off`, disable and delete the "Agentic OS V2" plugin in Obsidian, delete this folder. Your vault and its notes are yours and stay untouched; `system/v2/` inside the vault holds only this system's state and can be deleted too.
