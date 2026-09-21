import { h } from "preact";
import { Menu, type App } from "obsidian";
import type { RunRecord } from "../lib/queue";

interface Props {
	app: App;
	runs: RunRecord[];
	onDismiss: (ids: string[]) => void | Promise<void>;
}

function statusClass(status: string): string {
	switch (status) {
		case "ok":
			return "aos-v2-cc-chip-ok";
		case "error":
			return "aos-v2-cc-chip-error";
		case "running":
			return "aos-v2-cc-chip-running";
		default:
			return "aos-v2-cc-chip-error";
	}
}

function relativeTime(iso: string): string {
	if (!iso) return "—";
	const diff = Date.now() - Date.parse(iso);
	const sec = Math.floor(diff / 1000);
	if (sec < 60) return `${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	return `${day}d ago`;
}

export function ActivityFeed({ app, runs, onDismiss }: Props) {
	const showContextMenu = (run: RunRecord, e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Dismiss")
				.setIcon("x")
				.onClick(() => void onDismiss([run.id])),
		);
		const errorIds = runs.filter((r) => r.status === "error").map((r) => r.id);
		if (errorIds.length > 1) {
			menu.addItem((item) =>
				item
					.setTitle(`Dismiss all errors (${errorIds.length})`)
					.setIcon("x-circle")
					.onClick(() => void onDismiss(errorIds)),
			);
		}
		menu.addItem((item) =>
			item
				.setTitle(`Dismiss all (${runs.length})`)
				.setIcon("trash")
				.onClick(() => void onDismiss(runs.map((r) => r.id))),
		);
		menu.showAtMouseEvent(e);
	};

	const openDeliverable = async (run: RunRecord) => {
		const candidate = run.deliverable_path || run.md_path || run.log_path;
		if (!candidate) return;
		const exists = await app.vault.adapter.exists(candidate);
		const path = exists ? candidate : run.md_path || run.log_path;
		if (!path) return;
		void app.workspace.openLinkText(path, "", true);
	};

	const openLog = (run: RunRecord, e: MouseEvent) => {
		e.stopPropagation();
		void app.workspace.openLinkText(
			run.md_path || run.log_path || `system/v2/runs/${run.id}.md`,
			"",
			true,
		);
	};

	const openJson = (run: RunRecord, e: MouseEvent) => {
		e.stopPropagation();
		void app.workspace.openLinkText(`system/v2/runs/${run.id}.json`, "", true);
	};

	return (
		<div className="aos-v2-cc-panel">
			<div className="aos-v2-cc-panel-head">
				<span className="aos-v2-cc-panel-label">Activity Feed</span>
				<span className="aos-v2-cc-panel-count aos-v2-cc-dim">
					{runs.length} run{runs.length === 1 ? "" : "s"}
				</span>
			</div>
			<div className="aos-v2-cc-panel-body">
				{runs.length === 0 ? (
					<p className="aos-v2-cc-mono aos-v2-cc-dim">
						&gt; no runs yet — click an action button
					</p>
				) : (
					<ul className="aos-v2-cc-feed">
						{runs.map((r) => (
							<li
								key={r.id}
								className={`aos-v2-cc-feed-item aos-v2-cc-feed-item-clickable aos-v2-cc-feed-item--${r.status}`}
								onClick={() => openDeliverable(r)}
								onContextMenu={(e) =>
									showContextMenu(r, e as MouseEvent)
								}
								title={`open ${r.deliverable_path || r.md_path || r.id} · right-click to dismiss`}
							>
								<span
									className={`aos-v2-cc-chip ${statusClass(r.status)}`}
									title={r.exit_code != null ? `exit ${r.exit_code}` : r.status}
								>
									{r.status === "running" ? "…" : r.status === "ok" ? "✓" : "✕"}{" "}
									{r.skill} {r.provider ? " · " + r.provider : ""}
								</span>
								<span className="aos-v2-cc-feed-summary">
									{r.summary || "(running)"}
								</span>
								<span className="aos-v2-cc-feed-actions">
									<button
										type="button"
										className="aos-v2-cc-feed-jsonbtn"
										onClick={(e) => openLog(r, e as MouseEvent)}
										title="open raw run log"
									>
										log
									</button>
									<button
										type="button"
										className="aos-v2-cc-feed-jsonbtn"
										onClick={(e) => openJson(r, e as MouseEvent)}
										title="open status JSON"
									>
										{`{}`}
									</button>
									<span className="aos-v2-cc-feed-time aos-v2-cc-dim">
										{relativeTime(r.ts_completed || r.ts_started)}
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
