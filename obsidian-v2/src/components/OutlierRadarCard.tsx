import { h } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { Notice } from "obsidian";
import type { App } from "obsidian";
import {
	readLatestOutliers,
	type OutlierItem,
	type ReportSnapshot,
} from "../lib/reports";
import { writeIntent } from "../lib/queue";

interface Props {
	app: App;
	limit?: number;
}

// two sources feed this card (radar file OR the intel brief's embedded
// outlier table — freshest wins), so watch every folder either lands in
const FOLDERS = [
	"inbox/research/outlier-radar",
	"inbox/research/morning-intel",
	"inbox/reports/morning",
];

// heat tier for the multiplier badge — the number IS the story
function multTier(mult: string): "hot" | "warm" | "" {
	const n = mult.startsWith(">") ? 999 : parseFloat(mult);
	if (!Number.isFinite(n)) return "";
	if (n >= 50) return "hot";
	if (n >= 10) return "warm";
	return "";
}

export function OutlierRadarCard({ app, limit = 10 }: Props) {
	const [snap, setSnap] = useState<ReportSnapshot<OutlierItem> | null>(null);
	const [running, setRunning] = useState(false);

	const refresh = useCallback(async () => {
		setSnap(await readLatestOutliers(app));
	}, [app]);

	useEffect(() => {
		void refresh();
		const handler = (file: { path: string }) => {
			if (FOLDERS.some((f) => file.path.startsWith(f))) {
				setRunning(false);
				void refresh();
			}
		};
		app.vault.on("modify", handler);
		app.vault.on("create", handler);
		return () => {
			app.vault.off("modify", handler);
			app.vault.off("create", handler);
		};
	}, [app, refresh]);

	const runNow = async () => {
		if (running) return;
		setRunning(true);
		try {
			await writeIntent(app, "outlier-radar", {});
		} catch (error) {
			new Notice(`Outlier Radar could not start: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setRunning(false);
		}
	};

	const openReport = () => {
		if (!snap) return;
		void app.workspace.openLinkText(snap.sourcePath, "", false);
	};

	const items = (snap?.items ?? []).slice(0, limit);

	// NOTE: root is aos-v2-cc-panel ONLY — "aos-v2-cc-feed" is the Activity
	// Feed LIST class (padding 0, 170px clip) and wrecks panel layout
	return (
		<div className="aos-v2-cc-panel">
			<div className="aos-v2-cc-panel-head">
				<span className="aos-v2-cc-panel-label">
					Outlier Radar
					{snap ? (
						<button
							type="button"
							className="aos-v2-cc-feed-headlink"
							onClick={openReport}
							title={`open ${snap.sourcePath}`}
						>
							↗
						</button>
					) : null}
				</span>
				<span className="aos-v2-cc-panel-actions">
					<button
						type="button"
						className="aos-v2-cc-refresh aos-v2-cc-refresh-inline"
						onClick={() => void runNow()}
						disabled={running}
						title="Not connected in V2"
					>
						{running ? "…" : "▶"}
					</button>
					<span className="aos-v2-cc-panel-count aos-v2-cc-dim">
						{snap?.dateLabel ?? "—"}
					</span>
				</span>
			</div>
			<div className="aos-v2-cc-panel-body">
				{items.length === 0 ? (
					<p className="aos-v2-cc-mono aos-v2-cc-dim">
						&gt; no radar data yet — press ▶ or run /outlier-radar
					</p>
				) : (
					<ul className="aos-v2-cc-feed-list">
						{items.map((o) => (
							<li key={o.url} className="aos-v2-cc-feed-item">
								<span
									className={`aos-v2-cc-outlier-mult aos-v2-cc-outlier-mult--${multTier(o.mult)}`}
								>
									{o.mult}
								</span>
								<span className="aos-v2-cc-feed-main">
									<a
										className="aos-v2-cc-feed-title"
										href={o.url}
										rel="noopener"
									>
										{o.title}
									</a>
									<span className="aos-v2-cc-feed-sub aos-v2-cc-dim">
										{o.channel} ({o.subs}) · {o.viewsAge}
									</span>
								</span>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
