import type { App } from "obsidian";
import {createResourceCache} from '../../shared/resource-cache.mjs';
const metricCache=createResourceCache(10000);
export const invalidateMetrics=(app:App)=>metricCache.invalidate(app);

export type MetricStatus = "ok" | "mock" | "stale" | "error";

export interface MetricRow {
	timestamp: string;
	source: string;
	metric: string;
	value: number;
	status: MetricStatus;
	error: string;
}

export interface MetricSnapshot {
	source: string;
	metric: string;
	latest: MetricRow;
	previous: MetricRow | null;
	delta: number | null;
	deltaPct: number | null;
}

// Cached CSV rows are immutable snapshots. Reuse their grouped/sorted result
// until a read after expiry or invalidation supplies a new array.
const snapshotCache = new WeakMap<MetricRow[], Map<string, MetricSnapshot>>();

const CSV_HEADER = ["timestamp", "source", "metric", "value", "status", "error"];

export const METRICS_CSV_PATH = "system/metrics/metrics.csv";

function parseRow(line: string): MetricRow | null {
	// Simple CSV parser. Schema guarantees no commas inside values
	// (error strings are short machine codes, snake_case only).
	const parts = line.split(",");
	if (parts.length < 6) return null;
	const [timestamp, source, metric, valueStr, status, ...errorParts] = parts;
	const error = errorParts.join(",").trim();
	const value = Number(valueStr);
	if (Number.isNaN(value)) return null;
	return {
		timestamp: timestamp!.trim(),
		source: source!.trim(),
		metric: metric!.trim(),
		value,
		status: (status!.trim() as MetricStatus) || "error",
		error,
	};
}

export function parseMetricsCsv(raw: string): MetricRow[] {
	const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
	if (lines.length === 0) return [];
	// Validate header
	const header = lines[0]!.split(",").map((s) => s.trim());
	const headerOk = CSV_HEADER.every((h, i) => header[i] === h);
	if (!headerOk) {
		console.warn("[aos-v2-cc] metrics.csv header mismatch", header);
	}
	const rows: MetricRow[] = [];
	for (let i = 1; i < lines.length; i++) {
		const row = parseRow(lines[i]!);
		if (row) rows.push(row);
	}
	return rows;
}

export async function readMetricsCsv(app: App): Promise<MetricRow[]> {
	return metricCache.read(app,async()=>{
	const exists = await app.vault.adapter.exists(METRICS_CSV_PATH);
	if (!exists) return [];
	const raw = await app.vault.adapter.read(METRICS_CSV_PATH);
	return parseMetricsCsv(raw);
	});
}

/**
 * Returns latest row per (source, metric) pair plus a delta vs the most recent
 * row that is at least 12h older. Used by MetricCard.
 */
export function snapshotByKey(rows: MetricRow[]): Map<string, MetricSnapshot> {
	const cached = snapshotCache.get(rows);
	if (cached) return cached;
	const grouped = new Map<string, MetricRow[]>();
	for (const row of rows) {
		const key = `${row.source}:${row.metric}`;
		const arr = grouped.get(key) ?? [];
		arr.push(row);
		grouped.set(key, arr);
	}

	const out = new Map<string, MetricSnapshot>();
	for (const [key, group] of grouped.entries()) {
		group.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
		const latest = group[group.length - 1]!;
		const latestTs = Date.parse(latest.timestamp);
		const twelveHoursMs = 12 * 60 * 60 * 1000;
		let previous: MetricRow | null = null;
		for (let i = group.length - 2; i >= 0; i--) {
			const candidate = group[i]!;
			if (latestTs - Date.parse(candidate.timestamp) >= twelveHoursMs) {
				previous = candidate;
				break;
			}
		}
		let delta: number | null = null;
		let deltaPct: number | null = null;
		if (previous && previous.value !== 0) {
			delta = latest.value - previous.value;
			deltaPct = (delta / previous.value) * 100;
		} else if (previous) {
			delta = latest.value - previous.value;
		}
		out.set(key, {
			source: latest.source,
			metric: latest.metric,
			latest,
			previous,
			delta,
			deltaPct,
		});
	}
	snapshotCache.set(rows, out);
	return out;
}

export async function readMetricSnapshots(
	app: App,
): Promise<Map<string, MetricSnapshot>> {
	const rows = await readMetricsCsv(app);
	return snapshotByKey(rows);
}

export interface SeriesPoint {
	ts: number; // epoch ms
	value: number;
}

/**
 * Returns time-ordered points for a (source, metric) pair within `windowMs`
 * back from now. Used by sparklines. Returns empty array if no matching rows.
 */
export function seriesForKey(
	rows: MetricRow[],
	source: string,
	metric: string,
	windowMs: number,
): SeriesPoint[] {
	const now = Date.now();
	const out: SeriesPoint[] = [];
	for (const r of rows) {
		if (r.source !== source || r.metric !== metric) continue;
		const ts = Date.parse(r.timestamp);
		if (!Number.isFinite(ts)) continue;
		if (now - ts > windowMs) continue;
		out.push({ ts, value: r.value });
	}
	out.sort((a, b) => a.ts - b.ts);
	return out;
}

export async function readMetricSeries(
	app: App,
	source: string,
	metric: string,
	windowMs: number,
): Promise<SeriesPoint[]> {
	const rows = await readMetricsCsv(app);
	return seriesForKey(rows, source, metric, windowMs);
}
