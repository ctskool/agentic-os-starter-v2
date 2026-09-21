import { h } from "preact";
import { useState } from "preact/hooks";
import type { App } from "obsidian";
import { Notice } from "obsidian";
import type { Top3Item } from "../lib/vault";
import { toggleTop3ByIndex, setTop3TextByIndex } from "../lib/vault-writer";

interface Props {
	app: App;
	path: string;
	items: Top3Item[];
}

export function Top3Priorities({ app, path, items }: Props) {
	const padded: (Top3Item | null)[] = [...items];
	while (padded.length < 3) padded.push(null);

	const [editingIdx, setEditingIdx] = useState<number | null>(null);
	const [draft, setDraft] = useState<string>("");

	const startEdit = (idx: number, current: string) => {
		setEditingIdx(idx);
		setDraft(current || "");
	};

	const commit = async () => {
		if (editingIdx === null) return;
		const idx = editingIdx;
		const text = draft.trim();
		if (!text) return;
		const ok = await setTop3TextByIndex(app, path, idx, text);
		if (!ok) new Notice(`Could not write Top 3 slot ${idx + 1}`);
        else setEditingIdx(null);
	};

	const cancel = () => {
		setEditingIdx(null);
		setDraft("");
	};

	const toggle = async (idx: number) => {
		const ok = await toggleTop3ByIndex(app, path, idx);
		if (!ok) new Notice(`Slot ${idx + 1} empty — click text to add`);
	};

	return (
		<div className="aos-v2-cc-panel">
			<div className="aos-v2-cc-panel-head">
				<span className="aos-v2-cc-panel-label">Top 3 Priorities</span>
			</div>
			<div className="aos-v2-cc-panel-body">
				<ol className="aos-v2-cc-top3">
					{padded.slice(0, 3).map((item, i) => {
						const isEditing = editingIdx === i;
						const text = item?.text || "";
						return (
							<li
								key={i}
								className={`aos-v2-cc-top3-item ${item?.done ? "aos-v2-cc-done" : ""}`}
							>
								<span
									className="aos-v2-cc-checkbox aos-v2-cc-driver-clickable"
									aria-hidden="true"
									onClick={(e) => {
										e.stopPropagation();
										if (text) void toggle(i);
									}}
									title={text ? "toggle done" : "set text first"}
								>
									{item?.done ? "■" : "□"}
								</span>
								{isEditing ? (
									<input
										type="text"
										className="aos-v2-cc-top3-input"
										autoFocus
										value={draft}
										onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
										onBlur={commit}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												commit();
											} else if (e.key === "Escape") {
												cancel();
											}
										}}
									/>
								) : (
									<span
										className="aos-v2-cc-top3-text aos-v2-cc-top3-clickable"
										onClick={() => startEdit(i, text)}
										title="click to edit"
									>
										{text || (
											<span className="aos-v2-cc-dim">— click to set —</span>
										)}
									</span>
								)}
							</li>
						);
					})}
				</ol>
			</div>
		</div>
	);
}
