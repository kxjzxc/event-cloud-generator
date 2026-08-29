/**
 * Builder — the core orchestrator.
 *
 * Pipeline:
 *   Parser → Events → Image Processor → Renderer → Static Site
 *
 * The Builder never touches Logseq data directly. It delegates everything
 * to plugins and only coordinates the flow.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  TMConfig,
  TMEvent,
  EventIndexEntry,
  IParser,
  IStorage,
  IRenderer,
  IImageProcessor,
  PluginRegistry,
  RenderContext,
} from '../types';
import { enrichAllTracks } from './music-meta';
import { sanitizeHtmlSimple } from '../utils/sanitize-html-simple';

export interface BuildOptions {
  dryRun?: boolean;
  verbose?: boolean;
}

export interface BuildStats {
  events: number;
  images: number;
  videos: number;
  backlinks: number;
  relatedPairs: number;
  tags: number;
  outputFiles: number;
}

export class Builder {
  private registry: PluginRegistry;
  private config: TMConfig;

  constructor(registry: PluginRegistry, config: TMConfig) {
    this.registry = registry;
    this.config = config;
  }

  async build(options: BuildOptions = {}): Promise<BuildStats> {
    const { dryRun, verbose } = options;
    const log = (msg: string) => {
      if (verbose || dryRun) console.log(msg);
    };

    // 1. Resolve plugins
    const parserFactory = this.registry.parsers.get('logseq');
    const storageFactory = this.registry.storages.get(this.config.storage);
    const rendererFactory = this.registry.renderers.get('default');
    const imageFactory = this.registry.imageProcessors.get('sharp');

    if (!parserFactory || !storageFactory || !rendererFactory || !imageFactory) {
      throw new Error('Missing required plugin. Check config and registry.');
    }

    const parser: IParser = parserFactory();
    const storage: IStorage = (storageFactory as any)(this.config.outputPath);
    const renderer: IRenderer = rendererFactory();
    const imageProcessor: IImageProcessor = imageFactory();

    // 2. Clean output (preserve assets/ for incremental image processing)
    this.cleanOutput();

    // 3. Parse the graph
    log('Parsing Logseq graph...');
    const parsedEvents = await parser.parse(this.config.logseqPath);
    const hiddenEvents = parsedEvents.filter((e) => e.hidden);
    const includeHidden = this.config.includeHidden === true;
    const events = includeHidden ? parsedEvents : parsedEvents.filter((e) => !e.hidden);
    log(`Found ${parsedEvents.length} events (${hiddenEvents.length} hidden, ${events.length} published).`);
    if (includeHidden && hiddenEvents.length > 0) {
      log('  Hidden events included by config.');
    }

    if (dryRun) {
      console.log(`\n[Dry Run] Parsed ${events.length} published events${includeHidden ? ' (hidden included)' : ''}:`);
      for (const e of events) {
        const marker = e.hidden ? ' [hidden]' : '';
        console.log(`  • ${e.date} — ${e.title}${marker} (${e.media.length} media, ${e.tags.length} tags)`);
      }
      return { events: events.length, images: 0, videos: 0, backlinks: 0, relatedPairs: 0, tags: 0, outputFiles: 0 };
    }

    // 3b. Build bidirectional link relationships
    log('Building link relationships...');
    this.buildRelations(events);
    log(`  Backlinks: ${events.reduce((s, e) => s + e.backlinkIds.length, 0)}`);
    log(`  Related: ${events.reduce((s, e) => s + e.relatedIds.length, 0)}`);

    // 3c. Enrich music tracks (title / artist / cover) with cache + concurrency
    const allTracks = events.flatMap((e) => e.tracks || []);
    if (allTracks.length > 0) {
      log(`Enriching music metadata (${allTracks.length} track refs)...`);
      await enrichAllTracks(allTracks, {
        cachePath: path.join(process.cwd(), '.cache', 'music.json'),
        concurrency: 5,
        onProgress: (done, total) => {
          if (done === total || done % 5 === 0 || done === 1) {
            log(`  Music metadata (${done}/${total})`);
          }
        },
      });
    }

    // 4. Process images
    log('Processing images...');
    const assetsDir = path.join(this.config.outputPath, 'assets');
    let skippedVideos = 0;

    for (const event of events) {
      // Map from original asset path → processed site-relative paths
      const origToThumb = new Map<string, string>();
      const origToPreview = new Map<string, string>();

      for (const asset of event.media) {
        if (asset.type === 'image' && fs.existsSync(asset.originalPath)) {
          const processed = await imageProcessor.process(
            asset.originalPath,
            assetsDir,
            this.config.media,
          );
          // Rewrite paths to be site-relative
          asset.thumbnailPath = path.relative(
            this.config.outputPath,
            processed.thumbnailPath,
          ).replace(/\\/g, '/');
          asset.previewPath = path.relative(
            this.config.outputPath,
            processed.previewPath,
          ).replace(/\\/g, '/');

          // Track mapping for contentHtml rewriting
          origToThumb.set(asset.originalPath, asset.thumbnailPath);
          origToPreview.set(asset.originalPath, asset.previewPath);
        } else if (asset.type === 'video') {
          skippedVideos += 1;
          log(`  ⚠ Video skipped (unsupported): ${path.basename(asset.originalPath)}`);
        }
      }

      // Rewrite inline image paths in contentHtml:
      // The parser emits <img class="ec-img" src="ORIG_PATH" data-ec-orig="ORIG_PATH" alt="..." loading="lazy">
      // Replace the whole <img> with a clean version using processed WebP paths.
      // We match the entire tag and rebuild it from scratch to avoid duplicate attributes.
      if (origToThumb.size > 0) {
        event.contentHtml = event.contentHtml.replace(
          /<img[^>]*?data-ec-orig="([^"]+)"[^>]*?>/g,
          (match, origSrc: string) => {
            const resolved = this.resolveOrigSrc(origSrc, this.config.logseqPath);
            const thumb = origToThumb.get(resolved);
            const preview = origToPreview.get(resolved);
            if (!thumb) return match;

            // Extract alt text from original tag
            const altMatch = match.match(/\balt="([^"]*)"/);
            const alt = altMatch ? altMatch[1] : '';
            return `<img class="ec-img" src="../${thumb}" data-preview="../${preview || thumb}" alt="${alt}" loading="lazy">`;
          },
        );
      }
    }

    log('Image processing complete.');
    if (skippedVideos > 0) {
      log(`  Skipped ${skippedVideos} video asset(s) (unsupported for now).`);
    }

    // 4. Build index
    const index: EventIndexEntry[] = events.map((e) => ({
      id: e.id,
      title: e.title,
      date: e.date,
      tags: e.tags,
      hasMedia: e.media.length > 0,
      mediaCount: e.media.length,
    }));

    // 5. Render
    log('Rendering static site...');
    // 5a. Read, render, and sanitize about.md if it exists at the graph root.
    //
    //     SECURITY PIPELINE (in order, defense in depth):
    //
    //     1) marked.parse() with HTML BLOCKED via custom renderer.html()
    //        Any raw HTML written by the user directly inside about.md
    //        (e.g. <script>, <iframe>, <p onclick=...>) is HTML-escaped into
    //        plain text so it can never reach the output as DOM nodes.
    //        This is our primary defense. We deliberately DO NOT rely on
    //        marked's legacy `sanitize` option (removed in marked v6).
    //
    //     2) sanitizeHtmlSimple — zero-dep tag/attr allow-list parser
    //        Secondary / belt-and-suspenders. Even if a future marked bug
    //        leaks a tag, or a markdown construct maps to a tag we don't
    //        want, the allow-list strips it. Handles protocol gating,
    //        on* handler stripping, and post-processes external links to
    //        target=_blank + rel=noopener noreferrer nofollow.
    //
    //     3) </script> escape — only needed because aboutHtml itself is
    //        later injected next to <script type="application/json"> blocks;
    //        this is a defense-in-depth guard for nested script-tag closing.
    let aboutHtml = '';
    const aboutMdPath = path.join(this.config.logseqPath, 'about.md');
    if (fs.existsSync(aboutMdPath)) {
      try {
        const { marked, Renderer } = await import('marked');
        // Marked v12: `Renderer` is the built-in HTML renderer base class.
        // We keep all markdown-native token rendering (links, lists, images,
        // emphasis, headings) and only override the `html` token emitter to
        // escape raw HTML instead of passing it through verbatim.
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
        const raw = fs.readFileSync(aboutMdPath, 'utf-8');
        const rawHtml = marked.parse(raw) as string;
        const clean = sanitizeHtmlSimple(rawHtml);
        aboutHtml = String(clean || '').replace(/<\/script/gi, '<\\/script');
        log(`  Loaded about.md (${aboutMdPath})`);
      } catch (e) {
        log(`  ⚠ Failed to parse about.md: ${e}`);
        aboutHtml = '';
      }
    }
    const ctx: RenderContext = {
      outputPath: this.config.outputPath,
      storage,
      config: this.config,
    };
    await renderer.render(events, index, ctx, aboutHtml);

    // 6. Write index.json
    await storage.save('index.json', JSON.stringify(index, null, 2));
    log('Wrote index.json');

    // 7. Compute stats
    const allTags = new Set<string>();
    let imageCount = 0;
    let videoCount = 0;
    for (const e of events) {
      for (const t of e.tags) allTags.add(t);
      for (const m of e.media) {
        if (m.type === 'image') imageCount++;
        else if (m.type === 'video') videoCount++;
      }
    }

    // Count output files
    let outputFiles = 0;
    const countFiles = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) countFiles(full);
        else outputFiles++;
      }
    };
    countFiles(this.config.outputPath);

    const stats: BuildStats = {
      events: events.length,
      images: imageCount,
      videos: videoCount,
      backlinks: events.reduce((s, e) => s + e.backlinkIds.length, 0),
      relatedPairs: events.reduce((s, e) => s + e.relatedIds.length, 0),
      tags: allTags.size,
      outputFiles,
    };

    log('\nBuild complete.');
    log(`  Events: ${stats.events}`);
    log(`  Output: ${this.config.outputPath}`);

    return stats;
  }

  /**
   * Resolve a src attribute from contentHtml back to an absolute filesystem path.
   * The parser writes paths like "../assets/foo.jpg" (relative to pages/) or
   * absolute paths — this converts them back to the absolute form so we can
   * look them up in the origToThumb map built during image processing.
   */
  private resolveOrigSrc(src: string, graphPath: string): string {
    if (path.isAbsolute(src)) return src;
    const cleaned = src.replace(/^(\.\.\/)+/, '');
    const direct = path.resolve(graphPath, cleaned);
    if (fs.existsSync(direct)) return direct;
    const assetsPath = path.resolve(graphPath, 'assets', cleaned);
    if (fs.existsSync(assetsPath)) return assetsPath;
    return direct;
  }

  /**
   * Remove everything in the output directory except assets/.
   * This ensures stale event pages from previous builds don't linger,
   * while preserving incrementally-processed images.
   */
  private cleanOutput(): void {
    const output = this.config.outputPath;
    if (!fs.existsSync(output)) return;

    for (const entry of fs.readdirSync(output)) {
      if (entry === 'assets') continue; // preserve for incremental processing
      const fullPath = path.join(output, entry);
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
  }

  /**
   * Build bidirectional link relationships after all events are parsed.
   *
   * 1. Backlinks: if event A's `links` contains event B's title,
   *    then B gets A's ID in its `backlinkIds`.
   *
   * 2. Related events: events that share at least one tag,
   *    limited to top 5 by overlap count.
   */
  private buildRelations(events: TMEvent[]): void {
    const titleToId = new Map<string, string>();
    for (const e of events) {
      titleToId.set(e.title.toLowerCase(), e.id);
    }

    // Siblings: events on the same date (reserved for future "same day navigation" feature)
    const dateGroups = new Map<string, TMEvent[]>();
    for (const e of events) {
      if (!dateGroups.has(e.date)) dateGroups.set(e.date, []);
      dateGroups.get(e.date)!.push(e);
    }
    for (const [date, group] of dateGroups) {
      if (group.length > 1) {
        const siblingIds = group.map((e) => e.id);
        for (const e of group) {
          e.siblingIds = siblingIds.filter((id) => id !== e.id);
        }
      }
    }

    // Backlinks
    for (const source of events) {
      for (const linkName of source.links) {
        const targetId = titleToId.get(linkName.toLowerCase());
        if (targetId && targetId !== source.id) {
          const target = events.find((e) => e.id === targetId);
          if (target && !target.backlinkIds.includes(source.id)) {
            target.backlinkIds.push(source.id);
          }
        }
      }
    }

    // Related events (shared tags)
    for (const event of events) {
      if (event.tags.length === 0) continue;

      const scored: { id: string; score: number }[] = [];
      for (const other of events) {
        if (other.id === event.id) continue;
        const shared = other.tags.filter((t) => event.tags.includes(t));
        if (shared.length > 0) {
          scored.push({ id: other.id, score: shared.length });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      event.relatedIds = scored.slice(0, 5).map((s) => s.id);
    }
  }
}
