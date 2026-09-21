import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReportMarkdown } from '../lib/report-markdown';

const render = (markdown: string) => renderToStaticMarkup(createElement(ReportMarkdown, { markdown }));

test('report markdown keeps headings, bullets and safe linked formatting without raw HTML', () => {
  const html = render('# Report\n- **Strong** and *emphasis*\n- [**Source**](https://example.com/?a=1&b=2)\n---\n`<button>`');
  assert.match(html, /<h2>Report<\/h2>/);
  assert.match(html, /<ul><li><strong>Strong<\/strong> and <em>emphasis<\/em><\/li>/);
  assert.match(html, /href="https:\/\/example.com\/\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer"><strong>Source<\/strong><\/a>/);
  assert.match(html, /<code>&lt;button&gt;<\/code>/);
});

test('untrusted report URLs cannot inject attributes or active schemes', () => {
  for (const url of [
    'https://example.com/" onmouseover="alert',
    "https://example.com/' onclick='alert",
    'javascript:alert(1)', 'data:text/html,<svg/onload=alert(1)>',
    'file:///C:/secret.txt', '//evil.example/path', 'java\tscript:alert',
  ]) {
    const html = render(`[source](${url})`);
    assert.doesNotMatch(html, /<a\b/, url);
    assert.doesNotMatch(html, /<svg\b/, url);
  }
  const escaped = render('[source](https://example.com/&quot;onclick=&quot;bad)');
  assert.match(escaped, /&amp;quot;/);
  assert.doesNotMatch(escaped, /" onclick=/);
});

test('formatting markers in a valid URL are never rewritten into HTML attributes', () => {
  const html = render('[source](https://example.com/**path**?query=*stars*)');
  assert.match(html, /href="https:\/\/example.com\/\*\*path\*\*\?query=\*stars\*"/);
  assert.doesNotMatch(html, /<strong>|<em>/);
});

test('raw HTML and fenced code from model reports remain inert text', () => {
  const html = render('<img src=x onerror=alert(1)>\n```html\n<script>alert(1)</script>\n[bad](https://example.com)\n```');
  assert.match(html, /&lt;img/);
  assert.match(html, /<pre><code>&lt;script&gt;/);
  assert.doesNotMatch(html, /<img|<script|<a /);
});
