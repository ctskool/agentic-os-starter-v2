import {ProviderUsage} from './ProviderUsage';
import {openWork} from '../lib/work';
import { h, Fragment } from "preact";
import { useEffect, useState, useCallback, useRef } from "preact/hooks";
import type ChaseCommandCenter from "../main";
import {
	readMetricsCsv,
	invalidateMetrics,
	snapshotByKey,
	type MetricSnapshot,
} from "../lib/metrics";
import {
	readDailyNote,
	todayPath,
	SUPPORTED_SCHEMA_VERSION,
	type DailyNoteRead,
} from "../lib/vault";
import { invalidateRecentRuns, listRecentRuns, type RunRecord } from "../lib/queue";
import {
	readRunnerStatus,
	readLastPull,
	nextPullDelta,
	runnerIsOnline,
	humanDuration,
	latestPullTs,
	type RunnerStatus,
	type LastPullSnapshot,
} from "../lib/status";
import { readLatestVideo, type LatestVideo } from "../lib/youtube";
import { MetricCard } from "./MetricCard";
import { LatestVideoCard } from "./LatestVideoCard";
import { ScheduleList } from "./ScheduleList";
import { DailyDriversChecklist } from "./DailyDriversChecklist";
import { GithubTrendingCard } from "./GithubTrendingCard";
import { HackerNewsCard } from "./HackerNewsCard";
import { OutlierRadarCard } from "./OutlierRadarCard";
import { ContentAnglesCard } from "./ContentAnglesCard";
import { YtWeekReviewCard } from "./YtWeekReviewCard";
import { MorningBriefCard } from "./MorningBriefCard";
import { MorningHeadlinesCard } from "./MorningHeadlinesCard";
import { ActionBar } from "./ActionBar";
import { ActivityFeed } from "./ActivityFeed";
import { ProviderPanel } from "./ProviderPanel";
import { ProviderBackdrop } from "./ProviderBackdrop";
import { useProvider } from "../lib/provider";
import { GlassConsole } from "./GlassConsole";
import type { CockpitTheme } from "../settings";

interface Props {
	plugin: ChaseCommandCenter;
}

type Tab = "overview" | "audience" | "research";

type Tone = "youtube" | "instagram" | "tiktok" | "neutral";

interface CardSpec {
	key: string;
	label: string;
	format: "currency" | "integer" | "compact" | "percent";
	tabs: Tab[];
	hero?: boolean;
	tone?: Tone;
}

const CARDS: CardSpec[] = [
	{ key: "youtube:subscribers", label: "YouTube Subs", format: "integer", tabs: ["overview", "audience"], tone: "youtube" },
	{ key: "youtube:views_28d", label: "YouTube Views", format: "integer", tabs: ["overview", "audience"], tone: "youtube" },
	{ key: "instagram:followers", label: "Instagram", format: "integer", tabs: ["overview", "audience"], tone: "instagram" },
	{ key: "tiktok:followers", label: "TikTok", format: "integer", tabs: ["overview", "audience"], tone: "tiktok" },
];


export function Cockpit({ plugin }: Props) {
	const providerState = useProvider(plugin.app);
	const [snapshots, setSnapshots] = useState<Map<string, MetricSnapshot> | null>(null);
	const [daily, setDaily] = useState<DailyNoteRead | null>(null);
	const [runs, setRuns] = useState<RunRecord[]>([]);
	const [runner, setRunner] = useState<RunnerStatus | null>(null);
	const [lastPull, setLastPull] = useState<LastPullSnapshot | null>(null);
	const [latestVideo, setLatestVideo] = useState<LatestVideo | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<Tab>("overview");
	const [theme, setTheme] = useState<CockpitTheme>(plugin.settings.theme);
	const [narrow, setNarrow] = useState(false);
	const shellRef = useRef<HTMLDivElement | null>(null);

	// other cockpit instances (e.g. the sidebar copy) flip instantly too —
	// applyTheme() stamps the view-root attr; this event syncs preact state
	useEffect(() => {
		const sync = () => setTheme(plugin.settings.theme);
		window.addEventListener("aos-v2-cc-theme", sync);
		return () => window.removeEventListener("aos-v2-cc-theme", sync);
	}, [plugin]);

	// sidebar variant — driven by real width, not leaf location
	useEffect(() => {
		const el = shellRef.current;
		if (!el) return;
		const ro = new ResizeObserver((entries) => {
			const w = entries[0]?.contentRect.width ?? 0;
			if (w > 0) setNarrow(w < 560);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const switchTheme = async (t: CockpitTheme) => {
		plugin.settings.theme = t;
		await plugin.saveSettings();
		plugin.applyTheme();
		window.dispatchEvent(new Event("aos-v2-cc-theme"));
	};

	const refreshing = useRef(false);
	const refresh = useCallback(async () => {
        if (refreshing.current || document.hidden || !shellRef.current?.getClientRects().length) return;
        refreshing.current = true;
		try {
			const [rows, dn, recentRuns, rs, lp, lv] = await Promise.all([
				readMetricsCsv(plugin.app),
				readDailyNote(plugin.app, todayPath()),
				// Over-fetch so dismissals don't shrink the visible feed below 8.
				listRecentRuns(plugin.app, 32),
				readRunnerStatus(plugin.app),
				readLastPull(plugin.app),
				readLatestVideo(plugin.app),
			]);
			setSnapshots(snapshotByKey(rows));

			setDaily(dn);
			const dismissed = new Set(plugin.settings.dismissedRunIds || []);
			setRuns(recentRuns.filter((r) => !dismissed.has(r.id)).slice(0, 8));
			setRunner(rs);
			setLastPull(lp);
			setLatestVideo(lv);
			setError(null);
		} catch (e) {
			setError(String(e));
		} finally { refreshing.current = false; }
	}, [plugin]);

	useEffect(() => {
		refresh();
		const handler = (file: { path: string }) => {
			if(file.path === "system/metrics/metrics.csv")invalidateMetrics(plugin.app);
			if(file.path.startsWith("system/v2/runs/"))invalidateRecentRuns(plugin.app);
			if (
				file.path === "system/metrics/metrics.csv" ||
				file.path === "system/metrics/latest-video.json" ||
				file.path === todayPath() ||
				file.path.startsWith("system/v2/runs/") || file.path === "system/metrics/last-pull.json"
			) {
				void refresh();
			}
		};
		plugin.app.vault.on("modify", handler);
		plugin.app.vault.on("create", handler);
		plugin.app.vault.on("delete", handler);

		const cacheHandler = (file: { path: string }) => {
			if (file.path === todayPath()) void refresh();
		};
		plugin.app.metadataCache.on("changed", cacheHandler);

		// Periodic poll for relative-time freshness + safety net.
		const interval = window.setInterval(() => void refresh(), 3_000);

		return () => {
			plugin.app.vault.off("modify", handler);
			plugin.app.vault.off("create", handler);
			plugin.app.vault.off("delete", handler);
			plugin.app.metadataCache.off("changed", cacheHandler);
			window.clearInterval(interval);
		};
	}, [plugin, refresh]);

	const visibleCards = CARDS.filter((c) => c.tabs.includes(tab));
	const dailyMissing = daily === null;
	const dailyUnsupported = daily !== null && !daily.supported;

	const runnerBusy =
		runner?.busy === true || (runner?.pending != null && runner.pending > 0);

	const glass = theme === "glass";

	return (
		<div
			ref={shellRef}
			className={
				glass
					? "aos-v2-root v2-dashboard"
					: `aos-v2-cc-shell v2-dashboard ${runnerBusy ? "aos-v2-cc-shell--busy" : ""}`
			}
			data-provider={providerState.selection.provider}
			data-width={glass && narrow ? "sidebar" : undefined}
			data-cheap={glass && plugin.settings.reduceBlur ? "true" : undefined}
		>
		<ProviderBackdrop plugin={plugin} busy={runnerBusy} active={providerState.selection.provider === "codex"} />
		<div className={glass ? "aos-v2-backdrop" : "aos-v2-cc-passthru"}>
		<div className={glass ? "aos-v2-chassis" : "aos-v2-cc-passthru"}>
			<header className="aos-v2-cc-header">
				<span className="aos-v2-cc-heartbeat" aria-hidden="true">
					<svg viewBox="0 0 24 12" width="32" height="16">
						<path
							d="M0 6 H6 L8 2 L10 10 L12 4 L14 8 L16 6 H24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="square"
						/>
					</svg>
				</span>
				<h1 className="aos-v2-cc-title">AGENTIC OS <small>V2</small></h1>
				<span className="aos-v2-cc-status">
					{error ? "ERROR" : snapshots ? "CONNECTED VAULT" : "BOOT"}
				</span>
				<ProviderPanel plugin={plugin} state={providerState} busy={runnerBusy} />
                <button className="aos-v2-cc-themebtn" onClick={()=>openWork()}>Terminals</button>
				<div className="aos-v2-cc-themebar" role="group" aria-label="theme">
					{(["terminal", "glass"] as CockpitTheme[]).map((t) => (
						<button
							key={t}
							type="button"
							className={`aos-v2-cc-themebtn ${
								theme === t ? "aos-v2-cc-themebtn--active" : ""
							}`}
							onClick={() => void switchTheme(t)}
							title={`switch to ${t} theme`}
						>
							{t}
						</button>
					))}
				</div>
				<button
					className="aos-v2-cc-refresh"
					type="button"
					onClick={() => { invalidateMetrics(plugin.app); invalidateRecentRuns(plugin.app); void refresh(); }}
					title="refresh"
				>
					↻
				</button>
			</header>

			<nav className="aos-v2-cc-tabs">
				{(["overview", "audience", "research"] as Tab[]).map((t) => (
					<button
						key={t}
						type="button"
						className={`aos-v2-cc-tab ${t === tab ? "aos-v2-cc-tab-active" : ""}`}
						onClick={() => setTab(t)}
					>
						{t}
					</button>
				))}
			</nav>

			{error ? (
				<section className="aos-v2-cc-placeholder aos-v2-cc-error-box">
					<p className="aos-v2-cc-mono">&gt; read failed</p>
					<p className="aos-v2-cc-mono aos-v2-cc-dim">{error}</p>
				</section>
			) : glass && tab === "overview" ? (
				<GlassConsole
					plugin={plugin}
					snapshots={snapshots}
					daily={dailyMissing || dailyUnsupported ? null : daily}
					latestVideo={latestVideo}
					onSubmitted={() => void refresh()}
				/>
			) : (
				<>
					{tab === "overview" && <ProviderUsage provider={providerState.selection.provider}/> }

					<section className="aos-v2-cc-card-row">
						{visibleCards.map((c) => (
							<MetricCard
								key={c.key}
								label={c.label}
								snapshot={snapshots?.get(c.key) ?? null}
								format={c.format}
								hero={c.hero}
								tone={c.tone}
							/>
						))}
					</section>
					{tab !== "research" && (
						<section className="aos-v2-cc-latest-row">
							<LatestVideoCard video={latestVideo} />
						</section>
					)}
				</>
			)}

			{/* glass overview carries its own key row — no double action bar */}
			{glass && tab === "overview" ? null : (
				<ActionBar plugin={plugin} onSubmitted={() => void refresh()} />
			)}

			{dailyMissing ? (
				<section className="aos-v2-cc-placeholder">
					<p className="aos-v2-cc-mono aos-v2-cc-dim">
						&gt; no daily note at {todayPath()}
					</p>
					<p className="aos-v2-cc-mono aos-v2-cc-dim">
						click "Open Today" above or run /today
					</p>
				</section>
			) : dailyUnsupported ? (
				<section className="aos-v2-cc-placeholder aos-v2-cc-error-box">
					<p className="aos-v2-cc-mono">
						&gt; unsupported schema_version: {daily!.schemaVersion}
					</p>
					<p className="aos-v2-cc-mono aos-v2-cc-dim">
						plugin supports v{SUPPORTED_SCHEMA_VERSION}. update template or bump
						parser.
					</p>
				</section>
			) : (
				<>
					{tab === "overview" && !glass ? (
						<section className="aos-v2-cc-day-grid">
							<ScheduleList app={plugin.app} entries={daily!.schedule} />
							<DailyDriversChecklist
								app={plugin.app}
								path={todayPath()}
								items={daily!.drivers}
							/>
						</section>
					) : null}
					{tab === "research" ? (
						<section className="aos-v2-cc-day-grid">
							<GithubTrendingCard app={plugin.app} limit={5} />
							{/* right column: intel-driven stack — outlier signal on
							    top, the So-What angles, live HN compact below */}
							<div className="aos-v2-cc-stack">
								<OutlierRadarCard app={plugin.app} limit={6} />
								<ContentAnglesCard app={plugin.app} limit={4} />
								<p className="aos-v2-cc-dim">External research connectors are not connected.</p>
							</div>
						</section>
					) : null}
				</>
			)}

			{tab === "overview" ? <MorningHeadlinesCard app={plugin.app} /> : null}
			{tab === "audience" ? <YtWeekReviewCard app={plugin.app} /> : null}
			{tab === "research" ? <MorningBriefCard app={plugin.app} /> : null}

			<ActivityFeed
				app={plugin.app}
				runs={runs}
				onDismiss={async (ids: string[]) => {
					const cur = new Set(plugin.settings.dismissedRunIds || []);
					ids.forEach((id) => cur.add(id));
					// Cap at 200 entries — covers ~25 cockpit-fills before rollover.
					plugin.settings.dismissedRunIds = Array.from(cur).slice(-200);
					await plugin.saveSettings();
					void refresh();
				}}
			/>

			<footer className="aos-v2-cc-footer">
				{(() => {
					const online = runnerIsOnline(runner);
					const next = nextPullDelta(
						lastPull,
						plugin.settings.metricsPullCadenceHours,
					);
					const lastTs = latestPullTs(lastPull);
					const lastAgo =
						lastTs !== null
							? humanDuration(Date.now() - Date.parse(lastTs))
							: "—";
					return (
						<span className="aos-v2-cc-mono aos-v2-cc-dim aos-v2-cc-footer-line">
							<span
								className={
									online
										? "aos-v2-cc-foot-online"
										: "aos-v2-cc-foot-offline"
								}
								title={
									runner
										? `pid ${runner.pid} · ts ${runner.ts}`
										: "no heartbeat"
								}
							>
								● terminals {online ? "online" : "offline"}
								{online && runner?.busy
									? ` (${runner.active ?? "?"} sessions${
											runner.pending ? ` · ${runner.pending} queued` : ""
									  })`
									: online && runner?.pending
									  ? ` (${runner.pending} queued)`
									  : ""}
							</span>
							<span className="aos-v2-cc-foot-sep">·</span>
							<span title={lastTs || ""}>last pull {lastAgo} ago</span>
							<span className="aos-v2-cc-foot-sep">·</span>
							<span>
								next{" "}
								{next
									? next.overdue
										? `overdue ${humanDuration(-next.ms)}`
										: `in ${humanDuration(next.ms)}`
									: "—"}
							</span>
							<span className="aos-v2-cc-cursor">█</span>
						</span>
					);
				})()}
			</footer>
		</div>
		</div>
		</div>
	);
}
