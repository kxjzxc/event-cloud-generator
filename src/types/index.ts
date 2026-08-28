/**
 * Event Cloud — Core Types & Plugin Interfaces
 *
 * All plugin contracts live here. The Builder only talks to these interfaces,
 * never to concrete implementations.
 */

// ─── Data Models ──────────────────────────────────────────────

/**
 * A media asset referenced by an Event.
 * Paths are relative to the graph root during parsing,
 * then rewritten to site-relative paths during rendering.
 */
export interface MediaAsset {
  originalPath: string;
  thumbnailPath?: string;
  previewPath?: string;
  type: 'image' | 'video';
  alt?: string;
}

/**
 * External music track from `music::` / legacy iframes (NetEase / Spotify).
 * Card content shows a play button; audio plays via the site-wide player.
 */
export interface MusicTrack {
  platform: 'netease' | 'spotify';
  /** Platform-specific track id */
  id: string;
  /** Song title (enriched at build when possible) */
  title: string;
  /** Artist name(s), if known */
  artist?: string;
  /** Cover art URL, if known */
  coverUrl?: string;
  /** Duration in milliseconds, if known */
  durationMs?: number;
  /**
   * Direct audio URL for HTML5 playback (enables progress / seek).
   * When absent, player falls back to a hidden platform embed (no progress).
   */
  audioUrl?: string;
  /** Platform embed URL used as fallback audio engine */
  embedUrl: string;
}

/**
 * Event — the atomic unit of the Event Cloud.
 *
 * Each `pages/*.md` file becomes one Event.
 * Journals are not Event sources; they only help resolve dates via [[page]] links.
 */
export interface TMEvent {
  /** Stable unique id: `${date}-${slug}` */
  id: string;
  /** First line / page title */
  title: string;
  /** Date string (can be ISO date or descriptive text) */
  date: string;
  /** Whether the date is a valid ISO date (can be used for date lookup) */
  hasValidDate: boolean;
  /** Page content rendered as HTML */
  contentHtml: string;
  /** Raw page content (markdown) for search / archive */
  contentRaw: string;
  tags: string[];
  /** Page names referenced via [[double-bracket]] links */
  links: string[];
  media: MediaAsset[];
  /** Music embeds from the page, in document order (card playlist) */
  tracks: MusicTrack[];
  /** Build-time visibility flag. Hidden events are parsed but not published. */
  hidden: boolean;
  /** Path to the source page file (relative to graph root) */
  sourceFile: string;
  /** Other Event ids from the same date */
  siblingIds: string[];
  /** Event IDs that link TO this event (via [[this event's title]]) */
  backlinkIds: string[];
  /** Event IDs related by shared tags */
  relatedIds: string[];
}

/**
 * Lightweight index entry for index.json.
 * Contains just enough data for random selection and archive listing
 * without loading full event content.
 */
export interface EventIndexEntry {
  id: string;
  title: string;
  date: string;
  tags: string[];
  hasMedia: boolean;
  mediaCount: number;
}

// ─── Plugin Interfaces ────────────────────────────────────────

/**
 * Parser plugin — reads a note graph and extracts Events.
 * Logseq is the first implementation; Obsidian / plain Markdown can follow.
 */
export interface IParser {
  readonly name: string;
  parse(graphPath: string): Promise<TMEvent[]>;
}

/**
 * Storage plugin — abstract file system for writing output.
 * Local is the default; R2 / OSS / S3 can plug in later.
 */
export interface IStorage {
  readonly name: string;
  save(filePath: string, content: Buffer | string): Promise<void>;
  read(filePath: string): Promise<Buffer>;
  exists(filePath: string): Promise<boolean>;
}

/**
 * Image processor plugin — generates derivatives (thumbnail, preview).
 */
export interface IImageProcessor {
  readonly name: string;
  process(
    inputPath: string,
    outputDir: string,
    config: ImageProcessConfig,
  ): Promise<ProcessedImage>;
}

/**
 * Renderer plugin — converts Events + index into static HTML pages.
 *
 * Optional `aboutHtml` is pre-rendered, sanitized HTML for an "About" entrypoint.
 * When present and non-empty, renderers should surface an About link/modal on the
 * home page; when absent or empty the entrypoint MUST be hidden so existing
 * downstream renderers (that only know the 3-arg signature) keep working without
 * any behavioral change.
 */
export interface IRenderer {
  readonly name: string;
  render(
    events: TMEvent[],
    index: EventIndexEntry[],
    ctx: RenderContext,
    aboutHtml?: string,
  ): Promise<void>;
}

// ─── Config Types ─────────────────────────────────────────────

export interface ImageProcessConfig {
  thumbnailSize: number;
  previewSize: number;
}

export interface ProcessedImage {
  thumbnailPath: string;
  previewPath: string;
  originalFilename: string;
}

export interface DeployConfig {
  type: 'github-pages';
  repo?: string;
  branch?: string;
  message?: string;
  /**
   * GitHub owner/repo slug (e.g. "kxjzxc/event-cloud").
   * Required for triggering repository_dispatch via CI Webhook.
   * Falls back to parsing `repo` URL if omitted.
   */
  githubRepo?: string;
}

export interface ThemeConfig {
  name: string;
  description?: string;
  author?: string;
  version?: string;
}

export interface TMConfig {
  logseqPath: string;
  outputPath: string;
  storage: string;
  media: ImageProcessConfig;
  deploy?: DeployConfig;
  theme?: string;
  /** Include hidden events in generated output. Defaults to false. */
  includeHidden?: boolean;
}

export interface RenderContext {
  outputPath: string;
  storage: IStorage;
  config: TMConfig;
}

// ─── Plugin Registry ──────────────────────────────────────────

/**
 * The Builder uses a registry to look up plugins by name.
 * This keeps the core decoupled — swap implementations via config.
 */
export interface PluginRegistry {
  parsers: Map<string, () => IParser>;
  storages: Map<string, () => IStorage>;
  renderers: Map<string, () => IRenderer>;
  imageProcessors: Map<string, () => IImageProcessor>;
}
