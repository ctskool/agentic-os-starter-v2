import { Notice, type App, type Plugin } from "obsidian";

import { assertTestVault, readSelection } from './provider';
import { SKILLS, validateIntent } from '../../shared/contract.mjs';
import {workRequest} from './work';
import {assertVoiceVault} from './v2-voice';
import {SkillReportTracker} from './skill-reports';
import type {VoiceSelection} from '../../shared/voice-session';
import {createResourceCache} from '../../shared/resource-cache.mjs';
export const QUEUE_DIR = "system/v2/queue";
export const RUNS_DIR = "system/v2/runs";
// Dashboard instances share one scan per vault. Events invalidate immediately;
// the short TTL catches changes missed by a vault watcher. Bound retained apps.
const recentRunsCache=createResourceCache(10000,Date.now,8);
export const invalidateRecentRuns=(app:App)=>recentRunsCache.invalidate(app);
const reportTrackers=new WeakMap<App,SkillReportTracker>();

/** One watcher belongs to the plugin, not to each dashboard or voice orb. */
export function registerSkillReports(plugin:Plugin){
 const app=plugin.app;
 reportTrackers.get(app)?.dispose();
 let timer:ReturnType<typeof setInterval>|undefined;
 const tracker=new SkillReportTracker({
  read:id=>readRun(app,id),
  ready:async path=>!!app.vault.getFileByPath(path),
  open:async path=>{
   const file=app.vault.getFileByPath(path);
   if(!file)throw new Error('The report is no longer available.');
   const existing=app.workspace.getLeavesOfType('markdown').find(leaf=>(leaf.view as unknown as {file?:{path:string}}).file?.path===path);
   if(existing){await app.workspace.revealLeaf(existing);return}
   await app.workspace.getLeaf('tab').openFile(file);
  },
  notice:message=>{new Notice(message)},
  changed:pending=>{
   if(pending&&!timer)timer=setInterval(()=>void tracker.check(),2_000);
   if(!pending&&timer){clearInterval(timer);timer=undefined}
  },
 });
 reportTrackers.set(app,tracker);
 const changed=(file:{path:string})=>{if(file.path.startsWith(RUNS_DIR+'/')||file.path.endsWith('.md'))void tracker.check()};
 plugin.registerEvent(app.vault.on('create',changed));
 plugin.registerEvent(app.vault.on('modify',changed));
 plugin.register(()=>{tracker.dispose();if(reportTrackers.get(app)===tracker)reportTrackers.delete(app)});
}

export interface Intent {
 version: 2; provider: string; model: string;
	id: string;
	ts: string;
	skill: string;
	args: Record<string, unknown>;
	from: "plugin";
}

export type RunStatus = "running" | "ok" | "error";

export interface RunRecord {
 provider?: string; model?: string;
	id: string;
	skill: string;
	args: Record<string, unknown>;
	ts_queued: string;
	ts_started: string;
	ts_completed: string | null;
	status: RunStatus;
	exit_code: number | null;
	summary: string;
	log_path: string;
	md_path?: string;
	deliverable_path?: string | null;
}

function genUuid(): string {
	// crypto.randomUUID is available in Electron's renderer (Obsidian).
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
		return crypto.randomUUID();
	}
	// Fallback — RFC4122 v4ish.
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

export async function writeIntent(
	app: App,
	skill: string,
	args: Record<string, unknown> = {},
 selectionOverride?:VoiceSelection,
): Promise<string> {
	await assertTestVault(app);
 await assertVoiceVault(app);
 const selection = selectionOverride||await readSelection(app);
 const id = genUuid();
	const intent: Intent = {
 version: 2, ...selection,
		id,
		ts: new Date().toISOString(),
		skill,
		args,
		from: "plugin",
	};
	validateIntent(intent);
 const tracker=reportTrackers.get(app);
 const result=await workRequest('/skill',{id,skill,args,selection,execution:'headless'});
 if(result.id!==id||(result.execution!=='headless'&&result.execution!=='script'))throw new Error('The workflow service needs updating before background skills can run.');
 if(tracker&&reportTrackers.get(app)!==tracker)return result.id;
 const label=SKILLS[skill]?.label||skill;
 new Notice(`${label} is running in the background.`);
 void tracker?.track(result.id,skill,label,!SKILLS[skill]?.direct);
 return result.id;
}

export async function listRecentRuns(app: App, limit = 8): Promise<RunRecord[]> {
	const records: RunRecord[] = await recentRunsCache.read(app, async () => {
		if (!(await app.vault.adapter.exists(RUNS_DIR))) return [];
		const listing = await app.vault.adapter.list(RUNS_DIR);
		const jsonFiles = listing.files.filter((f) => f.endsWith(".json"));
		const records: RunRecord[] = [];
		for (const f of jsonFiles) {
			try {
				const raw = await app.vault.adapter.read(f);
				records.push(JSON.parse(raw) as RunRecord);
			} catch {
				continue;
			}
		}
		records.sort((a, b) => {
			const aTs = a.ts_completed || a.ts_started;
			const bTs = b.ts_completed || b.ts_started;
			return bTs.localeCompare(aTs);
		});
		return records;
	});
	return records.slice(0, limit);
}

export async function readRun(
	app: App,
	id: string,
): Promise<RunRecord | null> {
	const path = `${RUNS_DIR}/${id}.json`;
	if (!(await app.vault.adapter.exists(path))) return null;
	try {
		return JSON.parse(await app.vault.adapter.read(path)) as RunRecord;
	} catch {
		return null;
	}
}
