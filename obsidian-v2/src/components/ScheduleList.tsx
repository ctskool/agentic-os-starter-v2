import { h } from "preact";
import { Notice } from "obsidian";
import type { App } from "obsidian";
import type { ScheduleEntry } from "../lib/vault";
import { writeIntent } from "../lib/queue";

interface Props {
	app: App;
	entries: ScheduleEntry[];
}

export function ScheduleList({ app, entries }: Props) {
	const refresh = async () => {
		try {
			await writeIntent(app, "refresh-schedule", {});
		} catch (e) {
			new Notice(`Refresh failed: ${e}`);
		}
	};

	return (
		<div className="aos-v2-cc-panel">
			<div className="aos-v2-cc-panel-head">
				<span className="aos-v2-cc-panel-label">Schedule</span>
				<span className="aos-v2-cc-panel-actions">
					<button
						type="button"
						className="aos-v2-cc-refresh aos-v2-cc-refresh-inline"
						onClick={() => void refresh()}
						title="Refresh from Google Calendar"
					>
						↻
					</button>
					<span className="aos-v2-cc-panel-count aos-v2-cc-dim">
						{entries.length} event{entries.length === 1 ? "" : "s"}
					</span>
				</span>
			</div>
			<div className="aos-v2-cc-panel-body">
				{entries.length === 0 ? (
					<p className="aos-v2-cc-mono aos-v2-cc-dim">
						&gt; no events — click ↻ to pull
					</p>
				) : (
					<ul
						className={`aos-v2-cc-schedule ${entries.length > 5 ? "aos-v2-cc-schedule-wide" : ""}`}
					>
						{entries.map((e, i) => (
							<li key={i} className="aos-v2-cc-schedule-item">
								<span className="aos-v2-cc-schedule-time">{e.time}</span>
								<span className="aos-v2-cc-schedule-title">{e.title}</span>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
