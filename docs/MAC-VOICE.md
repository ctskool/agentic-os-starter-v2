# Mac voice shortcut

When setup installs this system's own voice service, it also enables **Control–Option–J**. No separate Shortcuts app, keyboard utility or package is required. It runs while the voice service is running, including after login if you chose autostart.

Press the shortcut once, wait for the listening cue, and speak. About 1.6 seconds of silence ends recording and sends your request to the provider selected in the cockpit. There is no need to hold the keys or press them again. Recording also ends after 20 seconds, or after about 5 seconds if no speech is heard.

Keep Obsidian running with the Agentic OS orb enabled; its window can be behind another app. Alternatively, keep the Jarvis HUD visible and click it once to allow browser audio playback. A hidden HUD alone or closed cockpit cannot receive the request. A shared speech service belongs to its own application and keeps that application's shortcut behavior.

## Finish setup with a real microphone test

1. Run `node aos.mjs doctor`. **Global voice shortcut** checks registration; it does not record audio or prove microphone access.
2. Open the Obsidian cockpit and leave the orb enabled. Put another app in front.
3. Press **Control–Option–J** and say a harmless request, such as “What is two plus two?” Pause, then confirm recording ends, one request appears, and you hear a reply.
4. If macOS asks to use the microphone, allow the voice process identified by that prompt. The shortcut records through the local Python speech service, so browser or Obsidian permission alone does not prove that this route can record. Review the named application under **System Settings → Privacy & Security → Microphone** if recording is denied. [Apple's microphone permission guide](https://support.apple.com/guide/mac-help/control-access-to-the-microphone-on-mac-mchla1b1e1fe/mac).
5. If autostart is enabled, repeat after your next normal login. Report this as a separate hands-on check, not something a build or CI has established.

## If the shortcut does not respond

- Check `node aos.mjs doctor` and the voice service's `hotkey` and `capture` fields at `http://127.0.0.1:3220/health`. A registered shortcut and microphone access are different checks.
- A registration conflict means another app owns the combination. Release that app's assignment before restarting Agentic OS when no tasks are open. Do not add a second keyboard utility for the same combination.
- Keep the Obsidian orb enabled or the HUD visible. Services running alone are insufficient; the cockpit handles the request and reply.
- The Mac shortcut uses the physical ANSI J key position. On a different keyboard layout, the printed character may differ.
- The HUD microphone button remains available if global registration fails.

The listener registers only its own shortcut with macOS. It does not install a general keyboard monitor or need Accessibility/Input Monitoring permission. A helper process owns the Mac event loop and exits with the speech service. Microphone access is requested only when recording begins.

For developers: the existing `VOICE_HOTKEY` environment setting still supports modifiers plus one ASCII letter/digit, or `off`. It must reach the speech process at launch. Setting it in a terminal does not change an already-running process or persist it in the login item; this install flow enables the default combination. Do not describe a temporary environment override as a saved preference.
