import { h } from "preact";
import {openWebLink} from '../lib/web-link';
import type { LatestVideo } from "../lib/youtube";

interface Props {
	video: LatestVideo | null;
}

function compact(n: number): string {
	return new Intl.NumberFormat("en-US", {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(n);
}

function age(publishedAt: string): string {
	if (!publishedAt) return "—";
	const ms = Date.now() - Date.parse(publishedAt);
	if (!Number.isFinite(ms) || ms < 0) return "—";
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s old`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m old`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h old`;
	const day = Math.floor(hr / 24);
	if (day < 7) return `${day}d old`;
	const wk = Math.floor(day / 7);
	if (wk < 4) return `${wk}w old`;
	const mo = Math.floor(day / 30);
	return `${mo}mo old`;
}

function statusClass(status: string): string {
	switch (status) {
		case "ok":
			return "aos-v2-cc-status-ok";
		case "mock":
			return "aos-v2-cc-status-mock";
		case "stale":
			return "aos-v2-cc-status-stale";
		default:
			return "aos-v2-cc-status-error";
	}
}

export function LatestVideoCard({ video }: Props) {
	if (!video) {
		return (
			<div className="aos-v2-cc-card aos-v2-cc-latest-video aos-v2-cc-card-empty">
				<div className="aos-v2-cc-card-label">Latest Upload</div>
				<div className="aos-v2-cc-card-value aos-v2-cc-dim">—</div>
				<div className="aos-v2-cc-card-delta aos-v2-cc-dim">no data</div>
			</div>
		);
	}

	const isStaleish = video.status !== "ok";
	const open = () => openWebLink(video.url);

	return (
		<div
			className={`aos-v2-cc-card aos-v2-cc-latest-video aos-v2-cc-latest-video-clickable ${isStaleish ? "aos-v2-cc-card-dim" : ""}`}
			onClick={open}
			title={`open ${video.url}`}
		>
			<div className="aos-v2-cc-card-head">
				<span className="aos-v2-cc-card-label">Latest Upload</span>
				<span
					className={`aos-v2-cc-status-dot ${statusClass(video.status)}`}
					title={`${video.status}${video.error ? ` — ${video.error}` : ""}`}
				/>
			</div>
			<div className="aos-v2-cc-latest-title" title={video.title}>
				{video.title}
			</div>
			<div className="aos-v2-cc-latest-stats">
				<span className="aos-v2-cc-latest-stat" title={`${video.views} views`}>
					<span className="aos-v2-cc-latest-stat-num">{compact(video.views)}</span>
					<span className="aos-v2-cc-latest-stat-label">views</span>
				</span>
				<span className="aos-v2-cc-latest-stat" title={`${video.likes} likes`}>
					<span className="aos-v2-cc-latest-stat-num">{compact(video.likes)}</span>
					<span className="aos-v2-cc-latest-stat-label">likes</span>
				</span>
				<span className="aos-v2-cc-latest-stat" title={`${video.comments} comments`}>
					<span className="aos-v2-cc-latest-stat-num">{compact(video.comments)}</span>
					<span className="aos-v2-cc-latest-stat-label">comments</span>
				</span>
				<span className="aos-v2-cc-latest-age aos-v2-cc-dim">{age(video.published_at)}</span>
			</div>
		</div>
	);
}
