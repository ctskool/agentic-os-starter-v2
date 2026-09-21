"use client";

import { ReportMarkdown } from "../lib/report-markdown";

// ---------------------------------------------------------------------------
// Report reveal overlay — renders a vault markdown deliverable inside the
// HUD (no app switch, stays cinematic). Animates out from the core. Esc or
// the × closes it (HUD owns the Esc handling). Zero-dep renderer: reports
// are runner-generated markdown — headings, bullets, bold, links, hr.
// ---------------------------------------------------------------------------

// Obsidian vault name (folder basename) — the obsidian:// URI needs it
const OBSIDIAN_VAULT = "jarvis-v2-test-vault";

export default function ReportOverlay({
  report,
  onClose,
  action,
}: {
  report: { path: string; content: string };
  onClose: () => void;
  /** optional header action (e.g. the transcript's reset button) */
  action?: { label: string; onClick: () => void };
}) {
  const title = report.path.split("/").pop()?.replace(/\.md$/, "") ?? report.path;
  // synthetic docs (e.g. the voice transcript) aren't vault notes — no deep link
  const isVaultNote = false; // Preview does not deep-link into the installed Obsidian vault.
  const obsidianHref = `obsidian://open?vault=${encodeURIComponent(OBSIDIAN_VAULT)}&file=${encodeURIComponent(report.path.replace(/\.md$/, ""))}`;
  return (
    <div className="report-overlay" onClick={onClose}>
      <div className="report-panel" onClick={(e) => e.stopPropagation()}>
        <div className="report-head">
          <span className="report-title">{title}</span>
          <span className="report-path">{report.path}</span>
          {isVaultNote && (
            <a className="report-obsidian" href={obsidianHref}>
              open in Obsidian ↗
            </a>
          )}
          {action && (
            <button className="report-obsidian report-action" onClick={action.onClick}>
              {action.label}
            </button>
          )}
          <button className="report-close" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>
        <div className="report-body"><ReportMarkdown markdown={report.content} /></div>
      </div>
    </div>
  );
}
