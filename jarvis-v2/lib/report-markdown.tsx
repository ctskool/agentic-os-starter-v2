import { createElement, type ReactNode } from 'react';

function safeReportUrl(value: string): string | null {
  // Reports include model output and external text. Never treat either as HTML.
  if (/[\s<>"'`\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

function inline(text: string, allowLinks = true): ReactNode[] {
  const output: ReactNode[] = [];
  // Tokenize the source once. Formatting never runs over generated attributes.
  const pattern = /`([^`]+)`|\[([^\]]+)\]\(([^)\n]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    output.push(text.slice(cursor, match.index));
    const key = match.index;
    if (match[1] !== undefined) output.push(createElement('code', { key }, match[1]));
    else if (match[2] !== undefined) {
      const href = allowLinks ? safeReportUrl(match[3]) : null;
      output.push(href ? createElement('a', { key, href, target: '_blank', rel: 'noopener noreferrer' }, inline(match[2], false)) : match[0]);
    } else if (match[4] !== undefined) output.push(createElement('strong', { key }, match[4]));
    else output.push(createElement('em', { key }, match[5]));
    cursor = match.index! + match[0].length;
  }
  output.push(text.slice(cursor));
  return output;
}

export function ReportMarkdown({ markdown }: { markdown: string }): ReactNode {
  const output: ReactNode[] = [];
  let items: ReactNode[] = [], code: string[] | null = null;
  const closeList = () => {
    if (items.length) output.push(createElement('ul', { key: output.length }, items));
    items = [];
  };
  const closeCode = () => {
    if (code) output.push(createElement('pre', { key: output.length }, createElement('code', null, code.join('\n'))));
    code = null;
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^```/.test(line)) { closeList(); if (code) closeCode(); else code = []; continue; }
    if (code) { code.push(raw); continue; }
    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      closeList();
      output.push(createElement(`h${heading[1].length + 1}`, { key: output.length }, inline(heading[2])));
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line)) { closeList(); output.push(createElement('hr', { key: output.length })); continue; }
    const item = line.match(/^\s*[-*]\s+(.*)/);
    if (item) { items.push(createElement('li', { key: items.length }, inline(item[1]))); continue; }
    closeList();
    if (line.trim()) output.push(createElement('p', { key: output.length }, inline(line)));
  }
  closeList(); closeCode();
  return output;
}
