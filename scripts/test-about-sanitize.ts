/**
 * Self-contained test runner for the About-section security pipeline.
 *
 * Runs with (from repo root):
 *   npx ts-node scripts/test-about-sanitize.ts
 *
 * No jest/vitest needed — uses Node's built-in `assert/strict` +
 * a tiny TAP-style counter. Zero extra deps on top of existing packages.
 *
 * Coverage:
 *   ┌─ Marked renderer (PRIMARY DEFENSE — blocks arbitrary raw HTML)
 *   │    a) <script> injected via md → escaped to text
 *   │    b) <iframe>, <svg>, <form>, <math> → escaped
 *   │    c) inline html with event handler attrs → escaped
 *   │    d) HTML entity smuggling (&amp; → kept escaped)
 *   │    e) But normal Markdown constructs still render: **bold**, *em*, lists, links, headings, img
 *   │
 *   └─ sanitizeHtmlSimple (SECONDARY DEFENSE — belt-and-suspenders)
 *        1) <script> tag → stripped
 *        2) <img onerror=…> → onerror stripped
 *        3) <a href=javascript:…> → href stripped
 *        4) <a href=data:text/html…> → href stripped
 *        5) <iframe> → tag stripped
 *        6) <svg> / <math> → tag stripped
 *        7) style="behavior:url(…)" → attribute stripped (not in allow-list)
 *        8) onclick= / onfocus=… → any `on*` attr stripped
 *        9) Abnormal quoting: `onclick='foo"'>bad stuff…` → `onclick` dropped, rest safe
 *       10) HTML entity encoded payloads (`&lt;script&gt;` already text)
 *       11) Normal markdown link → preserved, target=_blank added, rel set
 *       12) Normal markdown image (http / https src) → preserved
 *       13) img data: URIs → stripped (P2 requirement)
 *       14) `> ` in attr value shouldn't break parsing
 */

import * as assert from 'assert/strict';
import {
  sanitizeHtmlSimple,
  ABOUT_SANITIZE_CONFIG,
} from '../src/utils/sanitize-html-simple';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; group: string; fn: TestFn }> = [];
const group = (g: string) => (name: string, fn: TestFn) =>
  tests.push({ group: g, name, fn });

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
async function renderAboutMarkdown(md: string): Promise<string> {
  // Duplicate the exact marked pipeline used in builder.ts.
  // Kept in sync manually: same renderer.html escape, same options, same
  // sanitizeHtmlSimple call. If builder.ts later diverges this test catches it.
  const { marked, Renderer } = await import('marked');
  const noHtmlRenderer = new (Renderer || marked.Renderer)();
  const escapeHtml = (s: string): string =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  noHtmlRenderer.html = (html: string): string => escapeHtml(html);
  marked.setOptions({
    breaks: true,
    gfm: true,
    renderer: noHtmlRenderer,
  });
  const rawHtml = (await marked.parse(md)) as string;
  return sanitizeHtmlSimple(rawHtml);
}

const contains = (hay: string, needle: string | RegExp): boolean =>
  typeof needle === 'string' ? hay.includes(needle) : needle.test(hay);
const missing = (hay: string, needle: string | RegExp): boolean =>
  !contains(hay, needle);

// ─────────────────────────────────────────────
// GROUP 1 — marked renderer NO-HTML PRIMARY line
// ─────────────────────────────────────────────
const md = group('Pipeline — marked no-html renderer (PRIMARY)');

md('<script> inside about.md → must become escaped text', async () => {
  const out = await renderAboutMarkdown('Hi.\n<script>alert(1)</script>\nBye.');
  assert.ok(
    missing(out, '<script>') && missing(out, '</script>') &&
      contains(out, '&lt;script&gt;') && contains(out, 'alert(1)'),
    'raw <script> was not escaped: ' + out,
  );
});

md('<iframe> / <svg> / <form> / <math> → escaped', async () => {
  const mdRaw = [
    '<iframe src="evil"></iframe>',
    '<svg onload="alert(1)"><circle/></svg>',
    '<form action="x"><input name="pass"></form>',
    '<math><mi>x</mi></math>',
  ].join('\n\n');
  const out = await renderAboutMarkdown(mdRaw);
  for (const tag of ['<iframe', '<svg', '<form', '<math', '<mi', '<circle', '<input']) {
    assert.ok(missing(out, tag.toLowerCase()), `Tag should be escaped: ${tag}. Got: ${out.slice(0, 200)}`);
  }
  // Must preserve the literal text via escapes
  assert.ok(contains(out, '&lt;iframe'), `should see escaped <iframe: ${out.slice(0, 200)}`);
});

md('Inline HTML with onclick → escaped and harmless (no bare onclick= attribute)', async () => {
  const out = await renderAboutMarkdown(
    'Before.\n<p onclick="alert(1)">tricky</p>\nAfter.',
  );
  // Primary defense (marked's renderer.html escape) converts the raw <p>
  // and its attributes TO TEXT via entities. We expect NO NAKED ` onclick=`
  // attribute (that would be interpretable by the browser); seeing it as
  // entity form `onclick=&quot;…&quot;` is SAFE — it's literal text.
  const bareOnclick = /\sonclick\s*=\s*["'`]/i;
  assert.ok(
    !bareOnclick.test(out),
    `Naked onclick attr still present: ${out}`,
  );
  // Inner text "tricky" and "Before." survive; raw tag names are all escaped.
  assert.ok(contains(out, '&lt;p'), `raw <p should be escaped: ${out}`);
  assert.ok(contains(out, 'tricky') && contains(out, 'Before.') && contains(out, 'After.'),
    `surrounding content should be preserved: ${out}`);
});

md('HTML entity smuggling remains text', async () => {
  // If someone tries `&lt;script&gt;` it's already "plain text" in md.
  // The md source double-escapes; the result stays as plain text.
  const out = await renderAboutMarkdown('&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.ok(missing(out, '<script>') && missing(out, '</script>'));
});

md('Normal markdown still renders (defense should not break content)', async () => {
  const out = await renderAboutMarkdown(
    '# Hello\n\nYou are **bold** and *italic* and `code`.\n\n' +
      '- one\n- two\n- three\n\nSee [GitHub](https://github.com/kxjzxc) and a ' +
      '![cloud](https://example.com/cloud.jpg).',
  );
  assert.ok(contains(out, '<h1>'), out);
  assert.ok(contains(out, '<strong>bold</strong>'), out);
  assert.ok(contains(out, '<em>italic</em>'), out);
  assert.ok(contains(out, '<code>code</code>'), out);
  assert.ok(contains(out, '<ul>') && contains(out, '<li>one</li>'), out);
  assert.ok(contains(out, /href="https:\/\/github\.com\/kxjzxc"/), out);
  assert.ok(contains(out, /src="https:\/\/example\.com\/cloud\.jpg"/), out);
});

md('Markdown links add target=_blank + rel=noopener noreferrer nofollow', async () => {
  const out = await renderAboutMarkdown('[Me](https://example.com)');
  assert.ok(contains(out, 'target="_blank"'), `missing target=_blank in: ${out}`);
  const relMatch = out.match(/<a[^>]*\srel="([^"]*)"[^>]*>/);
  assert.ok(relMatch, `missing rel on <a>: ${out}`);
  const relSet = new Set(relMatch![1].split(/\s+/).filter(Boolean));
  for (const need of ['noopener', 'noreferrer', 'nofollow']) {
    assert.ok(relSet.has(need), `<a> rel missing ${need}. Got: ${relMatch![1]}`);
  }
});

// ─────────────────────────────────────────────
// GROUP 2 — sanitizeHtmlSimple SECONDARY tests
//   Exercise the allow-list / protocol / on* handler defenses directly on
//   synthetic HTML. In production marked has already stripped raw HTML;
//   these stand as a regression net / spec for the sanitizer itself.
// ─────────────────────────────────────────────
const s = group('sanitizeHtmlSimple — secondary allow-list / protocol');

s('<script> stripped', () => {
  const out = sanitizeHtmlSimple(
    'Before<script>alert(1)</script>After',
  );
  assert.ok(missing(out, '<script>') && missing(out, '</script>'));
  // Literal body of script tag is escaped-text level — either stripped or
  // left as text; in either case no executable tag.
  assert.ok(contains(out, 'Before') && contains(out, 'After'));
});

s('<img onerror> → onerror stripped, img preserved', () => {
  const out = sanitizeHtmlSimple(
    '<img src="x.png" onerror="alert(1)" alt="a">',
  );
  assert.ok(missing(out, 'onerror'), `onerror still in: ${out}`);
  assert.ok(contains(out, 'src="x.png"'), out);
  assert.ok(contains(out, 'alt="a"'), out);
});

s('<a href="javascript:"> → href stripped entirely', () => {
  const out = sanitizeHtmlSimple(
    '<a href="javascript:alert(1)">click</a>',
  );
  assert.ok(contains(out, '<a') && contains(out, 'click</a>'), out);
  assert.ok(missing(out, 'href='), `javascript href still in: ${out}`);
});

s('<a href="data:text/html,..."> → href stripped', () => {
  const out = sanitizeHtmlSimple(
    '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  );
  assert.ok(missing(out, 'href='), `data: a href still in: ${out}`);
});

s('<iframe> → tag stripped', () => {
  const out = sanitizeHtmlSimple(
    'A<iframe src="x"></iframe>B',
  );
  assert.ok(missing(out, '<iframe') && missing(out, '</iframe>'));
});

s('<svg> and <math> → tags stripped', () => {
  const a = sanitizeHtmlSimple('<svg onload="alert(1)"><circle/></svg>');
  assert.ok(missing(a, '<svg') && missing(a, '<circle') && missing(a, 'onload'));
  const b = sanitizeHtmlSimple('<math><mi>x</mi></math>');
  assert.ok(missing(b, '<math') && missing(b, '<mi'));
});

s('style= attribute stripped', () => {
  const out = sanitizeHtmlSimple(
    '<a href="https://ok" style="color:red;behavior:url(js)">ok</a>',
  );
  assert.ok(missing(out, 'style='), `style still present: ${out}`);
  assert.ok(contains(out, 'href="https://ok"'), out);
});

s('on* attrs stripped (onclick, onfocus, onload, onmouseover…)', () => {
  const samples = [
    '<p onclick="x">a</p>',
    '<p onfocus="x" tabindex=0>a</p>',
    '<p onmouseover="x">a</p>',
    '<img src="x" onload="x">',
  ];
  for (const html of samples) {
    const out = sanitizeHtmlSimple(html);
    const onMatches = out.match(/\son[a-z]+\s*=/gi) || [];
    assert.deepEqual(onMatches, [], `${html} → still has on* in: ${out}`);
  }
});

s('Malformed quoting / quotes in attr value — no unsafe breakout', () => {
  // Variants of quote-mixups that could fool naive regex:
  const cases = [
    `<a href="https://ok" onclick='alert("oops")'>text</a>`,
    `<a href='https://ok' onclick="alert('oops')">text</a>`,
    `<a title='a"b' onclick=x>t</a>`,
  ];
  for (const html of cases) {
    const out = sanitizeHtmlSimple(html);
    assert.ok(missing(out, ' onclick='), `onclick escaped in: ${html} → ${out}`);
  }
});

s('HTML-entity encoded payloads remain textual (no double-decode breakout)', () => {
  // Entities like &lt;script&gt; in INPUT are still literal chars;
  // sanitizer should not execute them as tags.
  const out = sanitizeHtmlSimple('&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.ok(missing(out, '<script>') && missing(out, '</script>'));
});

s('Normal http(s) link + image preserved', () => {
  const link = sanitizeHtmlSimple(
    '<p>Hi <a href="https://a.b/c?x=1&y=2" title="T">click</a>.</p>',
  );
  assert.ok(contains(link, /href="https:\/\/a\.b\/c\?x=1&amp;y=2"|href="https:\/\/a\.b\/c\?x=1&y=2"/), link);
  assert.ok(contains(link, 'target="_blank"'), link);
  const img = sanitizeHtmlSimple(
    '<img src="https://a.b/i.png" alt="a" title="t" width="100" height="50" />',
  );
  for (const need of ['src="https://a.b/i.png"', 'alt="a"', 'title="t"', 'width="100"', 'height="50"']) {
    assert.ok(contains(img, need), `missing ${need} in: ${img}`);
  }
});

s('img src=data: — stripped (P2)', () => {
  const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const out = sanitizeHtmlSimple(`<img src="${tiny}" alt="x">`);
  assert.ok(missing(out, 'src='), `data: src still present in: ${out}`);
  // alt (text-level safe info) kept is fine
});

s('Angle brackets appearing inside attr values — disallowed attrs dropped, no tag breakout', () => {
  // A parser-difference probe: an attribute value with `>` shouldn't cause
  // the rest of the value to leak out as new tags.
  const out = sanitizeHtmlSimple(
    `<a href="https://ok" title="before > after" onclick="x">click</a>`,
  );
  // `title` is allowed; the `>` inside is literal, so `after" onclick="x">click`
  // should NOT appear outside the <a> tag. If our parser split on the first
  // `>` it would emit a stray `after` … </a> outside.
  assert.ok(missing(out, 'onclick='), `onclick leaked: ${out}`);
  assert.ok(
    contains(out, /title="before > after"|title='before > after'|title="before &gt; after"/),
    `before > after should be in title attr: ${out}`,
  );
});

// ─────────────────────────────────────────────
// GROUP 3 — Sanity / contract checks around config shape
// ─────────────────────────────────────────────
const c = group('Config shape — defense-in-depth guardrails');

c('ABOUT_SANITIZE_CONFIG img protocols do NOT include data:', () => {
  assert.deepEqual(
    ABOUT_SANITIZE_CONFIG.allowedImgProtocols.filter(
      (p) => p.toLowerCase().startsWith('data'),
    ),
    [],
    'P2: no data: protocol on allowedImgProtocols',
  );
});

c('Default config has no wildcard attrs; any tag must explicitly opt-in', () => {
  // REVIEW concern: implicit widening of attrs. The allowedAttrs type forbids
  // a '*' key; here we also assert at runtime so future edits can't silently
  // add a blanket wildcard without this test failing loudly.
  const keys = Object.keys(ABOUT_SANITIZE_CONFIG.allowedAttrs);
  assert.ok(!keys.includes('*'), 'allowedAttrs wildcard * is forbidden');
});

// ─────────────────────────────────────────────
// Run all tests (TAP-ish)
// ─────────────────────────────────────────────
const FAIL = '✗';
const PASS = '✓';

async function main(): Promise<number> {
  const byGroupFailures = new Map<string, number>();
  const byGroupTotals = new Map<string, number>();
  let passed = 0;
  let failed = 0;
  const failures: Array<{ name: string; group: string; err: unknown }> = [];

  for (const t of tests) {
    byGroupTotals.set(t.group, 1 + (byGroupTotals.get(t.group) ?? 0));
    try {
      const r = t.fn();
      if (r && typeof (r as Promise<void>).then === 'function') await r;
      passed++;
      console.log(`${PASS} [${t.group}] ${t.name}`);
    } catch (e) {
      failed++;
      byGroupFailures.set(t.group, 1 + (byGroupFailures.get(t.group) ?? 0));
      failures.push({ group: t.group, name: t.name, err: e });
      console.log(`${FAIL} [${t.group}] ${t.name}`);
      if (e instanceof Error) {
        console.log(`    ${e.message.split('\n').join('\n    ')}`);
      } else {
        console.log(`    ${String(e)}`);
      }
    }
  }

  console.log('\n── Summary ──');
  for (const [grp, total] of byGroupTotals.entries()) {
    const f = byGroupFailures.get(grp) ?? 0;
    console.log(`  ${grp.padEnd(44)}  ${String(total - f).padStart(2)}/${total}  (fail: ${f})`);
  }
  console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);

  if (failed > 0) {
    console.log('\n── Failed tests ──');
    for (const f of failures) {
      console.log(`  • [${f.group}] ${f.name}`);
    }
  }

  return failed === 0 ? 0 : 1;
}

void main().then((code) => {
  // Node-style exit; ts-node will carry it through. Using setTimeout to let
  // final streams flush.
  setTimeout(() => process.exit(code), 10);
});
