import { requestUrl } from "obsidian";

// ---------------------------------------------------------------------------
// Voice sidecar client — ported from jarvis-hud/lib/voiceClient.ts.
// The cockpit doesn't run its own STT/TTS/router; it talks to the two local
// Jarvis servers:
//   - HUD server (Next, :3107): /api/voice (PTT clip), /api/voice/text
//     (wake transcript), /api/speak (Kokoro TTS proxy + config probe)
//   - voice-server (Python, :3108): ws /events (wake word push)
// Obsidian differences vs the HUD original:
//   - HTTP via requestUrl (the Next server sends no CORS headers, and a
//     cross-origin <audio> through an AnalyserNode is silenced anyway)
//   - TTS plays via decodeAudioData + AudioBufferSourceNode so the analyser
//     sees real samples; getLevel() feeds the orb the true RMS envelope
//   - reveal sequencing dropped; deliverables surface via onDeliverable and
//     open natively in Obsidian
// ---------------------------------------------------------------------------

type SpeakingListener = (speaking: boolean) => void;
type LogListener = (cls: string, text: string) => void;
type DeliverableListener = (path: string, open: boolean) => void;
type ListeningListener = (listening: boolean) => void;

export interface VoicePayload {
	transcript: string;
	tier: number;
	skill: string | null;
	queued: string | null;
	reply: string;
	panels?: string[];
	deliverable?: string | null;
	reveal?: string | null;
	obsidian?: ObsidianAction | null;
}

/** UI action the orb executes via the Obsidian API — mirrors the jarvis
 *  router's ObsidianAction type */
export type ObsidianWhere = "tab" | "split" | "right-sidebar" | "left-sidebar";
export type ObsidianAction =
	| { op: "daily-note"; where?: ObsidianWhere }
	| { op: "cockpit" }
	| { op: "open-note"; query: string; where?: ObsidianWhere }
	| { op: "search"; query: string }
	| { op: "command"; id: string; label: string }
	| { op: "web"; url: string; label: string; where?: ObsidianWhere }
	| { op: "repo"; slug: string; where?: ObsidianWhere };

type ObsidianListener = (action: ObsidianAction) => void;

// post-wake utterances that just mean "never mind" — already barged in, drop
const DISMISS_RE =
	/^(stop|cancel|never ?mind|nothing|no|nope|shut up|quiet)[\s.!,]*$/i;

export class VoiceSidecar {
	private hudUrl: string;
	private eventsUrl: string;
	private ctx: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private input: AudioNode | null = null; // head of the sheen chain
	private timeData: Uint8Array | null = null;
	private queue: string[] = [];
	private playing = false;
	private disabled = false; // 503 / unreachable — HUD or voice-server down
	private destroyed = false;
	private speakingListeners = new Set<SpeakingListener>();
	private log: LogListener = () => {};
	private onDeliverableCb: DeliverableListener = () => {};
	private listeningCb: ListeningListener = () => {};
	private onObsidianCb: ObsidianListener = () => {};
	private recorder: MediaRecorder | null = null;
	private micStream: MediaStream | null = null;
	private currentStop: (() => void) | null = null;
	private chunks: BlobPart[] = [];
	private captureStart = 0;
	private wakeWs: WebSocket | null = null;
	private wakeWasUp = false;
	private wakeRetry: ReturnType<typeof setTimeout> | null = null;

	constructor(hudUrl: string, eventsUrl: string) {
		this.hudUrl = hudUrl.replace(/\/$/, "");
		this.eventsUrl = eventsUrl;
	}

	async init(): Promise<void> {
		// config probe — surface a dead sidecar once, up front
		try {
			const res = await requestUrl({
				url: `${this.hudUrl}/api/speak`,
				throw: false,
			});
			if (res.status === 503) {
				this.disabled = true;
				this.log("err", "voice offline — voice-server on :3108 is down");
			} else if (res.status === 200) {
				const engine =
					(res.json as { engine?: string } | undefined)?.engine ?? "kokoro";
				this.disabled = false;
				this.log("ok", `voice link armed — ${engine} · local`);
			}
		} catch {
			this.disabled = true;
			this.log("err", "voice offline — jarvis HUD server on :3107 is down");
		}
		this.connectWake();
	}

	destroy(): void {
		this.destroyed = true;
		this.stop();
		if (this.wakeRetry) clearTimeout(this.wakeRetry);
		this.wakeWs?.close();
		this.wakeWs = null;
		this.micStream?.getTracks().forEach((t) => t.stop());
		this.micStream = null;
		void this.ctx?.close().catch(() => {});
		this.ctx = null;
	}

	get offline(): boolean {
		return this.disabled;
	}

	// --- wake word: voice-server pushes wake/transcript events over WS -------
	private connectWake() {
		if (this.destroyed) return;
		const open = () => {
			if (this.destroyed) return;
			let ws: WebSocket;
			try {
				ws = new WebSocket(this.eventsUrl);
			} catch {
				this.wakeRetry = setTimeout(open, 10_000);
				return;
			}
			this.wakeWs = ws;
			ws.onopen = () => {
				this.wakeWasUp = true;
			};
			ws.onmessage = (ev) => this.handleWakeEvent(String(ev.data));
			ws.onclose = () => {
				this.wakeWs = null;
				if (this.wakeWasUp) {
					this.wakeWasUp = false;
					this.listeningCb(false);
					this.log("sys", "wake word link lost — retrying");
				}
				this.wakeRetry = setTimeout(open, 5000);
			};
			ws.onerror = () => ws.close();
		};
		open();
	}

	private handleWakeEvent(raw: string) {
		let e: { type?: string; text?: string; wake?: boolean };
		try {
			e = JSON.parse(raw) as { type?: string; text?: string; wake?: boolean };
		} catch {
			return;
		}
		if (e.type === "hello") {
			this.log(
				"ok",
				e.wake
					? 'wake word armed — say "hey Jarvis"'
					: "voice link up — push-to-talk only",
			);
		} else if (e.type === "wake") {
			if (this.stop()) this.log("sys", "wake — interrupted");
			this.listeningCb(true);
			// audible cue — with Obsidian minimized (hotkey path) the ring
			// isn't visible, so the ear carries the state change
			// no "listening …" pill — the ring + earcon carry the state; text
			// echo is reserved for repair (voice-UX: response = confirmation)
			this.earcon("listen");
		} else if (e.type === "wake_timeout" || e.type === "wake_error") {
			this.listeningCb(false);
			this.earcon("err");
			if (e.type === "wake_error") this.log("err", "wake capture failed");
		} else if (e.type === "transcript") {
			this.listeningCb(false);
			this.earcon("sent");
			const text = (e.text ?? "").trim();
			if (!text) return;
			if (DISMISS_RE.test(text)) {
				this.log("sys", `you · ${text} — dismissed`);
				return;
			}
			void this.dispatchText(text);
		}
	}

	async dispatchText(transcript: string): Promise<void> {
		try {
			const res = await requestUrl({
				url: `${this.hudUrl}/api/voice/text`,
				method: "POST",
				contentType: "application/json",
				body: JSON.stringify({ transcript }),
				throw: false,
			});
			this.handleVoiceResponse(res.status, res.json as VoicePayload);
		} catch (e) {
			this.log("err", `voice command failed: ${String(e).slice(0, 120)}`);
		}
	}

	onSpeaking(cb: SpeakingListener): () => void {
		this.speakingListeners.add(cb);
		return () => this.speakingListeners.delete(cb);
	}

	onLog(cb: LogListener) {
		this.log = cb;
	}

	/** fires when a reply references a vault document; open=true → open now */
	onDeliverable(cb: DeliverableListener) {
		this.onDeliverableCb = cb;
	}

	/** fires when the wake word opens/closes a hands-free listening window */
	onListening(cb: ListeningListener) {
		this.listeningCb = cb;
	}

	/** fires when a reply carries an Obsidian UI action for the orb */
	onObsidian(cb: ObsidianListener) {
		this.onObsidianCb = cb;
	}

	/** short state-change earcon — silence past a beat reads as "crashed".
	 *  listen: rising blip · sent: falling blip · ok: two-note chirp ·
	 *  err: low buzz */
	earcon(kind: "listen" | "sent" | "ok" | "err") {
		this.ensureGraph();
		const ctx = this.ctx;
		if (!ctx) return;
		void ctx.resume().catch(() => {});
		const t0 = ctx.currentTime;
		const gain = ctx.createGain();
		gain.gain.value = 0.0001;
		gain.connect(ctx.destination);
		const osc = ctx.createOscillator();
		osc.type = kind === "err" ? "square" : "sine";
		const notes: [number, number][] =
			kind === "listen"
				? [[660, 0], [880, 0.07]]
				: kind === "sent"
					? [[880, 0], [660, 0.07]]
					: kind === "ok"
						? [[740, 0], [1108, 0.09]]
						: [[180, 0]];
		for (const [freq, at] of notes) osc.frequency.setValueAtTime(freq, t0 + at);
		const dur = kind === "err" ? 0.22 : 0.16;
		gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02);
		gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
		osc.connect(gain);
		osc.start(t0);
		osc.stop(t0 + dur + 0.02);
		osc.addEventListener("ended", () => {
			osc.disconnect();
			gain.disconnect();
		});
	}

	speak(text: string) {
		const clean = sanitize(text);
		if (!clean || this.disabled) return;
		this.queue.push(clean);
		void this.drain();
	}

	/** kill the current utterance AND everything queued behind it */
	stop(): boolean {
		const wasTalking = this.playing || this.queue.length > 0;
		this.queue = [];
		this.currentStop?.();
		return wasTalking;
	}

	/** real speech envelope, 0..1 — null when no audio is playing */
	getLevel = (): number | null => {
		if (!this.playing || !this.analyser || !this.timeData) return null;
		this.analyser.getByteTimeDomainData(this.timeData);
		let sum = 0;
		for (let i = 0; i < this.timeData.length; i++) {
			const d = (this.timeData[i]! - 128) / 128;
			sum += d * d;
		}
		const rms = Math.sqrt(sum / this.timeData.length);
		return Math.min(rms * 3.2, 1); // speech RMS ~0..0.3 → usable 0..1
	};

	/** begin PTT recording; resolves false if mic unavailable or voice offline */
	async startCapture(): Promise<boolean> {
		if (this.disabled) {
			this.log("err", "voice offline — start the jarvis sidecar first");
			return false;
		}
		if (this.recorder) return true;
		this.stop(); // barge-in: opening the mic shuts Jarvis up
		try {
			// keep the stream alive between captures — re-acquiring adds ~200ms
			if (!this.micStream) {
				this.micStream = await navigator.mediaDevices.getUserMedia({
					audio: true,
				});
			}
		} catch {
			this.log("err", "microphone access denied");
			return false;
		}
		this.chunks = [];
		this.recorder = new MediaRecorder(this.micStream);
		this.recorder.addEventListener("dataavailable", (e) => {
			if (e.data.size > 0) this.chunks.push(e.data);
		});
		this.recorder.start();
		this.captureStart = performance.now();
		return true;
	}

	/** stop recording, ship the clip through STT → router, speak the reply */
	async finishCapture(): Promise<void> {
		const rec = this.recorder;
		if (!rec) return;
		this.recorder = null;
		const heldMs = performance.now() - this.captureStart;
		await new Promise<void>((res) => {
			rec.addEventListener("stop", () => res(), { once: true });
			rec.stop();
		});
		const blob = new Blob(this.chunks, { type: rec.mimeType || "audio/webm" });
		this.chunks = [];
		if (heldMs < 350 || blob.size < 1000) return; // accidental tap

		this.earcon("sent"); // audible "got it" — no text pill while working
		try {
			const res = await requestUrl({
				url: `${this.hudUrl}/api/voice`,
				method: "POST",
				contentType: blob.type,
				body: await blob.arrayBuffer(),
				throw: false,
			});
			this.handleVoiceResponse(res.status, res.json as VoicePayload);
		} catch (e) {
			this.log("err", `voice command failed: ${String(e).slice(0, 120)}`);
		}
	}

	/** shared tail of both voice paths (PTT clip + wake transcript) */
	private handleVoiceResponse(status: number, j: VoicePayload | undefined) {
		if (status === 503) {
			this.disabled = true;
			this.log("err", "voice offline — TTS unavailable");
			return;
		}
		if (status !== 200 || !j) {
			this.log("err", `voice command failed: ${status}`);
			return;
		}
		// transcript echo ONLY for repair — when nothing actionable came back,
		// show what was heard so a mis-transcription is diagnosable. On
		// success the reply/action IS the confirmation (voice-UX practice).
		if (j.queued && j.skill) this.log("sys", `intent queued → ${j.skill}`);
		if (j.obsidian) this.onObsidianCb(j.obsidian);
		if (j.deliverable) {
			this.onDeliverableCb(j.deliverable, j.reveal === "open");
		}
		if (j.reply) {
			this.log("ok", `jarvis · ${j.reply}`);
			this.speak(j.reply);
		} else if (!j.queued && !j.obsidian && !j.deliverable) {
			this.log("sys", `heard "${j.transcript ?? "?"}" — nothing to do`);
		}
	}

	private ensureGraph() {
		if (this.ctx) return;
		this.ctx = new AudioContext();
		this.analyser = this.ctx.createAnalyser();
		this.analyser.fftSize = 1024;
		this.analyser.smoothingTimeConstant = 0.4;
		this.timeData = new Uint8Array(this.analyser.fftSize);
		this.analyser.connect(this.ctx.destination);

		// "sheen" chain — the Jarvis-in-the-suit timbre: highpass strips
		// sub-rumble, presence peak lifts intelligibility, short convolution
		// reverb at low wet adds the helmet-metal air. Analyser sits after
		// the mix so the orb mouths what's actually heard.
		const hp = this.ctx.createBiquadFilter();
		hp.type = "highpass";
		hp.frequency.value = 90;
		const presence = this.ctx.createBiquadFilter();
		presence.type = "peaking";
		presence.frequency.value = 3200;
		presence.gain.value = 2.5;
		presence.Q.value = 0.8;
		const dry = this.ctx.createGain();
		dry.gain.value = 1.0;
		const conv = this.ctx.createConvolver();
		conv.buffer = makeImpulse(this.ctx, 0.18, 2.8);
		const wet = this.ctx.createGain();
		wet.gain.value = 0.12;

		hp.connect(presence);
		presence.connect(dry);
		dry.connect(this.analyser);
		presence.connect(conv);
		conv.connect(wet);
		wet.connect(this.analyser);
		this.input = hp;
	}

	private setSpeaking(on: boolean) {
		this.playing = on;
		this.speakingListeners.forEach((cb) => cb(on));
	}

	private async drain() {
		if (this.playing || this.queue.length === 0 || this.disabled) return;
		const text = this.queue.shift()!;
		this.ensureGraph();
		this.setSpeaking(true);
		try {
			await this.playOne(text);
		} catch (e) {
			this.log("err", `voice playback failed: ${String(e).slice(0, 120)}`);
		}
		this.setSpeaking(false);
		void this.drain();
	}

	private async playOne(text: string): Promise<void> {
		const ctx = this.ctx!;
		await ctx.resume().catch(() => {});
		const url = `${this.hudUrl}/api/speak?text=${encodeURIComponent(text)}`;
		// streaming first — Kokoro sentence-chunks the WAV so playback starts
		// after the first sentence. Needs the CORS headers the jarvis server
		// now sends; if anything trips, fall back to full-buffer decode.
		try {
			await this.playStreaming(ctx, url);
		} catch {
			await this.playBuffered(ctx, url);
		}
	}

	private playStreaming(ctx: AudioContext, url: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const audio = new Audio();
			// without crossOrigin + server CORS headers the analyser reads
			// zeros and the orb goes dead-mouthed
			audio.crossOrigin = "anonymous";
			audio.preload = "auto";
			audio.src = url;
			const src = ctx.createMediaElementSource(audio);
			src.connect(this.input ?? this.analyser!);
			let settled = false;
			let started = false;
			audio.addEventListener("playing", () => (started = true), {
				once: true,
			});
			const finish = (err?: Error) => {
				if (settled) return;
				settled = true;
				this.currentStop = null;
				try {
					src.disconnect();
				} catch {}
				// an error AFTER audio started must NOT reject — the buffered
				// fallback would replay the utterance from the top over the
				// tail of this one (heard as garbled/doubled speech)
				if (err && !started) reject(err);
				else resolve();
			};
			// stop() = barge-in — resolve (not reject) so drain continues clean
			this.currentStop = () => {
				audio.pause();
				audio.removeAttribute("src");
				finish();
			};
			audio.addEventListener("ended", () => finish(), { once: true });
			audio.addEventListener(
				"error",
				() => finish(new Error("audio element error")),
				{ once: true },
			);
			audio.play().catch((e) => finish(e as Error));
		});
	}

	/** fallback: full-buffer fetch via requestUrl (immune to CORS), decode,
	 *  play through the sheen chain */
	private async playBuffered(ctx: AudioContext, url: string): Promise<void> {
		const res = await requestUrl({ url, throw: false });
		if (res.status !== 200) throw new Error(`speak ${res.status}`);
		const buf = await ctx.decodeAudioData(res.arrayBuffer.slice(0));
		await new Promise<void>((resolve) => {
			const src = ctx.createBufferSource();
			src.buffer = buf;
			src.connect(this.input ?? this.analyser!);
			const done = () => {
				this.currentStop = null;
				try {
					src.disconnect();
				} catch {}
				resolve();
			};
			this.currentStop = () => {
				try {
					src.stop();
				} catch {}
				done();
			};
			src.addEventListener("ended", done, { once: true });
			src.start();
		});
	}
}

// short noise-burst impulse response — a tiny metallic room, decays fast
function makeImpulse(
	ctx: AudioContext,
	seconds: number,
	decay: number,
): AudioBuffer {
	const rate = ctx.sampleRate;
	const len = Math.floor(rate * seconds);
	const buf = ctx.createBuffer(2, len, rate);
	for (let ch = 0; ch < 2; ch++) {
		const data = buf.getChannelData(ch);
		for (let i = 0; i < len; i++) {
			data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
		}
	}
	return buf;
}

// keep speech clean: markdown, urls, and code noise read terribly
function sanitize(text: string): string {
	return text
		.replace(/https?:\/\/\S+/g, "")
		.replace(/[*_`#>|]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 800); // briefing replies run long; /api/speak caps at 900
}
