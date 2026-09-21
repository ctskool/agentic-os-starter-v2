import { h } from "preact";
import {openWebLink} from '../lib/web-link';
import { useCallback, useEffect, useState } from "preact/hooks";
import { fetchHNTop, type HNStory } from "../lib/hackernews";

interface Props {
	limit?: number;
	refreshMs?: number;
}

function relTime(unixSec: number): string {
	if (!unixSec) return "";
	const diff = Math.max(0, Date.now() / 1000 - unixSec);
	if (diff < 60) return `${Math.floor(diff)}s`;
	if (diff < 3600) return `${Math.floor(diff / 60)}m`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
	return `${Math.floor(diff / 86400)}d`;
}

export function HackerNewsCard({ limit = 6, refreshMs = 5 * 60 * 1000 }: Props) {
	const [stories, setStories] = useState<HNStory[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [updatedAt, setUpdatedAt] = useState<number | null>(null);

	const refresh = useCallback(async () => {
		try {
			const items = await fetchHNTop(limit);
			setStories(items);
			setUpdatedAt(Date.now());
			setError(null);
		} catch (e) {
			setError(String(e));
		}
	}, [limit]);

	useEffect(() => {
		void refresh();
		const id = window.setInterval(() => void refresh(), refreshMs);
		return () => window.clearInterval(id);
	}, [refresh, refreshMs]);

	// row click = the HN THREAD (the conversation is the point — and text
	// posts have no article url at all); the inline ↗ opens the article
	const openThread = (s: HNStory) => {
		openWebLink(`https://news.ycombinator.com/item?id=${encodeURIComponent(s.id)}`);
	};
	const openArticle = (e: Event, s: HNStory) => {
		e.stopPropagation();
		if (s.url) openWebLink(s.url);
	};

	const tsLabel = updatedAt
		? new Date(updatedAt).toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
			})
		: "—";

	return (
		<div className="aos-v2-cc-panel">
			<div className="aos-v2-cc-panel-head">
				<span className="aos-v2-cc-panel-label">Hacker News</span>
				<span className="aos-v2-cc-panel-actions">
					<button
						type="button"
						className="aos-v2-cc-refresh aos-v2-cc-refresh-inline"
						onClick={refresh}
						title="fetch HN top stories"
					>
						↻
					</button>
					<span className="aos-v2-cc-panel-count aos-v2-cc-dim">{tsLabel}</span>
				</span>
			</div>
			<div className="aos-v2-cc-panel-body">
				{error ? (
					<p className="aos-v2-cc-mono aos-v2-cc-dim">&gt; {error}</p>
				) : stories.length === 0 ? (
					<p className="aos-v2-cc-mono aos-v2-cc-dim">&gt; loading…</p>
				) : (
					<ul className="aos-v2-cc-feed-list">
						{stories.map((s, i) => (
							<li
								key={s.id}
								className="aos-v2-cc-feed-item aos-v2-cc-feed-item-clickable"
								onClick={() => openThread(s)}
								title={`open HN thread · ${s.score}↑ · ${s.descendants} comments · ${relTime(s.time)} ago`}
							>
								<span className="aos-v2-cc-feed-rank">{i + 1}</span>
								<span className="aos-v2-cc-feed-main">
									<span className="aos-v2-cc-feed-title">
										{s.title}
										<span className="aos-v2-cc-feed-stars aos-v2-cc-dim">
											{s.score}↑ {s.descendants}💬
										</span>
										{s.url ? (
											<button
												type="button"
												className="aos-v2-cc-feed-headlink"
												onClick={(e) => openArticle(e, s)}
												title="open the article"
											>
												↗
											</button>
										) : null}
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
