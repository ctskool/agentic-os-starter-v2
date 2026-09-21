import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Notice } from "obsidian";
import type { App } from "obsidian";
import { writeIntent } from "../lib/queue";
import {
	readLatestReview,
	reviewPlainText,
	type YtReview,
	type Verdict,
} from "../lib/ytReview";

interface Props {
	app: App;
}

function compact(n: number | null): string {
	if (n === null) return "—";
	return new Intl.NumberFormat("en-US", {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(n);
}

function verdictTone(v: Verdict): string {
	switch (v) {
		case "Hit":
			return "hit";
		case "Steady":
			return "steady";
		case "Miss":
			return "miss";
		case "Climbing":
			return "climbing";
		default:
			return "neutral";
	}
}

function firstSentence(body: string): string {
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		// Skip standalone bold-only lines (e.g. "**Why it worked:**" on its own)
		if (/^\*\*[^*]+\*\*\s*[:—-]?\s*$/.test(trimmed)) continue;
		// Strip leading bold-prefix + colon + any leading markdown
		const cleaned = reviewPlainText(trimmed
			.replace(/^\*\*[^*]+\*\*\s*[:—-]?\s*/, "")
			.replace(/\*\*/g, "")
			.trim());
		if (cleaned.length === 0) continue;
		// Cut at first sentence end. Keep up to ~160 chars max.
		const periodIdx = cleaned.search(/[.!?](\s|$)/);
		let out = periodIdx > 0 ? cleaned.slice(0, periodIdx + 1) : cleaned;
		if (out.length > 160) out = out.slice(0, 157).trimEnd() + "…";
		return out;
	}
	return "";
}

export function YtWeekReviewCard({ app }: Props) {
	const [review, setReview] = useState<YtReview | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let cancelled = false;
		const refresh = async () => {
			const r = await readLatestReview(app);
			if (!cancelled) setReview(r);
		};
		void refresh();
		const handler = (file: { path: string }) => {
			if (file.path.startsWith("inbox/reports/yt-reviews/")) void refresh();
		};
		app.vault.on("modify", handler);
		app.vault.on("create", handler);
		return () => {
			cancelled = true;
			app.vault.off("modify", handler);
			app.vault.off("create", handler);
		};
	}, [app]);

	const runNew = async () => {
		if (busy) return;
		setBusy(true);
		try {
			await writeIntent(app, "yt-week-review", {});
		} catch (e) {
			new Notice(`Could not start workflow: ${e}`);
		} finally {
			setBusy(false);
		}
	};

	const openFull = () => {
		if (!review) return;
		void app.workspace.openLinkText(review.path, "", true);
	};

	if (!review) {
		return (
			<section className="aos-v2-cc-yt-review aos-v2-cc-yt-review--empty">
				<header className="aos-v2-cc-yt-review-head">
					<span className="aos-v2-cc-yt-review-title">§ YT WEEK REVIEW</span>
					<span className="aos-v2-cc-yt-review-meta aos-v2-cc-dim">
						no review yet
					</span>
					<button
						type="button"
						className="aos-v2-cc-yt-review-btn"
						onClick={() => void runNew()}
						disabled={busy}
					>
						RUN NEW ↻
					</button>
				</header>
				<p className="aos-v2-cc-yt-review-empty-msg aos-v2-cc-mono aos-v2-cc-dim">
					&gt; click RUN NEW to generate this week's channel review
				</p>
			</section>
		);
	}

	const verdictCounts: Record<string, number> = {};
	for (const u of review.uploads) {
		verdictCounts[u.verdict] = (verdictCounts[u.verdict] || 0) + 1;
	}
	const totalUploads = review.uploads.length;
	const ringSegments = [
		{ tone: "hit", count: verdictCounts["Hit"] || 0, label: "HIT" },
		{ tone: "steady", count: verdictCounts["Steady"] || 0, label: "STEADY" },
		{
			tone: "climbing",
			count: verdictCounts["Climbing"] || 0,
			label: "CLIMBING",
		},
		{ tone: "miss", count: verdictCounts["Miss"] || 0, label: "MISS" },
	];

	const maxViews = Math.max(
		review.baselineViews || 0,
		...review.uploads.map((u) => u.views ?? 0),
		1,
	);

	return (
		<section className="aos-v2-cc-yt-review">
			<header className="aos-v2-cc-yt-review-head">
				<span className="aos-v2-cc-yt-review-title">§ YT WEEK REVIEW</span>
				<span className="aos-v2-cc-yt-review-window">
					{review.window || review.date}
				</span>
				<span className="aos-v2-cc-yt-review-actions">
					<button
						type="button"
						className="aos-v2-cc-yt-review-btn"
						onClick={openFull}
						title="open full report"
					>
						FULL ↗
					</button>
					<button
						type="button"
						className="aos-v2-cc-yt-review-btn"
						onClick={() => void runNew()}
						disabled={busy}
						title="Run workflow"
					>
						↻
					</button>
				</span>
			</header>

			{review.tldr.length > 0 ? (
				<ul className="aos-v2-cc-yt-review-tldr">
					{review.tldr.map((b, i) => (
						<li key={i}>{b}</li>
					))}
				</ul>
			) : null}

			<div className="aos-v2-cc-yt-review-body">
				<div className="aos-v2-cc-yt-review-chart">
					<div className="aos-v2-cc-yt-review-chart-head">
						<span className="aos-v2-cc-yt-review-chart-title">
							UPLOADS · VIEWS
						</span>
						<span className="aos-v2-cc-yt-review-chips">
							{ringSegments.map((seg, i) => (
								<span
									key={i}
									className={`aos-v2-cc-yt-review-chip aos-v2-cc-yt-review-chip--${seg.tone}`}
								>
									<span className="aos-v2-cc-yt-review-chip-dot" />
									{seg.label}
									<span className="aos-v2-cc-yt-review-chip-count">
										{seg.count}
									</span>
								</span>
							))}
						</span>
						{review.baselineViews !== null ? (
							<span className="aos-v2-cc-yt-review-chart-baseline">
								baseline {compact(review.baselineViews)}
							</span>
						) : null}
					</div>
					<div className="aos-v2-cc-yt-review-bars">
						{review.uploads.length === 0 ? (
							<span className="aos-v2-cc-yt-review-bars-empty aos-v2-cc-dim">
								no uploads in window
							</span>
						) : (
							review.uploads.map((u, i) => {
								const heightPct = ((u.views ?? 0) / maxViews) * 100;
								const baselinePct = review.baselineViews
									? (review.baselineViews / maxViews) * 100
									: null;
								return (
									<div
										key={i}
										className={`aos-v2-cc-yt-review-bar-col aos-v2-cc-yt-review-bar-col--${verdictTone(u.verdict)}`}
										title={`${u.title} · ${compact(u.views)} views · ${u.vsBaselinePct ?? "?"}% baseline · ${u.verdict}`}
									>
										<div className="aos-v2-cc-yt-review-bar-value">
											{compact(u.views)}
										</div>
										<div className="aos-v2-cc-yt-review-bar-stack">
											<div
												className="aos-v2-cc-yt-review-bar-fill"
												style={{ height: `${heightPct}%` }}
											/>
											{baselinePct !== null ? (
												<div
													className="aos-v2-cc-yt-review-bar-baseline"
													style={{ bottom: `${baselinePct}%` }}
												/>
											) : null}
										</div>
										<div
											className="aos-v2-cc-yt-review-bar-label"
											title={u.title}
										>
											{u.title}
										</div>
									</div>
								);
							})
						)}
					</div>
				</div>

			</div>

			{(review.topPerformer || review.underperformer) && (
				<div className="aos-v2-cc-yt-review-outliers">
					{review.topPerformer ? (
						<div className="aos-v2-cc-yt-review-outlier aos-v2-cc-yt-review-outlier--top">
							<span className="aos-v2-cc-yt-review-outlier-label">
								▲ TOP PERFORMER
							</span>
							<span className="aos-v2-cc-yt-review-outlier-title">
								{review.topPerformer.title}
							</span>
							<p className="aos-v2-cc-yt-review-outlier-body">
								{firstSentence(review.topPerformer.body)}
							</p>
						</div>
					) : null}
					{review.underperformer ? (
						<div className="aos-v2-cc-yt-review-outlier aos-v2-cc-yt-review-outlier--bottom">
							<span className="aos-v2-cc-yt-review-outlier-label">
								▼ UNDERPERFORMER
							</span>
							<span className="aos-v2-cc-yt-review-outlier-title">
								{review.underperformer.title}
							</span>
							<p className="aos-v2-cc-yt-review-outlier-body">
								{firstSentence(review.underperformer.body)}
							</p>
						</div>
					) : null}
				</div>
			)}
		</section>
	);
}
