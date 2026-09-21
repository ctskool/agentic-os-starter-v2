export interface HNStory {
	id: number;
	title: string;
	url: string;
	by: string;
	score: number;
	descendants: number;
	time: number;
}

const TOPSTORIES_URL = "https://hacker-news.firebaseio.com/v0/topstories.json";
const ITEM_URL = (id: number) =>
	`https://hacker-news.firebaseio.com/v0/item/${id}.json`;

export async function fetchHNTop(limit = 5): Promise<HNStory[]> {
	const idsResp = await fetch(TOPSTORIES_URL);
	if (!idsResp.ok) throw new Error(`HN topstories failed: ${idsResp.status}`);
	const ids = (await idsResp.json()) as number[];
	const slice = ids.slice(0, limit);
	const items = await Promise.all(
		slice.map(async (id) => {
			const r = await fetch(ITEM_URL(id));
			if (!r.ok) return null;
			const j = (await r.json()) as Partial<HNStory> | null;
			if (!j || typeof j.id !== "number") return null;
			return {
				id: j.id,
				title: j.title ?? "(untitled)",
				url: j.url ?? `https://news.ycombinator.com/item?id=${j.id}`,
				by: j.by ?? "",
				score: j.score ?? 0,
				descendants: j.descendants ?? 0,
				time: j.time ?? 0,
			} as HNStory;
		}),
	);
	return items.filter((x): x is HNStory => x !== null);
}

export function hnCommentsUrl(id: number): string {
	return `https://news.ycombinator.com/item?id=${id}`;
}
