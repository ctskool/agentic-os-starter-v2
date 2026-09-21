export type ObsidianWhere = "tab" | "split" | "right-sidebar" | "left-sidebar";
export type ObsidianAction =
  | { op: "daily-note"; where?: ObsidianWhere }
  | { op: "cockpit" }
  | { op: "open-note"; query: string; where?: ObsidianWhere }
  | { op: "search"; query: string }
  | { op: "command"; id: string; label: string }
  | { op: "web"; url: string; label: string; where?: ObsidianWhere }
  | { op: "repo"; slug: string; where?: ObsidianWhere };

// command ids the orb may execute — ALSO the allowlist for model-emitted
// actions (a model must never invoke arbitrary command ids)
export const COMMAND_ALLOW: Record<string, string> = {
  "app:go-back": "back",
  "app:go-forward": "forward",
  "workspace:close": "close tab",
  "workspace:split-vertical": "split right",
  "workspace:split-horizontal": "split down",
  "app:toggle-left-sidebar": "left sidebar",
  "app:toggle-right-sidebar": "right sidebar",
  "graph:open": "graph view",
  // opens in a bottom split via the terminal plugin's own newInstanceBehavior.
  // id format is open-terminal.<default|integrated|external|select>.<root|current>
  // since the plugin's 3.27 update (the old open-terminal.default died silently);
  // verified against main.js: for m of [kinds] for o of [places] → `open-terminal.${m}.${o}`
  "terminal:open-terminal.default.root": "terminal",
};

// named web targets → urls (model picks a NAME, never a raw url); opened in
// Obsidian's core Web Viewer
export const WEB_TARGETS: Record<string, { url: string; label: string }> = {
  calendar: { url: "https://calendar.google.com", label: "google calendar" },
  gmail: { url: "https://mail.google.com", label: "gmail" },
  "youtube-studio": { url: "https://studio.youtube.com", label: "youtube studio" },
};

