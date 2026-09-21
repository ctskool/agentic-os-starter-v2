import { h } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import type { App } from "obsidian";
import {
	MORNING_FOLDERS,
	readLatestMorningHeadlines,
	type HeadlineItem,
	type ReportSnapshot,
} from "../lib/reports";

interface Props {
	app: App;
	limit?: number;
}

export function MorningHeadlinesCard({ app, limit = 3 }: Props) {
	const [snap, setSnap] = useState<ReportSnapshot<HeadlineItem> | null>(null);

	const refresh = useCallback(async () => {
		const s = await readLatestMorningHeadlines(app);
		setSnap(s);
	}, [app]);

	useEffect(() => {
		void refresh();
		const handler = (file: { path: string }) => {
			if (MORNING_FOLDERS.some((f) => file.path.startsWith(f))) void refresh();
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

	const items = (snap?.items ?? []).slice(0, limit);

	return (
		<div className="aos-v2-cc-panel">
			<div className="aos-v2-cc-panel-head">
				<span className="aos-v2-cc-panel-label">
					Morning Headlines
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
						onClick={refresh}
						title="re-read latest morning report"
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
						&gt; no intel brief yet — run /morning-intel
					</p>
				) : (
					<ul className="aos-v2-cc-feed-list">
						{items.map((h, i) => (
							<li key={i} className="aos-v2-cc-feed-item">
								<span className="aos-v2-cc-feed-rank">•</span>
								<span className="aos-v2-cc-feed-main">
									<span className="aos-v2-cc-feed-title">{h.bold}</span>
									{h.body ? (
										<span className="aos-v2-cc-feed-sub aos-v2-cc-dim">
											{h.body}
										</span>
									) : null}
								</span>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
