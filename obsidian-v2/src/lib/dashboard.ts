import type { App } from 'obsidian';
import { useEffect, useState } from 'preact/hooks';
import { SKILLS } from '../../shared/contract.mjs';
import { DEFAULT_COCKPIT_SKILLS, MAX_DASHBOARD_SKILLS } from '../../shared/dashboard.mjs';
import { createPollStore } from '../../shared/poll-store.mjs';
import { assertTestVault, readSelection, type Health, type Provider } from './provider';
import { assertVoiceVault, v2VoiceTransport } from './v2-voice';
import { openWork, publishWorkTask, workConversations, type WorkTask } from './work';
import { writeIntent } from './queue';
import { SUPPORTED_TERMINAL_VERSION } from './native-terminal';

export interface DashboardSkill {
 id: string;
 label: string;
 description: string;
 kind: 'builtin' | 'installed';
 arg?: string;
 direct?: boolean;
 providers: Provider[];
 available: boolean;
 reason?: string;
}
export interface DashboardSnapshot {
 revision: string;
 configured: boolean;
 selected: string[] | null;
 catalog: DashboardSkill[];
 error: string;
 ready: boolean;
 registeredId?: string;
 installedProviders?: Provider[];
}
export interface DiscoveredSkill {
 path: string;
 label: string;
 description: string;
 providers: Provider[];
}

const defaults = (): DashboardSnapshot => ({
 revision: '', configured: false, selected: null, ready: false, error: '',
 catalog: Object.entries(SKILLS).filter(([id]) => id !== 'voice-ask').map(([id, skill]) => ({
  id, label: skill.label, description: skill.instruction, kind: 'builtin',
  arg: skill.arg, direct: skill.direct, providers: ['claude', 'codex'], available: true,
 })),
});
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

async function request(path: string, data?: unknown): Promise<any> {
 const response = await v2VoiceTransport('/dashboard' + path, data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) });
 if (response.status !== 200) {
  const fallback = response.status === 404
   ? 'Dashboard customization needs an updated bridge. Run node aos.mjs update in your starter folder.'
   : 'Dashboard settings are unavailable. Start the bridge and try again.';
  throw new Error(response.status === 404 ? fallback : response.json?.error || fallback);
 }
 return response.json;
}

function snapshot(value: any): DashboardSnapshot {
 if (!value || typeof value.revision !== 'string' || !Array.isArray(value.catalog)
  || !(value.selected === null || (Array.isArray(value.selected) && value.selected.every((id: unknown) => typeof id === 'string')))) {
  throw new Error('The bridge returned invalid dashboard settings. Update the starter and try again.');
 }
 return { ...value, error: typeof value.error === 'string' ? value.error : '', ready: true };
}

const stores = new WeakMap<App, ReturnType<typeof createPollStore>>();
function dashboardStore(app: App) {
 const existing = stores.get(app);
 if (existing) return existing;
 const store = createPollStore({
  initial: defaults(),
  load: async (): Promise<DashboardSnapshot> => {
   try {
    await assertTestVault(app);
    await assertVoiceVault(app);
    return snapshot(await request(''));
   } catch (error) {
    return { ...store.getSnapshot(), ready: false, error: errorText(error) };
   }
  },
 });
 stores.set(app, store);
 return store;
}

export async function readDashboard(app: App): Promise<DashboardSnapshot> {
 return dashboardStore(app).refresh();
}
export function subscribeDashboard(app: App, listener: (value: DashboardSnapshot) => void) {
 return dashboardStore(app).subscribe(listener);
}
export function useDashboard(app: App) {
 const store = dashboardStore(app);
 const [value, setValue] = useState<DashboardSnapshot>(store.getSnapshot());
 useEffect(() => store.subscribe(setValue), [store]);
 return value;
}
export function dashboardSelection(value: DashboardSnapshot): string[] {
 return [...(value.selected ?? DEFAULT_COCKPIT_SKILLS)];
}
export function dashboardButtons(value: DashboardSnapshot): DashboardSkill[] {
 return dashboardSelection(value).map(id => value.catalog.find(skill => skill.id === id) ?? {
  id, label: id, description: '', kind: 'installed', providers: [], available: false,
  reason: 'This skill is no longer registered. Remove it in Customize dashboard.',
 });
}
export function dashboardSkillReason(skill: DashboardSkill, provider: Provider, health?: Health | null, dashboardError = '', installedProviders?: Provider[]): string {
 if (!skill.available) return skill.reason || 'This skill is unavailable. Review it in Customize dashboard.';
 if (!skill.providers.includes(provider)) return `Use ${skill.providers.join(' or ')} to run this skill.`;
 if (skill.kind === 'installed' && dashboardError) return dashboardError;
 if (!skill.direct && ((installedProviders && !installedProviders.includes(provider)) || (health && !health.providers[provider]?.installed))) return `${provider === 'claude' ? 'Claude Code' : 'Codex'} is not installed.`;
 return '';
}
export async function saveDashboard(app: App, revision: string, selected: string[] | null) {
 if (selected && (selected.length > MAX_DASHBOARD_SKILLS || new Set(selected).size !== selected.length)) {
  throw new Error(`Choose up to ${MAX_DASHBOARD_SKILLS} different skills.`);
 }
 await assertTestVault(app);
 await assertVoiceVault(app);
 const value = snapshot(await request('', { revision, selected }));
 dashboardStore(app).publish(value);
 return value;
}
export async function discoverDashboardSkills(app: App, provider: Provider): Promise<{ skills: DiscoveredSkill[]; warnings?: string[]; skipped?: number; truncated?: boolean }> {
 await assertTestVault(app);
 await assertVoiceVault(app);
 return request('/discover?provider=' + encodeURIComponent(provider));
}
export async function registerDashboardSkill(app: App, revision: string, path: string, providers: Provider[], label?: string) {
 await assertTestVault(app);
 await assertVoiceVault(app);
 const value = snapshot(await request('/register', { revision, path, providers, ...(label?.trim() ? { label: label.trim() } : {}) }));
 dashboardStore(app).publish(value);
 return value;
}

/** Stock workflows keep their existing background/report behavior; installed skills open an agent. */
export async function launchDashboardSkill(app: App, skill: DashboardSkill, input = '') {
 if (skill.kind === 'builtin') {
  await writeIntent(app, skill.id, skill.arg ? { [skill.arg]: input } : {});
  return;
 }
 await assertTestVault(app);
 await assertVoiceVault(app);
 const selection = await readSelection(app);
 const reason = dashboardSkillReason(skill, selection.provider);
 if (reason) throw new Error(reason);
 if (!input.trim()) throw new Error('Describe what you want this skill to do.');
 // Native work needs Terminal to own the CLI. Fail before creating a pending
 // task; browser previews use their bridge-owned terminal and need no plugin.
 const native = !!(app.vault.adapter as typeof app.vault.adapter & { getBasePath?: () => string }).getBasePath;
 const terminal = (app as App & { plugins?: { plugins?: { terminal?: { manifest?: { version?: string } } } } }).plugins?.plugins?.terminal;
 if (native && terminal?.manifest?.version !== SUPPORTED_TERMINAL_VERSION) {
  throw new Error(`Enable the supported Terminal community plugin (${SUPPORTED_TERMINAL_VERSION}) to run personal skills inside Obsidian, or use the same skill button in Jarvis at http://127.0.0.1:3217.`);
 }
 await workConversations.startSession();
 const task = await request('/launch', { id: crypto.randomUUID(), skill: skill.id, request: input.trim(), selection }) as WorkTask;
 if (!task || typeof task.id !== 'string' || !['claude', 'codex'].includes(task.provider) || !Array.isArray(task.turns)) {
  throw new Error('The bridge did not return a workflow. Update the starter and try again.');
 }
 publishWorkTask(task);
 openWork([task.id]);
}
