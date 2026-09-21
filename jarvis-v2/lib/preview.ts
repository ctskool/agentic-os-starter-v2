import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { VaultState, RunEntry, Metric } from "./vault";

export type Provider = "claude" | "codex";
export type PreviewState = VaultState & { preview: { provider: Provider; execution: "disconnected"; simulated: true } };
// Intentionally fixed to THIS app. V1 environment variables cannot redirect it.
export const TEST_ROOT = path.resolve(process.cwd(), "test-vault");
const DB_FILE = path.join(TEST_ROOT, "system", "preview.json");
const MARKER = path.join(TEST_ROOT, ".jarvis-v2-test-vault");
const SKILLS = new Set(["metrics-pull", "morning-report", "inbox-brief", "github-trending", "ai-trend-scan", "yt-week-review", "plan-today", "plan-tomorrow", "weekly-review", "vault-cleanup"]);
interface PreviewRun extends RunEntry { provider: Provider; simulated: true }
interface Store { provider: Provider; done: boolean[]; runs: PreviewRun[] }
function assertIsolated() {
  if (!fs.existsSync(MARKER) || fs.readFileSync(MARKER, "utf8").trim() !== "jarvis-v2-preview-only") {
    throw new Error("V2 sample vault marker missing. Restore the bundled test-vault before starting.");
  }
}
function readStore(): Store {
  assertIsolated();
  if (!fs.existsSync(DB_FILE)) return { provider: "codex", done: [false, false, false], runs: [] };
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}
function saveStore(data: Store) {
  assertIsolated();
  const temporary = `${DB_FILE}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, DB_FILE);
}
export function selectProvider(provider: unknown) {
  if (provider !== "codex" && provider !== "claude") throw new Error("Unknown provider");
  const store = readStore(); store.provider = provider; saveStore(store);
  return { provider, execution: "disconnected" };
}
export function setDirective(index: unknown, done: unknown) {
  if (!Number.isInteger(index) || Number(index) < 0 || Number(index) > 2 || typeof done !== "boolean") throw new Error("Invalid directive");
  const store = readStore(); store.done[Number(index)] = done; saveStore(store);
}
export function simulateJob(skill: unknown) {
  if (typeof skill !== "string" || !SKILLS.has(skill)) throw new Error("Unknown preview action");
  const store = readStore();
  if (store.runs.some(r => r.status === "running" && Date.now() - Date.parse(r.ts_started!) < 6500)) throw new Error("A preview is already running");
  const id = crypto.randomUUID();
  store.runs.unshift({ id, skill, provider: store.provider, simulated: true, label: `${skill.replace(/-/g, " ")} · ${store.provider} preview`, link: null, status: "running", summary: "Simulated workflow — no agent is running.", ts_started: new Date().toISOString(), ts_completed: null, duration_s: null, deliverable_path: null });
  store.runs = store.runs.slice(0, 12); saveStore(store);
  return { id, simulated: true, provider: store.provider };
}
export function previewReport(reportPath: string): string {
  if (reportPath === "inbox/reports/welcome.md") return "# Welcome to Jarvis V2\n\nThis is an isolated visual preview. All dashboard metrics and schedules are sample data.\n\n## Explore\n- Switch between Claude and Codex in the header.\n- Preview listening, working, speaking, and error animations.\n- Click a workflow to simulate a result.\n- Toggle a directive; it persists in this test vault.\n\n## Connections\nNeither Claude nor Codex execution is connected in this milestone. No microphone, provider API, email, calendar, or production vault is accessed.";
  const match = /^inbox\/reports\/([a-f0-9-]{36})\.md$/.exec(reportPath);
  if (!match) throw new Error("Report not found");
  const run = readStore().runs.find(r => r.id === match[1] && r.status === "ok");
  if (!run) throw new Error("Report not found");
  return `# ${run.skill.replace(/-/g, " ")}\n\n**Simulated result — no model was called.**\n\n## What this preview verifies\n- The HUD submitted an action.\n- Provider selection was captured as **${run.provider}** when it started.\n- The working state transitioned to a completed document.\n\n## Next connection\nThe isolated runner will execute this workflow through the selected agent once its adapter and skill have been validated.\n\nYour original vault and running services were not involved.`;
}
export function previewState(): PreviewState {
  const store = readStore();
  let changed = false;
  for (const run of store.runs) {
    if (run.status === "running" && Date.now() - Date.parse(run.ts_started!) >= 6500) {
      run.status = "ok"; run.ts_completed = new Date().toISOString(); run.duration_s = 6.5;
      run.summary = "Preview complete. Sample result available; no agent was called.";
      run.deliverable_path = `inbox/reports/${run.id}.md`; changed = true;
    }
  }
  if (changed) saveStore(store);
  const now = new Date(), timestamp = now.toISOString();
  const date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  const metric = (source: string, name: string, value: number, growth: number): Metric => ({ source, metric: name, value, status: "mock", timestamp, delta: growth / 7, deltaWeek: growth, history: Array.from({length: 18}, (_, i) => ({ timestamp, status: "mock", value: value - growth + growth * i/17 + Math.sin(i * 1.7) * growth * 0.04 })) });
  const active = store.runs.filter(r => r.status === "running").length;
  const welcome: RunEntry = { id: "welcome", skill: "preview-guide", label: "Welcome to V2", link: null, status: "ok", summary: "Visual preview ready", ts_started: timestamp, ts_completed: timestamp, duration_s: 0, deliverable_path: "inbox/reports/welcome.md" };
  return {
    generated_at: timestamp, vault_root: TEST_ROOT,
    preview: { provider: store.provider, execution: "disconnected", simulated: true },
    metrics: [metric("youtube", "subscribers", 128400, 1820), metric("instagram", "followers", 64200, 930)],
    runner: { ts: timestamp, pid: 0, version: "preview", busy: active > 0, active, max_concurrent: 1, pending: 0, heartbeat_age_s: 0, alive: false },
    latestVideo: null,
    daily: { date, isToday: true, top3: ["Explore the Codex galaxy", "Preview a workflow", "Compare the Claude centerpiece"].map((text, i) => ({ text, done: store.done[i] })), schedule: [{ time: "09:00", item: "Plan the day · sample" }, { time: "11:30", item: "Content studio · sample" }, { time: "15:00", item: "Review and publish · sample" }], focus: "Make room for the next idea." },
    runs: [...store.runs, welcome], queue: [], morning: null, outliers: null, trendingRepos: [], etas: {},
  };
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  const url = new URL(request.url);
  // Next may normalize request.url to localhost even for a 127.0.0.1 Host.
  // Accept only our loopback server, and compare Origin to the actual Host.
  const host = request.headers.get("host") || url.host;
  if (!/^(127\.0\.0\.1|localhost):3217$/.test(host)) return false;
  return (origin === `${url.protocol}//${host}` || !origin && site === 'same-origin') && site !== "cross-site";
}
