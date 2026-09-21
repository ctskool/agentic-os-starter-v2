import type { App, TFile } from "obsidian";

export type TrendingSection =
	| "week"
	| "month"
	| "velocity-day"
	| "velocity-month";

export interface TrendingRepo {
	rank: number;
	owner: string;
	name: string;
	url: string;
	stars: string;
	language: string;
	description: string;
	aiDev: boolean;
	section: TrendingSection;
	/** "Fastest Growing" only: stars gained this month, e.g. "+11,171". */
	growth?: string;
}

export interface HeadlineItem {
	bold: string;
	body: string;
}

export interface ReportSnapshot<T> {
	sourcePath: string;
	dateLabel: string;
	items: T[];
}

const GITHUB_TRENDING_FOLDER = "inbox/research/github-trending";
const MORNING_REPORTS_FOLDER = "inbox/reports/morning";
// converged 2026-08-14: interactive /morning-intel writes here natively and
// the runner now matches; the reports/morning folder stays as legacy fallback
const MORNING_INTEL_FOLDER = "inbox/research/morning-intel";
/** every folder a morning brief may land in — cards watch these for refresh */
export const MORNING_FOLDERS = [MORNING_INTEL_FOLDER, MORNING_REPORTS_FOLDER];
const OUTLIER_RADAR_FOLDER = "inbox/research/outlier-radar";

export interface OutlierItem {
	title: string;
	url: string;
	/** multiplier vs channel baseline, e.g. "64.9x" or ">100x" */
	mult: string;
	viewsAge: string;
	channel: string;
	subs: string;
	via: string;
}

function latestFileIn(
	app: App,
	folder: string | string[],
	prefer?: RegExp,
): TFile | null {
	const folders = Array.isArray(folder) ? folder : [folder];
	const candidates: TFile[] = [];
	for (const f of folders) {
		const af = app.vault.getAbstractFileByPath(f);
		if (!af || !("children" in af)) continue;
		for (const c of (af as unknown as { children: TFile[] }).children) {
			if ("extension" in c && c.extension === "md" && !c.name.startsWith("_")) {
				candidates.push(c);
			}
		}
	}
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => b.name.localeCompare(a.name));
	// among files sharing the newest date prefix, prefer the flagged writer
	// (morning-intel is THE morning source; legacy formats are fallback)
	if (prefer) {
		const newest = dateFromFilename(candidates[0]!.name);
		const sameDay = candidates.filter(
			(c) => dateFromFilename(c.name) === newest,
		);
		const preferred = sameDay.find((c) => prefer.test(c.name));
		if (preferred) return preferred;
	}
	return candidates[0] ?? null;
}

function dateFromFilename(name: string): string {
	const m = name.match(/(\d{4}-\d{2}-\d{2})/);
	return m?.[1] ?? name.replace(/\.md$/, "");
}

export async function readLatestGithubTrending(
	app: App,
): Promise<ReportSnapshot<TrendingRepo> | null> {
	const file = latestFileIn(app, GITHUB_TRENDING_FOLDER);
	if (!file) return null;
	const body = await app.vault.read(file);
	const repos = parseTrendingRepos(body);
	return {
		sourcePath: file.path,
		dateLabel: dateFromFilename(file.name),
		items: repos,
	};
}

export async function readLatestMorningHeadlines(
	app: App,
): Promise<ReportSnapshot<HeadlineItem> | null> {
	const file = latestFileIn(app, MORNING_FOLDERS, /-intel/);
	if (!file) return null;
	const body = await app.vault.read(file);
	const items = parseHeadlines(body);
	return {
		sourcePath: file.path,
		dateLabel: dateFromFilename(file.name),
		items,
	};
}

/** Freshest of two sources: the radar skill's own dated file, or the
 *  Small-Channel Outliers table embedded in the morning-intel brief —
 *  whichever is newer wins (ties go to the radar file: fuller data). */
export async function readLatestOutliers(
	app: App,
): Promise<ReportSnapshot<OutlierItem> | null> {
	const radar = await radarFileOutliers(app);
	const intel = await intelOutliers(app);
	if (!radar || radar.items.length === 0) return intel ?? radar;
	if (!intel || intel.items.length === 0) return radar;
	return intel.dateLabel > radar.dateLabel ? intel : radar;
}

async function radarFileOutliers(
	app: App,
): Promise<ReportSnapshot<OutlierItem> | null> {
	const file = latestFileIn(app, OUTLIER_RADAR_FOLDER);
	if (!file) return null;
	const body = await app.vault.read(file);
	return {
		sourcePath: file.path,
		dateLabel: dateFromFilename(file.name),
		items: parseOutliers(body),
	};
}

async function intelOutliers(
	app: App,
): Promise<ReportSnapshot<OutlierItem> | null> {
	const file = latestFileIn(app, MORNING_FOLDERS, /-intel/);
	if (!file || !/-intel/.test(file.name)) return null;
	const body = await app.vault.read(file);
	return {
		sourcePath: file.path,
		dateLabel: dateFromFilename(file.name),
		items: parseIntelOutlierTable(body),
	};
}

/** morning-intel's `### Small-Channel Outliers` markdown table:
 *  | [title](url) | [channel](…) (2.7k subs) | 68.2k in 6.6d | 64.9x | via |  */
export function parseIntelOutlierTable(md: string): OutlierItem[] {
	const out: OutlierItem[] = [];
	const start = md.search(/^#{2,3}\s+Small-Channel Outliers/m);
	if (start < 0) return out;
	const rest = md.slice(start);
	const endIdx = rest.slice(1).search(/^#{2,3}\s+/m);
	const section = endIdx > 0 ? rest.slice(0, endIdx + 1) : rest;
	for (const rawLine of section.split("\n")) {
		const line = rawLine.trim();
		if (!line.startsWith("|")) continue;
		const cells = line
			.split("|")
			.slice(1, -1)
			.map((s) => s.trim());
		if (cells.length < 4) continue;
		if (/^-+$/.test(cells[0]!) || /^title$/i.test(cells[0]!)) continue;
		const t = cells[0]!.match(/\[([^\]]+)\]\(([^)]+)\)/);
		if (!t) continue;
		const ch = cells[1]!.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
		const chm = ch.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
		// column order per the skill template: views/age then multiplier —
		// but tolerate the swap (the model writing the brief sometimes flips)
		const looksMult = (s: string) => /^[>~]?\d+(\.\d+)?x$/i.test(s);
		const mult = looksMult(cells[3]!)
			? cells[3]!
			: looksMult(cells[2]!)
				? cells[2]!
				: "";
		const viewsAge = looksMult(cells[3]!) ? cells[2]! : cells[3]!;
		if (!mult) continue;
		out.push({
			title: t[1]!.trim(),
			url: t[2]!.trim(),
			mult,
			viewsAge: viewsAge ?? "",
			channel: (chm?.[1] ?? ch).trim(),
			subs: (chm?.[2] ?? "").trim(),
			via: (cells[4] ?? "").replace(/[`"]/g, "").trim(),
		});
	}
	return out;
}

/** Radar bullet shape (one per video, repeated across `## Run HH:MM` blocks):
 *  - **[title](url)** — **12.3x** | 55.9k views in 2.4d | [channel](url) (53.8k subs) | via search "q"
 *  Deduped by title — the same outlier reappears in later runs. */
export function parseOutliers(md: string): OutlierItem[] {
	const out: OutlierItem[] = [];
	const seen = new Set<string>();
	// tolerates the optional "(vel 31.5x)" annotation after the multiplier
	// and both via forms: `via search "q"` / `via watchlist (Name)`
	const lineRe =
		/^-\s+\*\*\[([^\]]+)\]\(([^)]+)\)\*\*\s+—\s+\*\*([^*]+)\*\*(?:\s*\([^)]*\))?\s*\|\s*([^|]+?)\s*\|\s*\[([^\]]+)\]\([^)]*\)\s*\(([^)]+)\)\s*(?:\|\s*via\s+(.+?))?\s*$/gm;
	let m: RegExpExecArray | null;
	while ((m = lineRe.exec(md)) !== null) {
		const title = (m[1] ?? "").trim();
		if (!title || seen.has(title)) continue;
		seen.add(title);
		out.push({
			title,
			url: (m[2] ?? "").trim(),
			mult: (m[3] ?? "").trim(),
			viewsAge: (m[4] ?? "").trim(),
			channel: (m[5] ?? "").trim(),
			subs: (m[6] ?? "").trim(),
			via: (m[7] ?? "").trim(),
		});
	}
	return out;
}

/** Classify a `## ` heading line into a trending section bucket. */
function sectionFor(heading: string): TrendingSection {
	if (/Fastest Growing/i.test(heading)) {
		return /24h/i.test(heading) ? "velocity-day" : "velocity-month";
	}
	if (/This Month/i.test(heading)) return "month";
	return "week";
}

export function parseTrendingRepos(md: string): TrendingRepo[] {
	const out: TrendingRepo[] = [];
	// Locate every `## ` heading so each repo block can be tagged with the section
	// it falls under (the report now has three: week, month, fastest-growing).
	const headingRe = /^##\s+(.+)$/gm;
	const headings: { idx: number; section: TrendingSection }[] = [];
	let hm: RegExpExecArray | null;
	while ((hm = headingRe.exec(md)) !== null) {
		headings.push({ idx: hm.index, section: sectionFor(hm[1] ?? "") });
	}
	const sectionAt = (idx: number): TrendingSection => {
		let s: TrendingSection = "week";
		for (const h of headings) {
			if (h.idx <= idx) s = h.section;
			else break;
		}
		return s;
	};

	const blockRe =
		/^###\s+(\d+)\.\s+\[([^\]]+)\]\(([^)]+)\)(\s+\*\*\[AI\/DEV\]\*\*)?/gm;
	const matches: { rank: number; full: string; url: string; aiDev: boolean; idx: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = blockRe.exec(md)) !== null) {
		matches.push({
			rank: Number(m[1] ?? "0"),
			full: m[2] ?? "",
			url: m[3] ?? "",
			aiDev: Boolean(m[4]),
			idx: m.index,
		});
	}
	for (let i = 0; i < matches.length; i++) {
		const cur = matches[i];
		if (!cur) continue;
		const next = matches[i + 1];
		const blockEnd = next ? next.idx : md.length;
		const block = md.slice(cur.idx, blockEnd);
		const stars = (block.match(/\*\*Stars:\*\*\s*([0-9.,k]+)/i)?.[1] ?? "").trim();
		const lang = (block.match(/\*\*Language:\*\*\s*([A-Za-z+#.\-]+)/)?.[1] ?? "").trim();
		const desc = (block.match(/\*\*Description:\*\*\s*(.*)/m)?.[1] ?? "").trim();
		const growth = (block.match(/\*\*Growth:\*\*\s*(\+[0-9.,k]+)/i)?.[1] ?? "").trim();
		const parts = cur.full.split("/");
		const owner = parts.length > 1 ? (parts[0] ?? "") : "";
		const name = parts.length > 1 ? (parts[1] ?? cur.full) : cur.full;
		out.push({
			rank: cur.rank,
			owner,
			name,
			url: cur.url,
			stars,
			language: lang,
			description: desc,
			aiDev: cur.aiDev,
			section: sectionAt(cur.idx),
			growth: growth || undefined,
		});
	}
	return out;
}

export function parseHeadlines(md: string): HeadlineItem[] {
	const out: HeadlineItem[] = [];
	// morning-intel's ## TL;DR is the preferred source; ## / ### Headlines
	// covers the legacy morning-report and /morning routine formats
	const sectionRes = [/^##\s+TL;DR\s*$/m, /^#{2,3}\s+Headlines\s*$/m];
	let start = -1;
	for (const re of sectionRes) {
		start = md.search(re);
		if (start >= 0) break;
	}
	if (start < 0) return out;
	const rest = md.slice(start);
	const endIdx = rest.slice(1).search(/^#{2,3}\s+/m);
	const section = endIdx > 0 ? rest.slice(0, endIdx + 1) : rest;
	// bolded "- **head** — body" bullets first; plain bullets as fallback
	// (intel TL;DR bullets aren't always bolded)
	const boldRe = /^-\s+\*\*([^*]+)\*\*\s*[—-]?\s*(.*)$/gm;
	let m: RegExpExecArray | null;
	while ((m = boldRe.exec(section)) !== null) {
		const bold = (m[1] ?? "").trim();
		const body = (m[2] ?? "").trim();
		if (bold) out.push({ bold, body });
	}
	if (out.length > 0) return out;
	const plainRe = /^-\s+(.+)$/gm;
	while ((m = plainRe.exec(section)) !== null) {
		const text = (m[1] ?? "")
			.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
			.replace(/[*_`]/g, "")
			.trim();
		if (text) out.push({ bold: text, body: "" });
	}
	return out;
}
