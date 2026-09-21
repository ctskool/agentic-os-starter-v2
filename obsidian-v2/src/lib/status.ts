import type { App } from "obsidian";
import {readBridgeStatus} from './bridge-status';

export interface RunnerStatus {
	ts: string;
	pid: number;
	version?: string;
	busy?: boolean;
	active?: number;
	max_concurrent?: number;
	pending?: number;
	in_flight?: string[];
}

export interface LastPullSnapshot {
	[source: string]: {
		ts: string;
		status: string;
		error: string;
	};
}

export const RUNNER_STATUS_PATH = "system/v2/runner-status.json";
export const LAST_PULL_PATH = "system/metrics/last-pull.json";

export async function readRunnerStatus(app: App): Promise<RunnerStatus | null> {
	try {
    return (await readBridgeStatus()).health;
	} catch {
		return null;
	}
}

export async function readLastPull(app: App): Promise<LastPullSnapshot | null> {
	if (!(await app.vault.adapter.exists(LAST_PULL_PATH))) return null;
	try {
		return JSON.parse(await app.vault.adapter.read(LAST_PULL_PATH));
	} catch {
		return null;
	}
}

/** Latest pull timestamp across all sources. */
export function latestPullTs(snap: LastPullSnapshot | null): string | null {
	if (!snap) return null;
	let best: string | null = null;
	for (const v of Object.values(snap)) {
		if (!v?.ts) continue;
		if (best === null || v.ts > best) best = v.ts;
	}
	return best;
}

export function nextPullDelta(
	snap: LastPullSnapshot | null,
	cadenceHours: number,
): { ms: number; overdue: boolean } | null {
	const last = latestPullTs(snap);
	if (!last) return null;
	const lastMs = Date.parse(last);
	if (!Number.isFinite(lastMs)) return null;
	const nextMs = lastMs + cadenceHours * 3_600_000;
	const delta = nextMs - Date.now();
	return { ms: delta, overdue: delta < 0 };
}

export function runnerIsOnline(s: RunnerStatus | null, maxAgeMs = 45_000): boolean {
	if (!s) return false;
	const age = Date.now() - Date.parse(s.ts);
	return age >= 0 && age < maxAgeMs;
}

export function humanDuration(ms: number): string {
	const abs = Math.abs(ms);
	const sec = Math.floor(abs / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	if (hr < 24) return `${hr}h ${remMin}m`;
	const day = Math.floor(hr / 24);
	return `${day}d ${hr % 24}h`;
}
