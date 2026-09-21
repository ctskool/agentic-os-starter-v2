import type { App } from "obsidian";

export type Verdict = "Hit" | "Steady" | "Miss" | "Climbing" | "Unknown";

export interface UploadRow {
	title: string;
	views: number | null;
	vsBaselinePct: number | null;
	likes: number | null;
	comments: number | null;
	verdict: Verdict;
}

export interface YtReview {
	path: string;
	date: string;
	window: string;
	channel: string;
	tldr: string[];
	uploads: UploadRow[];
	baselineViews: number | null;
	baselineLikes: number | null;
	topPerformer: { title: string; body: string } | null;
	underperformer: { title: string; body: string } | null;
	channelSignal: string[];
	recommendations: string[];
}

const DIR = "inbox/reports/yt-reviews";

export async function findLatestReview(app: App): Promise<string | null> {
	if (!(await app.vault.adapter.exists(DIR))) return null;
	const listing = await app.vault.adapter.list(DIR);
	const files = await Promise.all(listing.files.filter((file) => /\.md$/i.test(file)).map(async (file) => {
		let mtime: number | null = null;
		try {
			const stat = await app.vault.adapter.stat?.(file);
			if (stat?.type === "file" && Number.isFinite(stat.mtime)) mtime = stat.mtime;
		} catch { /* A report may disappear between listing and stat. */ }
		if (mtime === null) {
			const cached = app.vault.getAbstractFileByPath?.(file);
			const cachedTime = (cached as { stat?: { mtime?: unknown } } | null)?.stat?.mtime;
			if (typeof cachedTime === "number" && Number.isFinite(cachedTime)) mtime = cachedTime;
		}
		const date = /(?:^|\/)(\d{4}-\d{2}-\d{2})/.exec(file)?.[1] || "";
		return { file, time: mtime ?? (Date.parse(date + "T00:00:00Z") || 0), date };
	}));
	files.sort((a, b) => b.time - a.time || b.date.localeCompare(a.date) || b.file.localeCompare(a.file));
	return files[0]?.file ?? null;
}

export async function readLatestReview(app: App): Promise<YtReview | null> {
	const path = await findLatestReview(app);
	if (!path) return null;
	const raw = await app.vault.adapter.read(path);
	return parseReview(path, raw);
}

export function reviewPlainText(value: string): string {
	const entities: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&nbsp;": " ", "&lt;": "<", "&gt;": ">" };
	return value
		.replace(/!?\[([^\]]*)\]\((?:[^()\\]|\\[\s\S]|\([^()]*\))*\)/g, "$1")
		.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
		.replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, "$1")
		.replace(/<br\s*\/?>/gi, " ").replace(/<\/?[a-z][^>]*>/gi, "")
		.replace(/&(?:amp|quot|apos|nbsp|lt|gt);/gi, entity => entities[entity.toLowerCase()] || entity)
		.replace(/&#(x[\da-f]+|\d+);/gi, (entity, digits: string) => { const n = parseInt(digits.replace(/^x/i, ""), /^x/i.test(digits) ? 16 : 10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : entity; })
		.replace(/(?:\*\*|__|~~|`+)/g, "").replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, "$1$2")
		.replace(/\\([\\`*_{}\[\]()#+.!|>-])/g, "$1").replace(/\s+/g, " ").trim();
}

function parseLooseNumber(value: string): number | null {
	const clean = reviewPlainText(value).replace(/[,\s]/g, "").replace(/^[~≈]/, "").replace(/%$/, "");
	const match = /^(\d+(?:\.\d+)?|\.\d+)([kmb])?$/i.exec(clean);
	if (!match) return null;
	const scale: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };
	const n = Number(match[1]) * (scale[match[2]?.toLowerCase() || ""] || 1);
	return Number.isFinite(n) ? n : null;
}

function textBlocks(body: string): { list: boolean; text: string }[] {
	const blocks: { list: boolean; text: string }[] = [];
	let current = "", list = false, fenced = false;
	const flush = () => { if (current.trim()) blocks.push({ list, text: reviewPlainText(current) }); current = ""; list = false; };
	for (const raw of body.split("\n")) {
		const line = raw.trim();
		if (/^(?:```|~~~)/.test(line)) { flush(); fenced = !fenced; continue; }
		if (fenced) continue;
		if (!line || /^#{1,6}\s/.test(line) || line.startsWith("|")) { flush(); continue; }
		const item = /^(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)/.exec(line);
		if (item) { flush(); list = true; current = item[1] || ""; }
		else current += (current ? " " : "") + line;
	}
	flush(); return blocks;
}

function extractItems(body: string, paragraphs = false): string[] {
	const blocks = textBlocks(body), listed = blocks.filter(block => block.list);
	return (paragraphs || listed.length === 0 ? blocks : listed).map(block => block.text);
}

function tableCells(raw: string): string[] | null {
	const line = raw.trim(); if (!line.includes("|")) return null;
	const cells: string[] = []; let cell = "", codeTicks = 0;
	for (let index = 0; index < line.length; index++) {
		const char = line[index]!;
		if (char === "\\" && index + 1 < line.length) { cell += char + line[++index]; continue; }
		if (char === "`") { let count = 1; while (line[index + count] === "`") count++; if (!codeTicks) codeTicks = count; else if (codeTicks === count) codeTicks = 0; cell += "`".repeat(count); index += count - 1; continue; }
		if (char === "|" && !codeTicks) { cells.push(cell.trim()); cell = ""; } else cell += char;
	}
	cells.push(cell.trim()); if (line.startsWith("|")) cells.shift(); if (line.endsWith("|")) cells.pop(); return cells;
}

function parseUploadTable(body: string): UploadRow[] {
	const out: UploadRow[] = [], lines = body.split("\n");
	for (let index = 1; index < lines.length; index++) {
		const separator = tableCells(lines[index]!), header = tableCells(lines[index - 1]!);
		if (!separator || !header || separator.length !== header.length || !separator.every(cell => /^:?-{3,}:?$/.test(cell))) continue;
		const labels = header.map(cell => reviewPlainText(cell).toLowerCase().replace(/[^a-z]/g, ""));
		const column = (...names: string[]) => labels.findIndex(label => names.includes(label));
		const titleIndex = column("video", "title", "upload"), viewsIndex = column("views", "viewcount");
		if (titleIndex < 0 || viewsIndex < 0) continue;
		const baselineIndex = column("vsbaseline", "baseline", "ofbaseline", "baselineviews"), likesIndex = column("likes", "likecount"), commentsIndex = column("comments", "commentcount"), verdictIndex = column("verdict", "status");
		while (index + 1 < lines.length) {
			const cells = tableCells(lines[index + 1]!); if (!cells || cells.length !== header.length) break;
			index++; const title = reviewPlainText(cells[titleIndex] || ""); if (!title) continue;
			const label = reviewPlainText(cells[verdictIndex] || "");
			const verdict: Verdict = /\bclimbing\b/i.test(label) ? "Climbing" : /\bhit\b/i.test(label) ? "Hit" : /\bsteady\b/i.test(label) ? "Steady" : /\bmiss\b/i.test(label) ? "Miss" : "Unknown";
			out.push({ title, views: parseLooseNumber(cells[viewsIndex] || ""), vsBaselinePct: parseLooseNumber(cells[baselineIndex] || ""), likes: parseLooseNumber(cells[likesIndex] || ""), comments: parseLooseNumber(cells[commentsIndex] || ""), verdict });
		}
	}
	return out;
}

export function parseReview(path: string, raw: string): YtReview {
	raw = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	const fm: Record<string, string> = {};
	const fmMatch = raw.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
	if (fmMatch) {
		for (const line of fmMatch[1]!.split("\n")) {
			const m = line.match(/^(\w+):\s*(.*)$/);
			if (m) {
				let value = m[2]!.trim();
				if (value.startsWith('"') && value.endsWith('"')) { try { value = JSON.parse(value) as string; } catch { value = value.slice(1, -1); } }
				else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
				fm[m[1]!] = value;
			}
		}
	}
	const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;

	const sections = new Map<string, string>();
	let cur = "_pre";
	let buf: string[] = [];
	for (const line of body.split("\n")) {
		const m = line.match(/^##\s+(.+?)\s*$/);
		if (m) {
			sections.set(cur, buf.join("\n").trim());
			cur = reviewPlainText(m[1]!.replace(/\s+#+$/, ""));
			buf = [];
		} else {
			buf.push(line);
		}
	}
	sections.set(cur, buf.join("\n").trim());

	const section = (name: string) => [...sections].find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || "";
	const tldr = extractItems(section("TL;DR"));

	const uploadsRaw = section("Uploads this week");
	const uploads = parseUploadTable(uploadsRaw);

	let baselineViews: number | null = null;
	let baselineLikes: number | null = null;
	const baselineBlocks = textBlocks(uploadsRaw).filter(block => /\bbaseline\b|\bmedian\b/i.test(block.text)).map(block => block.text);
	for (const [heading, text] of sections) if (/\bbaseline\b/i.test(heading)) baselineBlocks.push(reviewPlainText(text));
	const number = "(?:\\d[\\d,]*(?:\\.\\d+)?|\\.\\d+)[kmb]?";
	for (const block of baselineBlocks) {
		const metric = (name: string) => {
			const suffix = new RegExp(`(${number})\\s+(?:median\\s+)?${name}\\b`, "i").exec(block);
			const prefix = new RegExp(`\\b${name}(?:\\s+(?:median|baseline))?\\s*[:=]\\s*(${number})`, "i").exec(block);
			return parseLooseNumber((prefix || suffix)?.[1] || "");
		};
		baselineViews ??= metric("views"); baselineLikes ??= metric("likes");
	}

	let topPerformer: YtReview["topPerformer"] = null;
	let underperformer: YtReview["underperformer"] = null;
	for (const [key, val] of sections.entries()) {
		if (/^Top performer\b/i.test(key)) {
			const m = key.match(/Top performer\s*[—–:-]\s*(.+)/i);
			topPerformer = {
				title: m ? m[1]!.trim() : key,
				body: val,
			};
		}
		if (/^Underperformer\b/i.test(key)) {
			const m = key.match(/Underperformer\s*[—–:-]\s*(.+)/i);
			underperformer = {
				title: m ? m[1]!.trim() : key,
				body: val,
			};
		}
	}

	const channelSignal = extractItems(section("Channel-wide signal"), true);
	const recommendations = extractItems(section("Recommended next 7 days"));

	return {
		path,
		date: fm.date || "",
		window: fm.window || "",
		channel: fm.channel || "",
		tldr,
		uploads,
		baselineViews,
		baselineLikes,
		topPerformer,
		underperformer,
		channelSignal,
		recommendations,
	};
}
