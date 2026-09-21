import { h } from "preact";
import { useState } from "preact/hooks";
import type { App } from "obsidian";
import { Notice } from "obsidian";
import type { DriverItem } from "../lib/vault";
import { toggleTaskByText, addTaskToSection } from "../lib/vault-writer";

interface Props {
	app: App;
	path: string;
	items: DriverItem[];
}

export function DailyDriversChecklist({ app, path, items }: Props) {
	const [adding, setAdding] = useState(false);
	const [newTask, setNewTask] = useState("");

	const doneCount = items.filter((i) => i.done).length;
	const pct = items.length === 0 ? 0 : (doneCount / items.length) * 100;

	const toggle = async (text: string) => {
		const ok = await toggleTaskByText(app, path, "Daily Drivers", text);
		if (!ok) new Notice(`Could not toggle: ${text}`);
	};

	const submitAdd = async (e: Event) => {
		e.preventDefault();
		const text = newTask.trim();
		if (!text) return;
		const ok = await addTaskToSection(app, path, "Daily Drivers", text);
		if (!ok) {
			new Notice("Add failed — daily note missing Daily Drivers section");
			return;
		}
		setNewTask("");
		// Keep input open so multiple adds are fast. Esc closes.
	};

	return (
		<div className="aos-v2-cc-panel">
			<div className="aos-v2-cc-panel-head">
				<span className="aos-v2-cc-panel-label">Daily Tasks</span>
				<span className="aos-v2-cc-panel-count aos-v2-cc-dim">
					{doneCount}/{items.length}
				</span>
			</div>
			<div className="aos-v2-cc-gauge" aria-hidden="true">
				<div
					className="aos-v2-cc-gauge-fill"
					style={{ width: `${pct}%` }}
				/>
			</div>
			<div className="aos-v2-cc-panel-body">
				{items.length === 0 ? (
					<p className="aos-v2-cc-mono aos-v2-cc-dim">&gt; no tasks</p>
				) : (
					<ul
						className={`aos-v2-cc-drivers ${items.length > 5 ? "aos-v2-cc-drivers-wide" : ""}`}
					>
						{items.map((d, i) => (
							<li
								key={`${i}-${d.text}`}
								className={`aos-v2-cc-driver-item aos-v2-cc-driver-clickable ${d.done ? "aos-v2-cc-done" : ""}`}
								onClick={() => void toggle(d.text)}
								role="button"
								tabIndex={0}
							>
								<span className="aos-v2-cc-checkbox" aria-hidden="true">
									{d.done ? "■" : "□"}
								</span>
								<span>{d.text}</span>
							</li>
						))}
					</ul>
				)}
				{adding ? (
					<form className="aos-v2-cc-quickadd" onSubmit={submitAdd}>
						<input
							type="text"
							className="aos-v2-cc-quickadd-input"
							autoFocus
							placeholder="new task…"
							value={newTask}
							onInput={(e) => setNewTask((e.target as HTMLInputElement).value)}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									setAdding(false);
									setNewTask("");
								}
							}}
						/>
						<button type="submit" className="aos-v2-cc-quickadd-btn">
							+
						</button>
					</form>
				) : (
					<button
						type="button"
						className="aos-v2-cc-quickadd-trigger"
						onClick={() => setAdding(true)}
					>
						+ add task
					</button>
				)}
			</div>
		</div>
	);
}
