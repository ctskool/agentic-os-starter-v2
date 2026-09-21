import type { App, TFile } from "obsidian";

export const SUPPORTED_SCHEMA_VERSION = 1;

export interface DailyNoteFrontmatter {
	date: string;
	schema_version: number;
	focus?: string;
	top3?: string[];
	top3_done?: boolean[];
	effort?: number | null;
	focus_blocks?: number | null;
	posts_shipped?: Record<string, number>;
	videos_shipped_today?: number;
}

export interface Top3Item {
	text: string;
	done: boolean;
}

export interface ScheduleEntry {
	time: string;
	title: string;
}

export interface DriverItem {
	text: string;
	done: boolean;
}

export interface DailyNoteRead {
	path: string;
	date: string;
	schemaVersion: number;
	supported: boolean;
	focus: string;
	top3: Top3Item[];
	schedule: ScheduleEntry[];
	drivers: DriverItem[];
	activityLog: string;
	notes: string;
	eodReflection: string;
}

export function todayIso(): string {
	const d = new Date();
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

export function todayPath(): string {
	return `daily-notes/${todayIso()}.md`;
}

// Split a markdown body into a map keyed by exact section heading text (level 2).
// Body must already be stripped of frontmatter and the leading H1.
function splitSections(body: string): Map<string, string> {
	const out = new Map<string, string>();
	const lines = body.split(/\r?\n/);
	let currentHeading: string | null = null;
	let buf: string[] = [];
	const flush = () => {
		if (currentHeading !== null) {
			out.set(currentHeading, buf.join("\n").trim());
		}
	};
	for (const line of lines) {
		const m = line.match(/^##\s+(.+?)\s*$/);
		if (m) {
			flush();
			currentHeading = m[1]!;
			buf = [];
		} else if (currentHeading !== null) {
			buf.push(line);
		}
	}
	flush();
	return out;
}

function stripFrontmatter(raw: string): string {
	if (!raw.startsWith("---")) return raw;
	const end = raw.indexOf("\n---", 3);
	if (end < 0) return raw;
	return raw.slice(end + 4).replace(/^\r?\n/, "");
}

function parseTop3(section: string, doneFromFm: boolean[] | undefined): Top3Item[] {
	const items: Top3Item[] = [];
	for (const line of section.split(/\r?\n/)) {
		const m = line.match(/^\s*\d+\.\s+\[([ xX])\]\s+(.*)$/);
		if (m) {
			items.push({
				text: m[2]!.trim(),
				done: m[1]!.toLowerCase() === "x",
			});
		}
	}
	// Frontmatter `top3_done` wins on conflict — that's the canonical state if /close-day has run.
	if (doneFromFm) {
		for (let i = 0; i < items.length && i < doneFromFm.length; i++) {
			const flag = doneFromFm[i];
			if (flag !== undefined) {
				items[i]!.done = items[i]!.done || flag;
			}
		}
	}
	return items;
}

function parseSchedule(section: string): ScheduleEntry[] {
	const out: ScheduleEntry[] = [];
	for (const line of section.split(/\r?\n/)) {
		const m = line.match(/^\s*-\s+(\d{2}:\d{2})\s+[—\-–]\s+(.+)$/);
		if (m) out.push({ time: m[1]!, title: m[2]!.trim() });
	}
	return out;
}

function parseDrivers(section: string): DriverItem[] {
	const out: DriverItem[] = [];
	for (const line of section.split(/\r?\n/)) {
		const m = line.match(/^\s*-\s+\[([ xX])\]\s+(.*)$/);
		if (m) out.push({ text: m[2]!.trim(), done: m[1]!.toLowerCase() === "x" });
	}
	return out;
}

export async function readDailyNote(
	app: App,
	path: string = todayPath(),
): Promise<DailyNoteRead | null> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!file || !("extension" in file)) return null;
	const tfile = file as TFile;

	const fmCache = app.metadataCache.getFileCache(tfile)?.frontmatter as
		| DailyNoteFrontmatter
		| undefined;

	const raw = await app.vault.cachedRead(tfile);
	const body = stripFrontmatter(raw);
	const sections = splitSections(body);

	const schemaVersion = fmCache?.schema_version ?? 0;
	const supported = schemaVersion === SUPPORTED_SCHEMA_VERSION;

	return {
		path,
		date: fmCache?.date ?? path.replace(/^.*\//, "").replace(/\.md$/, ""),
		schemaVersion,
		supported,
		focus: (fmCache?.focus || sections.get("Current Focus") || "").trim(),
		top3: parseTop3(sections.get("Top 3 Priorities") ?? "", fmCache?.top3_done),
		schedule: parseSchedule(sections.get("Schedule") ?? ""),
		drivers: parseDrivers(sections.get("Daily Drivers") ?? ""),
		activityLog: sections.get("Activity Log") ?? "",
		notes: sections.get("Notes") ?? "",
		eodReflection: sections.get("EOD Reflection") ?? "",
	};
}
