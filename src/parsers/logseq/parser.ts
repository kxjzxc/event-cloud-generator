/**
 * Logseq Parser — reads a Logseq graph and extracts Events.
 *
 * Event source: each `pages/*.md` file becomes one Event
 * (skipping Logseq internals like contents / whiteboards).
 * Journals are NOT Event sources — they only supply dates via [[page]] links.
 */

import * as fs from 'fs';
import * as path from 'path';
import { marked } from 'marked';
marked.setOptions({
  breaks: true,
  gfm: true,
});
import type { IParser, TMEvent, MediaAsset, MusicTrack } from '../../types';

// ─── Internal block representation ────────────────────────────

interface LogseqBlock {
  /** Content after the list marker ("- " / "* ") */
  content: string;
  properties: Record<string, string>;
  children: LogseqBlock[];
  /** Full raw text of this block and its children */
  rawText: string;
  indent: number;
}

// ─── Parser ───────────────────────────────────────────────────

export class LogseqParser implements IParser {
  readonly name = 'logseq';

  async parse(graphPath: string): Promise<TMEvent[]> {
    const pagesDir = path.join(graphPath, 'pages');
    const journalsDir = path.join(graphPath, 'journals');
    const allEvents: TMEvent[] = [];

    const pageDateMap = this.buildPageDateMap(journalsDir);

    const pageFiles = this.findMarkdownFiles(pagesDir);

    for (const file of pageFiles) {
      const pageName = path.basename(file, '.md');
      if (pageName === 'contents' || pageName === 'whiteboards') continue;

      const relPath = path.relative(graphPath, file);
      const content = fs.readFileSync(file, 'utf-8');
      const blocks = this.parseBlocks(content);
      if (blocks.length === 0) continue;

      const referencedDate = pageDateMap.get(pageName);
      const event = this.pageToEvent(blocks, pageName, relPath, graphPath, file, referencedDate);
      if (event) allEvents.push(event);
    }

    // Journals are date indexes only (via buildPageDateMap above).
    // Free-text journal blocks — with or without [[links]] — never become Events.

    return allEvents;
  }

  private buildPageDateMap(journalsDir: string): Map<string, string> {
    const map = new Map<string, string>();
    if (!fs.existsSync(journalsDir)) return map;

    for (const entry of fs.readdirSync(journalsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const journalDate = this.extractDateFromFilename(entry.name);
      if (!journalDate) continue;

      const filePath = path.join(journalsDir, entry.name);
      const content = fs.readFileSync(filePath, 'utf-8');
      const links = this.extractLinks(content);

      for (const link of links) {
        const existing = map.get(link);
        if (!existing || journalDate > existing) {
          map.set(link, journalDate);
        }
      }
    }

    return map;
  }

  private pageToEvent(
    blocks: LogseqBlock[],
    pageName: string,
    sourceFile: string,
    graphPath: string,
    filePath: string,
    referencedDate?: string,
  ): TMEvent | null {
    const title = pageName;

    const rawContent = fs.readFileSync(filePath, 'utf-8');
    const pageProperties = this.extractPageProperties(rawContent);

    const dateProperty = pageProperties['date']?.trim();
    let date: string;
    let hasValidDate: boolean;

    if (referencedDate) {
      date = referencedDate;
      hasValidDate = true;
    } else if (dateProperty) {
      date = dateProperty;
      hasValidDate = this.isValidISODate(dateProperty);
    } else {
      date = '未知时间的碎片';
      hasValidDate = false;
    }

    const id = this.makeEventId(date, title);

    const tags = this.extractAllTags(rawContent, pageProperties);
    const links = this.extractLinks(rawContent);
    const media = this.extractMedia(rawContent, graphPath);
    const tracks = this.extractTracks(rawContent);
    const contentRaw = this.blocksToPageMarkdown(blocks, tracks);
    const contentHtml = this.renderMarkdown(contentRaw, tracks);

    // Build-time visibility: honor the Logseq page property `hidden:: true`
    // (case-insensitive key, values `true/1/yes/y/on`). Any other value or
    // absence keeps the event public. This mirrors the TMEvent.hidden contract
    // defined in src/types — "parsed but not published".
    const hiddenRaw = pageProperties['hidden']?.trim().toLowerCase();
    const hidden = ['true', '1', 'yes', 'y', 'on'].includes(hiddenRaw ?? '');

    return {
      id,
      title,
      date,
      hasValidDate,
      contentHtml,
      contentRaw,
      tags,
      links,
      media,
      tracks,
      hidden,
      sourceFile,
      siblingIds: [],
      backlinkIds: [],
      relatedIds: [],
    };
  }

  /**
   * Convert page-level Logseq blocks into plain markdown paragraphs.
   *
   * Logseq uses an outliner format where every line starts with "- ".
   * When rendering to HTML we strip that prefix so content renders as
   * normal paragraphs (<p>) rather than list items (<ul><li>).
   *
   * Each top-level block becomes its own paragraph separated by a blank
   * line, so marked produces proper <p> spacing. Nested child blocks are
   * kept as markdown lists (they are genuine sub-items). Inline images and
   * other inline elements keep their original position within each block.
   *
   * `music::` property blocks are replaced in-place with play-button markers
   * (never rendered as markdown links). Other `key:: value` properties are dropped.
   */
  private blocksToPageMarkdown(blocks: LogseqBlock[], tracks: MusicTrack[] = []): string {
    const paragraphs: string[] = [];
    for (const block of blocks) {
      const trimmed = block.content.trim();
      if (!trimmed) continue;

      if (this.isMusicProperty(trimmed)) {
        const track = this.trackFromMusicProperty(trimmed);
        const idx = track
          ? tracks.findIndex((t) => t.platform === track.platform && t.id === track.id)
          : -1;
        if (idx >= 0) {
          paragraphs.push(this.musicPlayMarker(idx));
        }
        continue;
      }

      if (this.isProperty(trimmed)) continue;

      let md = block.content;
      if (block.children.length > 0) {
        const childMd = this.childrenToMarkdown(block.children);
        if (childMd) {
          md += '\n' + childMd;
        }
      }
      paragraphs.push(md);
    }
    return paragraphs.join('\n\n');
  }

  private isMusicProperty(line: string): boolean {
    return /^music::\s*/i.test(line.trim());
  }

  private trackFromMusicProperty(line: string): MusicTrack | null {
    const m = line.trim().match(/^music::\s*(.+)$/i);
    if (!m) return null;
    const value = m[1].trim();
    const mdLink = value.match(/^\[([^\]]*)\]\(([^)]+)\)/);
    if (mdLink) {
      return this.parseMusicUrl(mdLink[2].trim(), mdLink[1].trim() || undefined);
    }
    const bare = value.replace(/^<|>$/g, '').trim();
    if (/^https?:/i.test(bare) || bare.startsWith('//')) {
      return this.parseMusicUrl(bare);
    }
    return null;
  }

  private musicPlayMarker(index: number): string {
    // Raw HTML block — marked passes it through.
    return `<button type="button" class="ec-music-play" data-track-index="${index}"></button>`;
  }

  /**
   * Extract all key:: value properties from raw file content.
   * Keys are normalized to lowercase (Logseq is case-insensitive).
   */
  private extractPageProperties(content: string): Record<string, string> {
    const props: Record<string, string> = {};
    const regex = /^([a-zA-Z_][a-zA-Z0-9_]*)::\s*(.*)$/gm;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) {
      props[m[1].toLowerCase()] = m[2].trim();
    }
    return props;
  }

  /**
   * Extract tags from both tags:: property and inline #hashtags.
   */
  private extractAllTags(content: string, properties: Record<string, string>): string[] {
    const tags = new Set<string>();

    // From tags:: property
    const tagsProp = properties['tags'];
    if (tagsProp) {
      for (const tag of tagsProp.split(/[\s,]+/)) {
        const clean = tag.replace(/^#/, '').trim();
        if (clean) tags.add(clean);
      }
    }

    // From inline #hashtags
    const hashtagRegex = /(?:^|\s)#([\w\u4e00-\u9fff]+)/g;
    let m: RegExpExecArray | null;
    while ((m = hashtagRegex.exec(content)) !== null) {
      tags.add(m[1]);
    }

    return Array.from(tags);
  }

  /**
   * Strip property lines, Logseq metadata blocks (:LOGBOOK:...:END:),
   * and leading H1 heading (if it matches page name).
   * Returns clean markdown content for rendering.
   */
  private stripProperties(content: string, pageName: string): string {
    // Remove :LOGBOOK: ... :END: blocks (Logseq internal clock metadata)
    let stripped = content.replace(/:LOGBOOK:[\s\S]*?:END:/g, '');

    const lines = stripped.split('\n');
    const cleaned: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip property lines (key:: value)
      if (this.isProperty(trimmed)) continue;
      // Skip H1 heading if it matches the page name
      const h1Match = trimmed.match(/^#\s+(.+)$/);
      if (h1Match && h1Match[1].trim() === pageName) continue;
      cleaned.push(line);
    }

    return cleaned.join('\n').trim();
  }

  private formatDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // ─── File discovery ───────────────────────────────────────

  private findMarkdownFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.findMarkdownFiles(fullPath));
      } else if (entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results.sort();
  }

  private extractDateFromFilename(filename: string): string | null {
    const base = filename.replace(/\.md$/, '');
    const m = base.match(/(\d{4})[_-](\d{2})[_-](\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return null;
  }

  private isValidISODate(dateStr: string): boolean {
    const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return false;
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;
    const daysInMonth = new Date(year, month, 0).getDate();
    return day <= daysInMonth;
  }

  // ─── Block parsing ─────────────────────────────────────────

  /**
   * Parse Logseq Markdown into a flat-then-nested block tree.
   *
   * Logseq blocks are list items ("- " / "* "). Indentation determines
   * parent-child relationships. Properties ("key:: value") attach to
   * the nearest parent block.
   */
  private parseBlocks(content: string): LogseqBlock[] {
    // Strip Logseq clock/timer metadata blocks before parsing
    const cleaned = content.replace(/:LOGBOOK:[\s\S]*?:END:/g, '');
    const lines = cleaned.split('\n');
    const roots: LogseqBlock[] = [];
    const stack: { block: LogseqBlock; indent: number }[] = [];

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;

      const indent = this.getIndent(rawLine);
      const isListItem = rawLine.trimStart().startsWith('- ') || rawLine.trimStart().startsWith('* ');

      if (!isListItem && !this.isProperty(trimmed)) {
        if (stack.length > 0 && trimmed && !trimmed.startsWith('---') && trimmed !== '-') {
          const current = stack[stack.length - 1].block;
          if (current.children.length === 0) {
            current.content += '\n' + trimmed;
          }
        }
        continue;
      }

      if (this.isProperty(trimmed)) {
        // Attach property to current block at this indent level
        const prop = this.parseProperty(trimmed);
        if (prop && stack.length > 0) {
          // Find the block at the parent indent level
          for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i].indent < indent) {
              stack[i].block.properties[prop.key] = prop.value;
              break;
            }
          }
        }
        continue;
      }

      if (!isListItem) continue;

      const blockContent = trimmed.replace(/^[-*]\s+/, '');
      if (!blockContent || blockContent === '-') continue;

      const block: LogseqBlock = {
        content: blockContent,
        properties: {},
        children: [],
        rawText: blockContent,
        indent,
      };

      // Pop stack to find parent
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }

      if (stack.length === 0) {
        roots.push(block);
      } else {
        stack[stack.length - 1].block.children.push(block);
      }

      stack.push({ block, indent });
    }

    // Build rawText for each block
    for (const root of roots) {
      this.buildRawText(root);
    }

    return roots;
  }

  private buildRawText(block: LogseqBlock): string {
    let text = block.content;
    for (const child of block.children) {
      text += '\n' + this.buildRawText(child);
    }
    block.rawText = text;
    return text;
  }

  private getIndent(line: string): number {
    const match = line.match(/^(\s*)/);
    if (!match) return 0;
    // Count spaces (treat tab as 2 spaces)
    return match[1].replace(/\t/g, '  ').length;
  }

  private isProperty(line: string): boolean {
    return /^[a-zA-Z_][a-zA-Z0-9_]*::\s/.test(line.trim());
  }

  private parseProperty(line: string): { key: string; value: string } | null {
    const m = line.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)::\s*(.*)$/);
    if (!m) return null;
    return { key: m[1], value: m[2].trim() };
  }

  // ─── Helpers (page-level) ──────────────────────────────────

  private makeEventId(date: string, title: string): string {
    const slug = title
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    return `${date}-${slug}`;
  }

  private extractLinks(text: string): string[] {
    const links = new Set<string>();
    // Match [[...]] but NOT ![[...]] (those are embeds, handled by extractMedia)
    const regex = /(?<!!)\[\[([^\]]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      // Skip asset files (images/videos) — they're embeds, not page links
      const name = m[1].trim();
      const ext = path.extname(name).toLowerCase();
      if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mov', '.webm'].includes(ext)) continue;
      links.add(name);
    }
    return Array.from(links);
  }

  private static readonly VIDEO_EXTS = ['.mp4', '.mov', '.webm'];

  private extractMedia(text: string, graphPath: string): MediaAsset[] {
    const media: MediaAsset[] = [];

    // Markdown images / videos: ![alt](path)
    const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = imgRegex.exec(text)) !== null) {
      const imgPath = m[2];
      const ext = path.extname(imgPath).toLowerCase();
      const resolved = this.resolveAssetPath(imgPath, graphPath);
      if (LogseqParser.VIDEO_EXTS.includes(ext)) {
        media.push({
          originalPath: resolved,
          type: 'video',
          alt: m[1] || undefined,
        });
        continue;
      }
      media.push({
        originalPath: resolved,
        type: 'image',
        alt: m[1] || undefined,
      });
    }

    // Logseq embeds: images kept; videos recorded so Builder can warn & skip
    const embedRegex = /!\[\[([^\]]+\.(?:jpg|jpeg|png|gif|webp|mp4|mov|webm))\]\]/gi;
    while ((m = embedRegex.exec(text)) !== null) {
      const imgPath = m[1];
      const resolved = this.resolveAssetPath(imgPath, graphPath);
      const ext = path.extname(imgPath).toLowerCase();
      media.push({
        originalPath: resolved,
        type: LogseqParser.VIDEO_EXTS.includes(ext) ? 'video' : 'image',
        alt: undefined,
      });
    }

    return media;
  }

  /**
   * Build playlist from preferred `music::` properties, then legacy iframes.
   * Order: all music:: lines (document order), then iframes not already added.
   */
  private extractTracks(content: string): MusicTrack[] {
    const tracks: MusicTrack[] = [];
    const seen = new Set<string>();

    const add = (track: MusicTrack | null) => {
      if (!track) return;
      const key = `${track.platform}:${track.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      tracks.push(track);
    };

    // Preferred: music:: [Title](url)  or  music:: https://...
    // Logseq lines are usually "- music:: ..."; bare "music::" also appears as page props.
    const musicPropRegex = /^[ \t]*(?:-\s+)?music::\s*(.+)$/gim;
    let propMatch: RegExpExecArray | null;
    while ((propMatch = musicPropRegex.exec(content)) !== null) {
      const value = propMatch[1].trim();
      if (!value) continue;

      const mdLink = value.match(/^\[([^\]]*)\]\(([^)]+)\)/);
      if (mdLink) {
        add(this.parseMusicUrl(mdLink[2].trim(), mdLink[1].trim() || undefined));
        continue;
      }

      // Bare URL (optional angle brackets)
      const bare = value.replace(/^<|>$/g, '').trim();
      if (/^https?:/i.test(bare) || bare.startsWith('//')) {
        add(this.parseMusicUrl(bare));
      }
    }

    // Legacy: iframe embeds still work
    const iframeRegex = /<iframe\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = iframeRegex.exec(content)) !== null) {
      const srcMatch = m[0].match(/\bsrc=["']([^"']+)["']/i);
      if (!srcMatch) continue;
      add(this.parseMusicUrl(srcMatch[1]));
    }

    return tracks;
  }

  /**
   * Normalize NetEase / Spotify page URLs and embed URLs into a MusicTrack.
   */
  private parseMusicUrl(rawSrc: string, title?: string): MusicTrack | null {
    let src = rawSrc.trim();
    // Fix soft-wrap / Logseq quirks: "https: //host" → "https://host"
    src = src.replace(/^(https?:)\s+/i, '$1');
    src = src.replace(/\s+/g, '');
    if (src.startsWith('//')) src = 'https:' + src;

    let url: URL;
    try {
      url = new URL(src);
    } catch {
      return null;
    }

    const host = url.hostname.replace(/^www\./, '');

    // NetEase: outchain player, /song?id=, or /#/song?id=
    if (host === 'music.163.com' || host.endsWith('.music.163.com')) {
      let id = url.searchParams.get('id');
      if (!id && url.hash) {
        const hashId = url.hash.match(/[?&]id=(\d+)/);
        if (hashId) id = hashId[1];
      }
      if (!id) {
        const pathId = url.pathname.match(/\/song\/(\d+)/);
        if (pathId) id = pathId[1];
      }
      if (!id) return null;

      const type = url.searchParams.get('type') || '2';
      const height = url.searchParams.get('height') || '66';
      return {
        platform: 'netease',
        id,
        title: title || `网易云 · ${id}`,
        embedUrl: `https://music.163.com/outchain/player?type=${type}&id=${id}&auto=1&height=${height}`,
      };
    }

    // Spotify: /track/ID, /album/ID, or /embed/track/ID
    if (host === 'open.spotify.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      let kind: string | undefined;
      let id: string | undefined;

      const embedIdx = parts.indexOf('embed');
      if (embedIdx >= 0 && parts.length >= embedIdx + 3) {
        kind = parts[embedIdx + 1];
        id = parts[embedIdx + 2];
      } else if (parts.length >= 2) {
        kind = parts[0];
        id = parts[1];
      }

      if (!kind || !id) return null;
      id = id.split('?')[0];

      const kindLabel =
        kind === 'track' ? 'Spotify 单曲' : kind === 'album' ? 'Spotify 专辑' : `Spotify · ${kind}`;
      return {
        platform: 'spotify',
        id,
        title: title || `${kindLabel} · ${id.slice(0, 8)}`,
        embedUrl: `https://open.spotify.com/embed/${kind}/${id}?utm_source=generator`,
      };
    }

    return null;
  }

  private isMusicIframe(iframeHtml: string): boolean {
    return /music\.163\.com|open\.spotify\.com/i.test(iframeHtml);
  }

  private resolveAssetPath(assetRef: string, graphPath: string): string {
    // If already absolute, return as-is
    if (path.isAbsolute(assetRef)) return assetRef;

    // Strip leading "../"
    const cleaned = assetRef.replace(/^(\.\.\/)+/, '');

    // Try resolving against graph root first
    const directPath = path.resolve(graphPath, cleaned);
    if (fs.existsSync(directPath)) return directPath;

    // Try assets/ directory (Logseq stores assets there)
    const assetsPath = path.resolve(graphPath, 'assets', cleaned);
    if (fs.existsSync(assetsPath)) return assetsPath;

    // Fallback: resolve against graph root (file may not exist yet)
    return directPath;
  }

  private childrenToMarkdown(children: LogseqBlock[]): string {
    if (children.length === 0) return '';

    const lines: string[] = [];
    for (const child of children) {
      lines.push(`- ${child.content}`);
      if (child.children.length > 0) {
        const sub = this.childrenToMarkdown(child.children);
        for (const subLine of sub.split('\n')) {
          if (subLine) lines.push('  ' + subLine);
        }
      }
    }
    return lines.join('\n');
  }

  private renderMarkdown(markdown: string, tracks: MusicTrack[] = []): string {
    if (!markdown) return '';

    let processed = markdown;

    // ── Step 1: Extract iframes BEFORE markdown parsing ────────────
    // Music embeds → play-button markers (same tracks[] as music::).
    // Other iframes are lifted out of list context so marked treats them as HTML blocks.
    const iframeBlocks: string[] = [];
    // Indexes already emitted as play buttons (usually from music:: in blocksToPageMarkdown)
    const markedMusicIndexes = new Set<number>();
    for (const m of processed.matchAll(/data-track-index="(\d+)"/g)) {
      markedMusicIndexes.add(parseInt(m[1], 10));
    }
    const replaceMusicIframe = (iframe: string): string => {
      const srcMatch = iframe.match(/\bsrc=["']([^"']+)["']/i);
      if (!srcMatch) return '';
      const track = this.parseMusicUrl(srcMatch[1]);
      if (!track) return '';
      const idx = tracks.findIndex((t) => t.platform === track.platform && t.id === track.id);
      if (idx < 0) return '';
      // Already emitted via music:: (or a prior iframe of the same track)
      if (markedMusicIndexes.has(idx)) return '';
      markedMusicIndexes.add(idx);
      return `\n\n${this.musicPlayMarker(idx)}\n\n`;
    };

    processed = processed.replace(
      /^[ \t]*-[ \t]+(<iframe[\s\S]*?<\/iframe>)/gim,
      (_, iframe: string) => {
        if (this.isMusicIframe(iframe)) return replaceMusicIframe(iframe);
        const idx = iframeBlocks.length;
        iframeBlocks.push(iframe.trim());
        return `\n\n<div class="ec-embed" data-idx="${idx}"></div>\n\n`;
      },
    );
    processed = processed.replace(/<iframe[\s\S]*?<\/iframe>/gi, (iframe) => {
      if (this.isMusicIframe(iframe)) return replaceMusicIframe(iframe);
      return iframe;
    });

    // ── Step 2: Replace inline images with placeholder <img> tags ──
    // Images keep their original position in the text.
    // The "data-ec-orig" attribute is used by the Builder to rewrite paths
    // to processed WebP assets after image processing is complete.
    // Video embeds (![[*.mp4]]) are stripped — video is not supported yet.
    processed = processed.replace(
      /!\[\[([^\]]+\.(?:mp4|mov|webm))\]\]/gi,
      '',
    );
    processed = processed.replace(
      /!\[[^\]]*\]\([^)]+\.(?:mp4|mov|webm)\)/gi,
      '',
    );

    processed = processed.replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      (_, alt: string, src: string) => {
        const cleanSrc = src.trim();
        return `<img class="ec-img" src="${cleanSrc}" data-ec-orig="${cleanSrc}" alt="${alt || ''}" loading="lazy">`;
      },
    );

    // Logseq embed images: ![[path]] — images only
    processed = processed.replace(
      /!\[\[([^\]]+\.(?:jpg|jpeg|png|gif|webp))\]\]/gi,
      (_, src: string) => {
        const cleanSrc = src.trim();
        return `<img class="ec-img" src="${cleanSrc}" data-ec-orig="${cleanSrc}" alt="" loading="lazy">`;
      },
    );

    // ── Step 3: Convert [[links]] to styled anchors ─────────────────
    processed = processed.replace(
      /\[\[([^\]]+)\]\]/g,
      (_, name: string) => `[${name}](#${encodeURIComponent(name)})`,
    );

    // ── Step 4: Render markdown ─────────────────────────────────────
    const html = marked.parse(processed, { async: false }) as string;

    // ── Step 5: Restore iframes in place ───────────────────────────
    let result = html.replace(
      /<div class="ec-embed" data-idx="(\d+)"><\/div>/g,
      (_, idx: string) => iframeBlocks[parseInt(idx, 10)] ?? '',
    );

    // ── Step 6: Style [[link]] anchors ──────────────────────────────
    result = result.replace(
      /<a href="#([^"]+)">/g,
      '<a href="#$1" class="tm-link">',
    );

    // ── Step 7: Remove empty list items (e.g. Logseq blank blocks) ─
    result = result.replace(/<li>\s*<\/li>\s*/g, '');

    return result;
  }
}
