import type { App } from "obsidian";

export interface LatestVideo {
	video_id: string;
	title: string;
	url: string;
	published_at: string;
	views: number;
	likes: number;
	comments: number;
	ts: string;
	status: "ok" | "mock" | "stale" | "error";
	error: string;
}

export const LATEST_VIDEO_PATH = "system/metrics/latest-video.json";

export async function readLatestVideo(app: App): Promise<LatestVideo | null> {
	if (!(await app.vault.adapter.exists(LATEST_VIDEO_PATH))) return null;
	try {
		const obj = JSON.parse(await app.vault.adapter.read(LATEST_VIDEO_PATH));
		if (!obj || !obj.video_id) return null;
		return obj as LatestVideo;
	} catch {
		return null;
	}
}
