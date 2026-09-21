import {ProviderUsage} from './ProviderUsage';
import {MetricCard} from './MetricCard';
import {LatestVideoCard} from './LatestVideoCard';
import { h, Fragment } from "preact";
import { Notice } from "obsidian";
import type ChaseCommandCenter from "../main";
import type { MetricSnapshot } from "../lib/metrics";
import type { DailyNoteRead } from "../lib/vault";
import { toggleTaskByText } from "../lib/vault-writer";
import type { LatestVideo } from "../lib/youtube";
import { useProvider } from "../lib/provider";
import { ActionBar } from "./ActionBar";

// Glass console — faithful implementation of design 6b ("glass in a dark
// chassis"): lit ivory panes carry figures, smoked panes carry lists. This
// component renders the OVERVIEW content rows only; the chassis, backdrop,
// header, and tabs live in Cockpit so every tab shares them.

interface Props {
	plugin: ChaseCommandCenter;
	snapshots: Map<string, MetricSnapshot> | null;
	daily: DailyNoteRead | null;
	latestVideo: LatestVideo | null;
	onSubmitted?: () => void;
}

// four channel tiles — same sources as the terminal theme's CARDS; tone
// drives the tinted platform stamp pressed into the ivory
const TILES: { key: string; label: string; tone: "youtube" | "instagram" | "tiktok" }[] = [
	{ key: "youtube:subscribers", label: "YouTube subs", tone: "youtube" },
	{ key: "youtube:views_28d", label: "YT views · 28d", tone: "youtube" },
	{ key: "instagram:followers", label: "Instagram", tone: "instagram" },
	{ key: "tiktok:followers", label: "TikTok", tone: "tiktok" },
];

export function GlassConsole({
	plugin,
	snapshots,
	daily,
	latestVideo,
	onSubmitted,
}: Props) {
	const providerState = useProvider(plugin.app);

	const toggleTask = async (text: string) => {
		if (!daily) return;
		const ok = await toggleTaskByText(plugin.app, daily.path, "Daily Drivers", text);
		if (!ok) new Notice(`Could not toggle: ${text}`);
	};

	const tasks = daily?.drivers ?? [];
	const tasksDone = tasks.filter((t) => t.done).length;
	const schedule = daily?.schedule ?? [];

	return (
		<>
			{/* Shared terminal summary components, dressed in Glass materials. */}
			<div className="aos-v2-row aos-v2-row--hero">
				<section className="aos-v2-pane aos-v2-pane--lit aos-v2-pane--hero"><ProviderUsage provider={providerState.selection.provider}/></section>
			</div>
			<div className="aos-v2-row aos-v2-row--stats">
				{TILES.map(t=><MetricCard key={t.key} label={t.label} snapshot={snapshots?.get(t.key)??null} format="compact" tone={t.tone}/>)}
			</div>
			<div className="aos-v2-row aos-v2-row--upload"><LatestVideoCard video={latestVideo}/></div>

			{/* keys — one-tap agent runs */}
			<ActionBar plugin={plugin} appearance="glass" onSubmitted={onSubmitted}/>

			{/* lists — schedule + tasks, both smoked */}
			<div className="aos-v2-row aos-v2-row--lists">
				<section className="aos-v2-pane aos-v2-pane--dark">
					<div className="aos-v2-pane-head">
						<span className="aos-v2-label">Today</span>
					</div>
					<div className="aos-v2-list aos-v2-list--cols">
						{schedule.length === 0 ? (
							<div className="aos-v2-empty">nothing scheduled</div>
						) : (
							schedule.map((s, i) => (
								<div key={`${i}-${s.time}`} className="aos-v2-list-row">
									<span className="aos-v2-time">{s.time}</span>
									<span className="aos-v2-body">{s.title}</span>
								</div>
							))
						)}
					</div>
				</section>
				<section className="aos-v2-pane aos-v2-pane--dark">
					<div className="aos-v2-pane-head">
						<span className="aos-v2-label">Tasks</span>
						<span className="aos-v2-label">
							{tasksDone}/{tasks.length}
						</span>
					</div>
					<div className="aos-v2-list">
						{tasks.length === 0 ? (
							<div className="aos-v2-empty">no tasks yet</div>
						) : (
							tasks.map((t, i) => (
								<button
									key={`${i}-${t.text}`}
									type="button"
									className={`aos-v2-list-row aos-v2-task ${t.done ? "aos-v2-task--done" : ""}`}
									onClick={() => void toggleTask(t.text)}
								>
									<span
										className={`aos-v2-check ${t.done ? "aos-v2-check--done" : ""}`}
										aria-hidden="true"
									/>
									<span className="aos-v2-body">{t.text}</span>
								</button>
							))
						)}
					</div>
				</section>
			</div>
		</>
	);
}
