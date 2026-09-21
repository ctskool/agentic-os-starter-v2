import type { App } from "obsidian";
import { reviewPlainText } from "./ytReview";

export interface YtTrendingRow {
	title: string;
	creator: string;
	views: string;
	posted: string;
}

export interface MorningBrief {
	path: string;
	date: string;
	headlines: string[];
	/** intel's ## Top Story lead paragraph (empty for legacy formats) */
	topStory: string;
	ytTrending: YtTrendingRow[];
	xVoices: string[];
	contentOpportunities: string[];
	webCount: number;
	xVoicesCount: number;
	hnCount: number;
	repoCount: number;
}

// converged 2026-08-14: interactive /morning-intel writes research/morning-intel
// natively and the runner now matches; reports/morning stays as legacy fallback
export const MORNING_DIRS = [
	"inbox/research/morning-intel",
	"inbox/reports/morning",
];

export async function findLatestBrief(app: App): Promise<string | null> {
	const mds: string[] = [];
	for (const dir of MORNING_DIRS) {
		if (!(await app.vault.adapter.exists(dir))) continue;
		const listing = await app.vault.adapter.list(dir);
		for (const f of listing.files) {
			if (f.endsWith(".md") && !f.endsWith("_index.md")) mds.push(f);
		}
	}
	if (mds.length === 0) return null;
	// morning-intel is THE morning source — among the newest date's files,
	// prefer the -intel deliverable over legacy morning-report/routine
	const dateOf = (p: string) => p.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
	mds.sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
	const newest = mds[mds.length - 1]!;
	const newestDate = dateOf(newest);
	const intel = mds
		.filter((f) => dateOf(f) === newestDate && /-intel/.test(f))
		.pop();
	return intel ?? newest;
}

export async function readLatestBrief(app: App): Promise<MorningBrief | null> {
	const path = await findLatestBrief(app);
	if (!path) return null;
	const raw = await app.vault.adapter.read(path);
	return parseBrief(path, raw);
}

export function parseBrief(path: string, raw: string): MorningBrief {
	raw = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	// Date — try frontmatter, then **Date:** line, then filename prefix
	let date = "";
	const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
	if (fmMatch) {
		const dm = fmMatch[1]!.match(/^date:\s*(.+)$/m);
		if (dm) date = dm[1]!.trim();
	}
	if (!date) {
		const dm = raw.match(/\*\*Date:\*\*\s*(\S+)/);
		if (dm) date = dm[1]!.trim();
	}
	if (!date) {
		const fileM = path.match(/(\d{4}-\d{2}-\d{2})/);
		if (fileM) date = fileM[1]!;
	}

	const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;

	// two section views:
	//   flat — every ##/### heading is its own bucket (routine nests
	//          "### Headlines" under "## 📡 …")
	//   deep — ## buckets INCLUDE their ### children (intel nests
	//          "### YouTube video ideas" under "## So What — Content Plan")
	// findSection prefers a non-empty flat hit, then falls back to deep.
	const flat = new Map<string, string>();
	const deep = new Map<string, string>();
	{
		let curFlat = "_pre";
		let curDeep = "_pre";
		let bufFlat: string[] = [];
		let bufDeep: string[] = [];
		for (const line of body.split("\n")) {
			const m = line.match(/^(#{2,3})\s+(.+?)\s*$/);
			if (m) {
				flat.set(curFlat, bufFlat.join("\n").trim());
				curFlat = m[2]!;
				bufFlat = [];
				if (m[1] === "##") {
					deep.set(curDeep, bufDeep.join("\n").trim());
					curDeep = m[2]!;
					bufDeep = [];
					continue;
				}
			}
			if (!m) bufFlat.push(line);
			bufDeep.push(line);
		}
		flat.set(curFlat, bufFlat.join("\n").trim());
		deep.set(curDeep, bufDeep.join("\n").trim());
	}

	const findIn = (map: Map<string, string>, needle: string): string => {
		const lc = needle.toLowerCase();
		for (const [k, v] of map.entries()) {
			if (k.toLowerCase().includes(lc)) return v;
		}
		return "";
	};
	const findSection = (needle: string): string =>
		findIn(flat, needle) || findIn(deep, needle);

	// intel headings first, legacy names as fallback
	const headlines = extractBullets(
		findSection("TL;DR") || findSection("Headlines"),
	);

	const oppsBody =
		findIn(deep, "So What") || findIn(deep, "Content Opportunities") || findSection("Content Opportunities");
	const contentOpportunities = extractOpportunities(oppsBody);

	const ytBody = findSection("YouTube Radar") || findSection("YouTube");
	const ytTrending = parseYtTable(ytBody);

	const xBody = findSection("X / Twitter") || findSection("X — ");
	const xVoices = extractXVoices(xBody);

	const webCount =
		countBullets(findSection("AI News")) ||
		countBullets(findSection("Web —")) ||
		countBullets(findSection("Web "));
	const xVoicesCount = xVoices.length || countBullets(xBody);
	const hnCount = countBullets(findSection("Hacker News"));
	const repoCount = countRepos(
		findSection("GitHub Radar") || findSection("GitHub"),
	);

	// intel's Top Story lead — first non-empty paragraph, links stripped
	const topStory = reviewPlainText(findSection("Top Story")
		.split(/\n\s*\n/)[0]!)
		.replace(/https?:\/\/\S+/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 320);

	return {
		path,
		date,
		headlines,
		topStory,
		ytTrending,
		xVoices,
		contentOpportunities,
		webCount,
		xVoicesCount,
		hnCount,
		repoCount,
	};
}

function parseYtTable(body: string): YtTrendingRow[] {
	const out: YtTrendingRow[] = [];
	let sawSeparator = false;
	for (const rawLine of body.split("\n")) {
		const line = rawLine.trim();
		if (!line.startsWith("|")) continue;
		const cells = line
			.split("|")
			.slice(1, -1)
			.map((s) => s.trim());
		if (cells.length < 4) continue;
		const head = cells[0]!.toLowerCase();
		if (head === "video" || head === "title") continue;
		if (cells.every((c) => /^-+$/.test(c))) {
			sawSeparator = true;
			continue;
		}
		if (!sawSeparator) continue;
		out.push({
			title: cells[0]!,
			creator: cells[1]!,
			views: cells[2]!,
			posted: cells[3]!,
		});
	}
	return out;
}

function extractXVoices(body: string): string[] {
	// Look for the "Top voices:" sub-bullet group first
	const lines = body.split("\n");
	const voices: string[] = [];
	let inVoices = false;
	for (const raw of lines) {
		const line = raw.trim();
		if (/^[-*]\s+\*\*Top voices:?\*\*/i.test(line)) {
			inVoices = true;
			continue;
		}
		if (inVoices) {
			if (/^[-*]\s+\*\*[A-Z]/.test(line)) {
				// next top-level bullet — stop
				if (!line.startsWith("  ") && !line.startsWith("\t")) break;
			}
			// nested bullet ("  - " or "    - ")
			const nested = line.match(
				/^\s*[-*]\s+\*\*([^*]+):?\*\*\s*[:—-]?\s*["“]?([^"”]*)["”]?\s*$/,
			);
			if (nested) {
				const who = nested[1]!.replace(/:$/, "").trim();
				const what = nested[2]!.trim();
				voices.push(what ? `${who}: ${what}` : who);
			}
		}
	}
	if (voices.length > 0) return voices;
	// Fallback: take top bullets in section
	return extractBullets(body)
		.slice(0, 3)
		.map((b) => b.replace(/\*\*([^*]+)\*\*/g, "$1").trim());
}

function extractBullets(body: string): string[] {
	return body
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.startsWith("-") || l.startsWith("*"))
		.map((l) => l.replace(/^[-*]\s+/, ""));
}

function countBullets(body: string): number {
	return extractBullets(body).length;
}

function countRepos(body: string): number {
	// Best-effort — counts inline code-fenced repo refs like `owner/name` or bullets
	const ticks = body.match(/`[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+`/g);
	return ticks ? ticks.length : countBullets(body);
}

/** Read ranked idea titles, preserving list hierarchy instead of promoting
 * each nested supporting field into a separate opportunity. */
function extractOpportunities(body: string): string[] {
	let lines = body.split("\n");
	// The content plan can also include LinkedIn posts and short-form spin-offs.
	// Its ranked YouTube list is the dashboard's primary opportunity list.
	const youtube = lines.findIndex(line => /^#{3,6}\s+.*\byoutube\b/i.test(line));
	if (youtube >= 0) {
		const depth = lines[youtube]!.match(/^#+/)![0].length;
		const end = lines.findIndex((line, index) => index > youtube && /^(#{2,6})\s/.test(line) && line.match(/^#+/)![0].length <= depth);
		lines = lines.slice(youtube + 1, end < 0 ? undefined : end);
	}
	const entries: { indent: number; text: string; numbered: boolean }[] = [];
	let fenced = false;
	for (const line of lines) {
		if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
		if (fenced) continue;
		const entry = /^([ \t]*)([-*+]|\d+[.)])\s+(.+)$/.exec(line);
		if (entry) entries.push({ indent: entry[1]!.replace(/\t/g, "    ").length, text: entry[3]!, numbered: /^\d/.test(entry[2]!) });
	}
	const indent = Math.min(...entries.map(entry => entry.indent));
	const topLevel = entries.filter(entry => entry.indent === indent);
	const numbered = topLevel.filter(entry => entry.numbered);
	const candidates = numbered.length ? numbered : topLevel;
	const titles = candidates.map(entry => {
		const bold = /^(?:\*\*([^*]+)\*\*|__([^_]+)__)/.exec(entry.text);
		const title = (bold?.[1] ?? bold?.[2] ?? entry.text).trim();
		// A bold field label such as "Hook:" is supporting metadata, not a title.
		if (bold && /:\s*$/.test(title)) return "";
		return reviewPlainText(title).replace(/^["“]([^"”]+)["”](?=\s*(?:\(|$))/, "$1").trim();
	}).filter(Boolean);
	return [...new Set(titles)];
}
