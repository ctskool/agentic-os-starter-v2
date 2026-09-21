import { h } from "preact";
import {openWebLink} from '../lib/web-link';
import { useCallback, useEffect, useState } from "preact/hooks";
import { Notice, type App } from "obsidian";
import {
	readLatestGithubTrending,
	type ReportSnapshot,
	type TrendingRepo,
} from "../lib/reports";
import { writeIntent } from "../lib/queue";

interface Props {
	app: App;
	limit?: number;
}

const FOLDER = "inbox/research/github-trending";

/** A compact "fastest growing" group (24h or 30d) with a growth badge. */
function renderVelGroup(
	label: string,
	rows: TrendingRepo[],
	badgeSuffix: string,
	openRepo: (url: string) => void,
) {
	return (
		<div className="aos-v2-cc-trending-velocity">
			<div className="aos-v2-cc-feed-subhead aos-v2-cc-dim">{label}</div>
			<ul className="aos-v2-cc-feed-list">
				{rows.map((r) => (
					<li
						key={`${label}-${r.owner}/${r.name}`}
						className="aos-v2-cc-feed-item"
						onClick={() => openRepo(r.url)}
						title={r.description || `${r.owner}/${r.name}`}
					>
						<span className="aos-v2-cc-feed-rank">{r.rank}</span>
						<span className="aos-v2-cc-feed-main">
							<span className="aos-v2-cc-feed-title">
								{r.owner ? `${r.owner}/${r.name}` : r.name}
								{r.growth ? (
									<span className="aos-v2-cc-feed-stars aos-v2-cc-dim">
										{r.growth}
										{badgeSuffix}
									</span>
								) : null}
								{r.aiDev ? <span className="aos-v2-cc-feed-tag">AI</span> : null}
							</span>
							{r.description ? (
								<span className="aos-v2-cc-feed-sub aos-v2-cc-dim">
									{r.description}
								</span>
							) : null}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

export function GithubTrendingCard({ app, limit = 6 }: Props) {
	const [snap, setSnap] = useState<ReportSnapshot<TrendingRepo> | null>(null);
	const [running, setRunning] = useState(false);

	const refresh = useCallback(async () => {
		const s = await readLatestGithubTrending(app);
		setSnap(s);
	}, [app]);

	const runNew = useCallback(async () => {
		if (running) return;
		setRunning(true);
		try {
			await writeIntent(app, "github-trending", {});
		} catch (e) {
			new Notice(`GitHub Trending could not start — ${(e as Error).message}`);
		} finally {
			setRunning(false);
		}
	}, [app, running]);

	useEffect(() => {
		void refresh();
		const handler = (file: { path: string }) => {
			if (file.path.startsWith(FOLDER)) {
				void refresh();
				setRunning(false);
			}
		};
		app.vault.on("modify", handler);
		app.vault.on("create", handler);
		return () => {
			app.vault.off("modify", handler);
			app.vault.off("create", handler);
		};
	}, [app, refresh]);

	const openReport = () => {
		if (!snap) return;
		void app.workspace.openLinkText(snap.sourcePath, "", false);
	};

	const openRepo = (url: string) => {
		openWebLink(url, 'github.com');
	};

	const all = snap?.items ?? [];
	// Back-compat: older reports have no section tag — treat untagged as "week".
	const weekItems = all
		.filter((r) => (r.section ?? "week") === "week")
		.slice(0, limit);
	const velDayItems = all
		.filter((r) => r.section === "velocity-day")
		.slice(0, 5);
	const velMonthItems = all
		// "velocity" = legacy single-section reports; show them under 30d.
		.filter(
			(r) =>
				r.section === "velocity-month" ||
				(r.section as string) === "velocity",
		)
		.slice(0, 5);
	const items = weekItems;

	return (
		<div className="aos-v2-cc-panel">
			<div className="aos-v2-cc-panel-head">
				<span className="aos-v2-cc-panel-label">GitHub Trending</span>
				<span className="aos-v2-cc-panel-actions">
					{snap ? (
						<button
							type="button"
							className="aos-v2-cc-feed-headlink"
							onClick={openReport}
							title={`open ${snap.sourcePath}`}
						>
							full ↗
						</button>
					) : null}
					<button
						type="button"
						className="aos-v2-cc-refresh aos-v2-cc-refresh-inline"
						onClick={runNew}
						disabled={running}
						title={
							running
								? "running — new capture in flight"
								: "fetch fresh trending now (queues daemon)"
						}
					>
						{running ? "…" : "▶"}
					</button>
					<button
						type="button"
						className="aos-v2-cc-refresh aos-v2-cc-refresh-inline"
						onClick={refresh}
						title="re-read latest trending file"
					>
						↻
					</button>
					<span className="aos-v2-cc-panel-count aos-v2-cc-dim">
						{snap?.dateLabel ?? "—"}
					</span>
				</span>
			</div>
			<div className="aos-v2-cc-panel-body">
				{items.length === 0 ? (
					<p className="aos-v2-cc-mono aos-v2-cc-dim">
						&gt; no trending captures yet
					</p>
				) : (
					<ul className="aos-v2-cc-feed-list">
						{items.map((r) => (
							<li
								key={`${r.owner}/${r.name}`}
								className="aos-v2-cc-feed-item"
								onClick={() => openRepo(r.url)}
								title={r.description || `${r.owner}/${r.name}`}
							>
								<span className="aos-v2-cc-feed-rank">{r.rank}</span>
								<span className="aos-v2-cc-feed-main">
									<span className="aos-v2-cc-feed-title">
										{r.owner ? `${r.owner}/${r.name}` : r.name}
										{r.stars ? (
											<span className="aos-v2-cc-feed-stars aos-v2-cc-dim">
												⭐ {r.stars}
											</span>
										) : null}
										{r.aiDev ? (
											<span className="aos-v2-cc-feed-tag">AI</span>
										) : null}
									</span>
									{r.description ? (
										<span className="aos-v2-cc-feed-sub aos-v2-cc-dim">
											{r.description}
										</span>
									) : null}
								</span>
							</li>
						))}
					</ul>
				)}
				{velDayItems.length > 0
					? renderVelGroup(
							"🚀 Fastest growing — 24h",
							velDayItems,
							"/day",
							openRepo,
						)
					: null}
				{velMonthItems.length > 0
					? renderVelGroup(
							"📈 Fastest growing — 30d",
							velMonthItems,
							"/mo",
							openRepo,
						)
					: null}
			</div>
		</div>
	);
}
