# Mac voice shortcut

When setup installs this system's own voice service, it also enables **Control–Option–J**. No separate Shortcuts app, keyboard utility or package is required. It runs while the voice service is running, including after login if you chose autostart.

Press the shortcut once, wait for the listening cue, and speak. About 1.6 seconds of silence ends recording and sends your request to the provider selected in the cockpit. There is no need to hold the keys or press them again. Recording also ends after 20 seconds, or after about 5 seconds if no speech is heard.

Keep Obsidian running with the Agentic OS orb enabled; its window can be behind another app. Alternatively, keep the Jarvis HUD visible and click it once to allow browser audio playback. A hidden HUD alone or closed cockpit cannot receive the request. A shared speech service belongs to its own application and keeps that application's shortcut behavior.

## Finish setup with a real microphone test

Run these commands from the installation you intend to use. If **Voice service healthy** reports a shared service, that other program owns voice and its shortcut. Record the shortcut check as **SKIP — shared service**, and leave that service running. Do not stop it, change its port, or start a second installation to force this test; ports 3217–3221 have one installation owner. A handoff needs the owner's agreement and that installation's own stop/start scripts.

1. Run `node aos.mjs status` and `node aos.mjs doctor`. **Global voice shortcut** checks registration; it does not record audio or prove microphone access.
2. Open the Obsidian cockpit, leave the orb enabled, then put another app such as TextEdit in front. Use your physical keyboard for this check, rather than a scripted keypress or the HUD microphone button.
3. Press and release **Control–Option–J** once. Wait for the listening cue. If macOS asks for microphone access, check the named application before allowing it, then repeat the press if needed. This route records through the local Python speech service; browser or Obsidian permission alone does not prove it can record. For a denial, review that named application under **System Settings → Privacy & Security → Microphone**. [Apple's microphone permission guide](https://support.apple.com/guide/mac-help/control-access-to-the-microphone-on-mac-mchla1b1e1fe/mac).
4. Say “What is two plus two?” and pause. Confirm recording stops after the silence, exactly one request appears in the cockpit, and you hear one reply. Repeat once with the other app still in front to check the shortcut works again after releasing it.
5. If you already enabled autostart, repeat after your next normal login. Before manually starting any services, run `node aos.mjs status` and `node aos.mjs doctor`; then open the cockpit and repeat steps 2–4. Do not log out automatically or change autostart just for this check. If login has not been checked yet, say so separately from the working shortcut test.

When reporting a result, include the macOS version, keyboard layout and foreground app, the exact doctor shortcut line, and what happened at each step: listening cue, silence stop, one request, audible reply, and second press. Record **PASS** for what you observed, **FAIL** with the exact displayed error or behavior for an attempted check that failed, and **NOT CHECKED** for anything you did not attempt. Note whether microphone permission was already granted, newly allowed or denied; record the login result separately. Share no keys, credential files or private transcripts.

## If the shortcut does not respond

- Check `node aos.mjs doctor`. For this installation's own service, the `hotkey` and `capture` fields are at `http://127.0.0.1:3220/health`; a shared service may use another address reported by doctor. A registered shortcut and microphone access are different checks.
- A registration conflict means another app owns the combination. Release that app's assignment before restarting Agentic OS when no tasks are open. Do not add a second keyboard utility for the same combination.
- Keep the Obsidian orb enabled or the HUD visible. Services running alone are insufficient; the cockpit handles the request and reply.
- The Mac shortcut uses the physical ANSI J key position. On a different keyboard layout, the printed character may differ.
- The HUD microphone button remains available if global registration fails.

The listener registers only its own shortcut with macOS. It does not install a general keyboard monitor or need Accessibility/Input Monitoring permission. A helper process owns the Mac event loop and exits with the speech service. Microphone access is requested only when recording begins.

For developers: the existing `VOICE_HOTKEY` environment setting still supports modifiers plus one ASCII letter/digit, or `off`. It must reach the speech process at launch. Setting it in a terminal does not change an already-running process or persist it in the login item; this install flow enables the default combination. Do not describe a temporary environment override as a saved preference.
