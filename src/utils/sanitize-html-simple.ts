/**
 * Minimal, zero-dependency HTML sanitizer.
 *
 * Design goals:
 *   - Pure Node stdlib (no jsdom / htmlparser2 / DOMPurify transitive tree),
 *     so it works reliably with this project's CommonJS toolchain on Node 20.
 *   - Conservative allow-lists tailored specifically for About Card content
 *     rendered from a user-controlled markdown file (about.md).
 *   - Defensive against the most common XSS vectors:
 *       • <script>, inline event handlers (onclick / onerror / ...),
 *         javascript:/vbscript: URLs, <iframe>, <form>, <svg>, <math>
 *         and other arbitrary tag extensions are unconditionally dropped.
 *
 * Inputs are produced by `marked.parse()` which generates reasonably well
 * formed HTML; we don't attempt to reproduce a full browser-grade parser.
 * Any tag or attribute that isn't explicitly permitted is stripped.
 */

export interface SanitizeConfig {
  allowedTags: string[];
  /** attribute-name allow-list, grouped by lowercase tag name or '*' for all */
  allowedAttrs: Record<string, string[]> & { '*'?: never };
  /** URL protocols allowed on <a href=…> */
  allowedHrefProtocols: string[];
  /** URL protocols allowed on <img src=…> (http/https only; data: disallowed per config P2) */
  allowedImgProtocols: string[];
}

export const ABOUT_SANITIZE_CONFIG: SanitizeConfig = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'ul', 'ol', 'li',
    'blockquote',
    'strong', 'em', 'del',
    'code', 'pre',
    'a', 'img', 'span', 'div',
  ],
  allowedAttrs: {
    a:    ['href', 'name', 'target', 'rel', 'title'],
    img:  ['src',  'alt',  'title',  'width', 'height'],
    span: ['class'],
    div:  ['class'],
    code: ['class'],
    pre:  ['class'],
  },
  allowedHrefProtocols: ['http:', 'https:', 'mailto:', 'tel:'],
  // P2: `data:` URIs intentionally removed here. An About card only needs
  // text + social links, maybe a remote http(s) profile image. Permitting
  // data: would allow huge base64 payloads to bloat the generated HTML
  // and slightly widen the attacker surface for smuggling payloads via
  // non-image media types. Keep the gate tight.
  allowedImgProtocols:  ['http:', 'https:'],
};

const ATTR_RE = /([a-zA-Z_:][\w:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const PROTOCOL_RE = /^\s*([\w+.-]+:)/; // e.g. "https:", "mailto:", "javascript:"
const SAFE_RELATIVE_RE = /^(\.{0,2}\/|\/|[^/:]+$)/; // no protocol, relative/anchor

function isAllowedUrl(value: string, protocols: string[], allowRelative: boolean): boolean {
  if (value === '' || value == null) return false;
  const m = value.match(PROTOCOL_RE);
  if (!m) {
    // no explicit protocol → allow site-relative / bare hash / same-page links
    return allowRelative && SAFE_RELATIVE_RE.test(value.trim());
  }
  const proto = m[1].toLowerCase();
  return protocols.includes(proto);
}

function buildAttributes(
  tagName: string,
  rawAttrs: string,
  cfg: SanitizeConfig,
): string {
  const allowedForTag = new Set<string>([
    ...(cfg.allowedAttrs[tagName] || []),
    ...((cfg.allowedAttrs as unknown as Record<string, string[]>)['*'] || []),
  ]);
  if (allowedForTag.size === 0) return '';

  const out: Array<{ name: string; value: string }> = [];
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  // We also want to read/set `rel` and `target` on <a>, so collect the raw href
  // at this phase (before post-hooks). Using buildAttributes to finalize
  // safe <a> behavior here completely avoids a SECOND regex-based HTML
  // re-parse over the emitted string (the previous post-hook parser had the
  // SAME attribute-internal-`>` desync bug we just fixed in findTagEnd).
  let hrefSeen = '';
  let targetSeen: string | undefined;
  let relSeen: string | undefined;

  while ((match = ATTR_RE.exec(rawAttrs)) !== null) {
    const rawName = match[1];
    if (!rawName) continue;
    const name = rawName.toLowerCase();
    if (name.startsWith('on')) continue;
    if (!allowedForTag.has(name)) continue;

    const value = (match[2] ?? match[3] ?? match[4] ?? '').trim();

    // Protocol-level gatekeeping
    if (tagName === 'a' && name === 'href') {
      if (!isAllowedUrl(value, cfg.allowedHrefProtocols, true)) continue;
      hrefSeen = value;
    }
    if (tagName === 'img' && name === 'src') {
      if (!isAllowedUrl(value, cfg.allowedImgProtocols, true)) continue;
    }

    if (tagName === 'a') {
      if (name === 'target') { targetSeen = value; continue; } // defer, we'll set final below
      if (name === 'rel')    { relSeen = value;    continue; } // defer
    }

    out.push({ name, value });
  }

  // <a> — finalize safe link behavior (UX + anti-tabnabbing).
  if (tagName === 'a' && hrefSeen !== '') {
    const trimmedHref = hrefSeen.trim();
    const isExternal = /^https?:/i.test(trimmedHref);

    if (isExternal) {
      // Always force target=_blank on absolute external http(s). Even if user
      // set one via markdown syntax: ignore their value for security.
      out.push({ name: 'target', value: '_blank' });
    } else if (targetSeen) {
      // Relative/internal but user explicitly declared target → preserve.
      out.push({ name: 'target', value: targetSeen });
    }
    // rel: always inject noopener/noreferrer/nofollow (dedup via Set).
    const relSet = new Set<string>(
      (relSeen ?? '').split(/\s+/).filter(Boolean).concat([
        'noopener',
        'noreferrer',
        'nofollow',
      ]),
    );
    out.push({ name: 'rel', value: Array.from(relSet).join(' ') });
  } else if (tagName === 'a') {
    // href was dropped (protocol blocked). Nothing safety-wise to finalize.
    if (targetSeen) out.push({ name: 'target', value: targetSeen });
    if (relSeen)    out.push({ name: 'rel',    value: relSeen });
  }

  // Render k/v to attribute string. If the value itself contains a double
  // quote, fall back to single quote. (In the vanishingly rare case where
  // it contains *both*, strip double quotes to avoid attribute breakout —
  // attribute values written by markdown don't need literal double-quotes.)
  const attrStrings: string[] = out.map(({ name, value }) => {
    const hasDQ = value.includes('"');
    const hasSQ = value.includes("'");
    let v = value;
    let q: '"' | "'" = '"';
    if (!hasDQ) {
      q = '"';
    } else if (!hasSQ) {
      q = "'";
    } else {
      // Contains both — escape by stripping double quotes. Content-
      // preserving enough for title/alt/name text fields; never going to
      // inject extra attributes because we always wrap.
      v = v.replace(/"/g, '');
      q = '"';
    }
    return `${name}=${q}${v}${q}`;
  });

  return attrStrings.length === 0 ? '' : ' ' + attrStrings.join(' ');
}

/**
 * Legacy post-hook entry point.
 *
 * Historically we ran a second regex pass on emitted HTML to normalize
 * external <a> targets/rels. That second regex pass re-created the exact
 * parser-desync class of bugs it was the sanitizer's job to avoid (e.g.
 * `title="before > after"` would have its `>` treated as tag-end).
 *
 * All link safety logic now lives directly inside `buildAttributes` so the
 * sanitizer is a single-pass parser. Keep `applyAboutCardPostHooks` as a
 * no-op identity function exported for backwards compat.
 */
function applyAboutCardPostHooks(cleanHtml: string): string {
  return cleanHtml;
}

export function sanitizeHtmlSimple(raw: string, cfg: SanitizeConfig = ABOUT_SANITIZE_CONFIG): string {
  const allowed = new Set<string>(cfg.allowedTags.map((t) => t.toLowerCase()));

  /**
   * Find the index of the character that actually CLOSES a tag.
   *
   * HTML-parser invariant: `>` only counts as tag-terminator when it's NOT
   * inside a quoted attribute value. Skipping quote pairs rules out the
   * classic parser-desync attack of putting a `>` inside an attr to fool a
   * naive regex-based scanner.
   *
   * Returns -1 if no well-formed tag-end was found in range [lt..end).
   */
  function findTagEnd(str: string, lt: number): number {
    let i = lt + 1;
    const n = str.length;
    let inStr: '"' | "'" | null = null;
    while (i < n) {
      const c = str.charAt(i);
      if (inStr) {
        if (c === inStr) {
          inStr = null;
        }
        i++;
        continue;
      }
      if (c === '"' || c === "'") {
        inStr = c as '"' | "'";
        i++;
        continue;
      }
      if (c === '>') return i;
      if (c === '<') return -1; // malformed: second `<` before closing `>` — drop tag
      i++;
    }
    return -1;
  }

  // Walk through, char by char, keeping everything outside tags as literal text.
  // For each tag we parse the tag name and attributes; disallowed tags are
  // converted to escaped plaintext.
  let result = '';
  let i = 0;
  const n = raw.length;

  while (i < n) {
    const lt = raw.indexOf('<', i);
    if (lt === -1) {
      result += raw.substring(i);
      break;
    }

    result += raw.substring(i, lt); // text between previous tag and this one

    const gt = findTagEnd(raw, lt);
    if (gt === -1) {
      // Malformed: unquoted `<`/`>` mismatch, or truly unclosed `<`.
      // Escape the opening `<` and advance by 1 char so we keep scanning.
      result += '&lt;';
      i = lt + 1;
      continue;
    }

    const rawTag = raw.substring(lt, gt + 1);
    i = gt + 1;

    // Comments / CDATA / declarations → unconditionally drop.
    if (/^<!--|^<\?|^<!\[CDATA\[|^<!DOCTYPE/i.test(rawTag)) {
      continue;
    }

    const closeMatch = /^<\/\s*([A-Za-z][\w:-]*)\s*>$/.exec(rawTag);
    if (closeMatch) {
      const name = closeMatch[1].toLowerCase();
      result += allowed.has(name) ? `</${name}>` : '';
      continue;
    }

    const openMatch = /^<\s*([A-Za-z][\w:-]*)([\s\S]*?)(\/?)>$/.exec(rawTag);
    if (!openMatch) {
      // Not a recognizable tag form; drop.
      continue;
    }
    const name = openMatch[1].toLowerCase();
    if (!allowed.has(name)) continue;

    const attrs = buildAttributes(name, openMatch[2] || '', cfg);
    const selfClose = openMatch[3];
    const slash = selfClose || name === 'br' || name === 'hr' || name === 'img' ? ' /' : '';
    result += `<${name}${attrs}${slash}>`;
  }

  return applyAboutCardPostHooks(result);
}
