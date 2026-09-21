import { h } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import type { App } from "obsidian";
import {
	MORNING_DIRS,
	readLatestBrief,
	type MorningBrief,
} from "../lib/morningBrief";

interface Props {
	app: App;
	limit?: number;
}

// The intel brief's "So What" payoff — ranked video angles, surfaced where
// the research happens.
export function ContentAnglesCard({ app, limit = 4 }: Props) {
	const [brief, setBrief] = useState<MorningBrief | null>(null);

	const refresh = useCallback(async () => {
		setBrief(await readLatestBrief(app));
	}, [app]);

	useEffect(() => {
		void refresh();
		const handler = (file: { path: string }) => {
			if (MORNING_DIRS.some((f) => file.path.startsWith(f))) void refresh();
		};
		app.vault.on("modify", handler);
		app.vault.on("create", handler);
		return () => {
			app.vault.off("modify", handler);
			app.vault.off("create", handler);
		};
	}, [app, refresh]);

	const openReport = () => {
		if (!brief) return;
		void app.workspace.openLinkText(brief.path, "", false);
	};

	const items = (brief?.contentOpportunities ?? []).slice(0, limit);

	return (
		<div className="aos-v2-cc-panel">
			<div className="aos-v2-cc-panel-head">
				<span className="aos-v2-cc-panel-label">
					Content Angles
					{brief ? (
						<button
							type="button"
							className="aos-v2-cc-feed-headlink"
							onClick={openReport}
							title={`open ${brief.path}`}
						>
							↗
						</button>
					) : null}
				</span>
				<span className="aos-v2-cc-panel-count aos-v2-cc-dim">
					{brief?.date ?? "—"}
				</span>
			</div>
			<div className="aos-v2-cc-panel-body">
				{items.length === 0 ? (
					<p className="aos-v2-cc-mono aos-v2-cc-dim">
						&gt; no angles yet — run /morning-intel
					</p>
				) : (
					<ul className="aos-v2-cc-feed-list">
						{items.map((title, i) => (
							<li key={i} className="aos-v2-cc-feed-item">
								<span className="aos-v2-cc-feed-rank">{i + 1}</span>
								<span className="aos-v2-cc-feed-main">
									<span className="aos-v2-cc-feed-title">{title}</span>
								</span>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
