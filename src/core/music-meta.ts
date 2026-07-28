/**
 * Enrich MusicTrack with title / artist / cover via platform APIs.
 *
 * - Failures are non-fatal (build continues with whatever we already have).
 * - Results are cached under `.cache/music.json` so builds stay faster / more
 *   deterministic when offline or when third-party APIs flap.
 * - Requests run with a small concurrency pool (default 5), not fully serial.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { MusicTrack } from '../types';

const execFileAsync = promisify(execFile);

const GENERIC_TITLE =
  /^(网易云(音乐)?|spotify|Spotify|网易云\s*·|Spotify\s*(单曲|专辑)?\s*·)/i;

const DEFAULT_CONCURRENCY = 5;

export interface MusicCacheEntry {
  title?: string;
  artist?: string;
  coverUrl?: string;
  durationMs?: number;
  audioUrl?: string;
  /** ISO timestamp when this entry was written */
  fetchedAt?: string;
}

export type MusicCache = Record<string, MusicCacheEntry>;

export interface EnrichOptions {
  /** Absolute or relative path to cache JSON (default: `.cache/music.json`) */
  cachePath?: string;
  /** Max parallel HTTP enrichments (default: 5) */
  concurrency?: number;
  /** Progress callback: unique tracks processed so far */
  onProgress?: (done: number, total: number) => void;
}

function isGenericTitle(title?: string): boolean {
  if (!title || !title.trim()) return true;
  return GENERIC_TITLE.test(title.trim());
}

function trackKey(track: MusicTrack): string {
  return `${track.platform}:${track.id}`;
}

/** Enough metadata that we can skip another network round-trip. */
export function isTrackComplete(track: MusicTrack): boolean {
  return (
    !isGenericTitle(track.title) &&
    Boolean(track.artist && track.artist.trim()) &&
    Boolean(track.coverUrl && track.coverUrl.trim())
  );
}

function applyCachedFields(track: MusicTrack, entry: MusicCacheEntry | undefined): void {
  if (!entry) return;
  if (entry.title && (isGenericTitle(track.title) || !track.title)) {
    track.title = entry.title;
  }
  if (entry.artist && !track.artist) track.artist = entry.artist;
  if (entry.coverUrl && !track.coverUrl) track.coverUrl = entry.coverUrl;
  if (entry.durationMs && !track.durationMs) track.durationMs = entry.durationMs;
  if (entry.audioUrl && !track.audioUrl) track.audioUrl = entry.audioUrl;
}

function snapshotTrack(track: MusicTrack): MusicCacheEntry {
  return {
    title: track.title,
    artist: track.artist,
    coverUrl: track.coverUrl,
    durationMs: track.durationMs,
    audioUrl: track.audioUrl,
    fetchedAt: new Date().toISOString(),
  };
}

function copyMeta(from: MusicTrack, to: MusicTrack): void {
  if (from.title) to.title = from.title;
  if (from.artist) to.artist = from.artist;
  if (from.coverUrl) to.coverUrl = from.coverUrl;
  if (from.durationMs) to.durationMs = from.durationMs;
  if (from.audioUrl) to.audioUrl = from.audioUrl;
}

function loadCache(cachePath: string): MusicCache {
  try {
    if (!fs.existsSync(cachePath)) return {};
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as MusicCache) : {};
  } catch {
    return {};
  }
}

function saveCache(cachePath: string, cache: MusicCache): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
  } catch {
    // Non-fatal — build must not fail because cache is unwritable.
  }
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        await worker(items[i]);
      }
    }),
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTextOnce(url: string, extraHeaders: string[] = []): Promise<string | null> {
  // Prefer curl so HTTPS_PROXY / http_proxy are honored (Node fetch often ignores them).
  try {
    const args = [
      '-sS',
      '-L',
      '--max-time',
      '15',
      '-A',
      'Mozilla/5.0 (compatible; EventCloud/1.0; +https://github.com/kxjzxc/event-cloud-generator)',
      ...extraHeaders.flatMap((h) => ['-H', h]),
      url,
    ];
    const { stdout } = await execFileAsync('curl', args, {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  } catch {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: '*/*',
          'User-Agent':
            'Mozilla/5.0 (compatible; EventCloud/1.0; +https://github.com/kxjzxc/event-cloud-generator)',
        },
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }
}

/** Fetch with exponential backoff (3 attempts: 0 / 400 / 1200 ms). */
async function fetchText(url: string, extraHeaders: string[] = []): Promise<string | null> {
  const delays = [0, 400, 1200];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await sleep(delays[i]);
    const text = await fetchTextOnce(url, extraHeaders);
    if (text != null && text !== '') return text;
  }
  return null;
}

async function fetchJson(url: string, extraHeaders: string[] = []): Promise<any | null> {
  const text = await fetchText(url, ['Accept: application/json', ...extraHeaders]);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function enrichNetEase(track: MusicTrack): Promise<void> {
  // Deterministic — no network needed.
  if (!track.audioUrl) {
    track.audioUrl = `https://music.163.com/song/media/outer/url?id=${track.id}.mp3`;
  }

  const data = await fetchJson(
    `https://music.163.com/api/song/detail/?ids=[${encodeURIComponent(track.id)}]`,
    ['Referer: https://music.163.com/'],
  );
  const song = data?.songs?.[0];
  if (!song) return;

  if (song.name && (isGenericTitle(track.title) || !track.title)) {
    track.title = String(song.name);
  }
  const artists = Array.isArray(song.artists)
    ? song.artists.map((a: { name?: string }) => a?.name).filter(Boolean)
    : [];
  if (artists.length && !track.artist) {
    track.artist = artists.join(' / ');
  }
  const cover = song.album?.picUrl || song.album?.blurPicUrl;
  if (cover && !track.coverUrl) {
    track.coverUrl = String(cover).replace(/^http:\/\//i, 'https://');
  }
  const duration = Number(song.duration ?? song.dt);
  if (Number.isFinite(duration) && duration > 0) {
    track.durationMs = duration;
  }
}

/**
 * Spotify oEmbed title is often `"Song — Artist"` (em dash / en dash / hyphen).
 * Prefer splitting so title and artist stay consistent with embed-page parsing.
 */
function applySpotifyOembedTitle(track: MusicTrack, rawTitle: string): void {
  const title = rawTitle.trim();
  if (!title) return;

  const parts = title.split(/\s+[—–-]\s+/);
  if (parts.length >= 2) {
    const song = parts[0].trim();
    const artist = parts.slice(1).join(' — ').trim();
    if (song && (isGenericTitle(track.title) || !track.title)) {
      track.title = song;
    }
    if (artist && !track.artist) {
      track.artist = artist;
    }
    return;
  }

  if (isGenericTitle(track.title) || !track.title) {
    track.title = title;
  }
}

async function enrichSpotify(track: MusicTrack): Promise<void> {
  const pageUrl = `https://open.spotify.com/track/${track.id}`;
  const oembed = await fetchJson(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(pageUrl)}`,
  );
  if (oembed) {
    if (oembed.title) {
      applySpotifyOembedTitle(track, String(oembed.title));
    }
    if (oembed.thumbnail_url && !track.coverUrl) {
      track.coverUrl = String(oembed.thumbnail_url);
    }
  }

  // Embed page can refine artist / duration. Prefer HTML artist when present
  // (more accurate than oEmbed's combined title), keep oEmbed title as song name.
  const html = await fetchText(`https://open.spotify.com/embed/track/${track.id}`);
  if (!html) return;

  const artists: string[] = [];
  const block = html.match(/"artists"\s*:\s*\[([^\]]*)\]/);
  if (block) {
    const nameRe = /"name"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    let m: RegExpExecArray | null;
    while ((m = nameRe.exec(block[1])) !== null) {
      artists.push(m[1].replace(/\\"/g, '"'));
    }
  }
  if (artists.length) {
    // HTML artists win over oEmbed-split artist when available.
    track.artist = artists.join(' / ');
  }

  // Prefer entity name from embed JSON when title is still generic.
  if (isGenericTitle(track.title) || !track.title) {
    const nameMatch = html.match(/"entity"\s*:\s*\{[^}]*"name"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (nameMatch) {
      track.title = nameMatch[1].replace(/\\"/g, '"');
    }
  }

  if (!track.durationMs) {
    const dur = html.match(/"duration"\s*:\s*(\d+)/);
    if (dur) {
      const ms = parseInt(dur[1], 10);
      if (ms > 0) track.durationMs = ms;
    }
  }
}

export async function enrichMusicTrack(track: MusicTrack): Promise<MusicTrack> {
  if (track.platform === 'netease') {
    await enrichNetEase(track);
  } else if (track.platform === 'spotify') {
    await enrichSpotify(track);
  }
  return track;
}

/**
 * Enrich all tracks: apply cache → skip complete → fetch with concurrency.
 * Deduplicates by platform:id so the same song is only requested once per build.
 */
export async function enrichAllTracks(
  tracks: MusicTrack[],
  options: EnrichOptions = {},
): Promise<void> {
  if (!tracks.length) return;

  const cachePath = path.resolve(options.cachePath || path.join('.cache', 'music.json'));
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const cache = loadCache(cachePath);

  // NetEase audio URL is deterministic — fill before completeness checks.
  for (const track of tracks) {
    if (track.platform === 'netease' && !track.audioUrl) {
      track.audioUrl = `https://music.163.com/song/media/outer/url?id=${track.id}.mp3`;
    }
  }

  const groups = new Map<string, MusicTrack[]>();
  for (const track of tracks) {
    const key = trackKey(track);
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push(track);
  }

  const entries = Array.from(groups.entries());
  let done = 0;
  const total = entries.length;
  let dirty = false;

  await mapPool(entries, concurrency, async ([key, group]) => {
    const primary = group[0];
    applyCachedFields(primary, cache[key]);

    if (!isTrackComplete(primary)) {
      await enrichMusicTrack(primary);
      // Only persist when we got something useful beyond a bare id label.
      if (primary.title || primary.artist || primary.coverUrl || primary.durationMs) {
        cache[key] = snapshotTrack(primary);
        dirty = true;
      }
    }

    for (let i = 1; i < group.length; i++) {
      copyMeta(primary, group[i]);
    }

    done += 1;
    options.onProgress?.(done, total);
  });

  if (dirty) saveCache(cachePath, cache);
}

/** @deprecated Prefer enrichAllTracks — kept for call-site clarity in tests. */
export async function enrichEventTracks(tracks: MusicTrack[]): Promise<void> {
  await enrichAllTracks(tracks);
}
