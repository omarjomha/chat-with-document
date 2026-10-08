import "server-only";

import { del, get, list, put } from "@vercel/blob";

import { TRANSCRIPT_CACHE_TTL_MS } from "@/lib/constants";

export interface CachedTranscript {
  videoId: string;
  title: string;
  /** Raw joined caption text, before normalisation. */
  text: string;
  cachedAt: number;
  expiresAt: number;
}

/**
 * Cache of fetched YouTube transcripts, keyed by video id.
 *
 * This exists because YouTube blocks the whole egress IP once it decides a
 * network is "sending automated queries", and that block lasts hours. Every
 * avoided request is a real reduction in that risk, and repeat requests for the
 * same video are the easy ones to avoid: a reviewer testing the same link three
 * times, a reload, two people trying the example video.
 *
 * Unlike the session store this is not privacy-sensitive -- a transcript is
 * public content, not the user's upload -- so it can outlive a session by a
 * wide margin, and captions for a published video effectively never change.
 */
export interface TranscriptCache {
  /** Must return undefined for a lapsed entry, whether or not it is gone. */
  get(videoId: string): Promise<CachedTranscript | undefined>;
  put(entry: { videoId: string; title: string; text: string }): Promise<void>;
  /** Physically removes lapsed entries. Returns how many were removed. */
  deleteExpired(): Promise<number>;
}

function entryFor(input: { videoId: string; title: string; text: string }): CachedTranscript {
  const now = Date.now();
  return { ...input, cachedAt: now, expiresAt: now + TRANSCRIPT_CACHE_TTL_MS };
}

/** Process-local cache, for local development. */
export class MemoryTranscriptCache implements TranscriptCache {
  private readonly entries = new Map<string, CachedTranscript>();

  async get(videoId: string): Promise<CachedTranscript | undefined> {
    const entry = this.entries.get(videoId);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(videoId);
      return undefined;
    }
    return entry;
  }

  async put(input: { videoId: string; title: string; text: string }): Promise<void> {
    this.entries.set(input.videoId, entryFor(input));
  }

  async deleteExpired(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const [videoId, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(videoId);
        removed += 1;
      }
    }
    return removed;
  }
}

const PREFIX = "transcripts";

function pathFor(videoId: string): string {
  return `${PREFIX}/${videoId}.json`;
}

/** Durable cache backed by Vercel Blob, matching the session store's approach. */
export class BlobTranscriptCache implements TranscriptCache {
  async get(videoId: string): Promise<CachedTranscript | undefined> {
    try {
      // useCache: false for the same reason as the session store -- the CDN
      // will otherwise serve an entry this server has already deleted.
      const result = await get(pathFor(videoId), { access: "private", useCache: false });
      if (!result || result.statusCode !== 200) return undefined;

      const entry = JSON.parse(await new Response(result.stream).text()) as CachedTranscript;

      if (entry.expiresAt <= Date.now()) {
        await this.delete(videoId);
        return undefined;
      }

      return entry;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async put(input: { videoId: string; title: string; text: string }): Promise<void> {
    await put(pathFor(input.videoId), JSON.stringify(entryFor(input)), {
      access: "private",
      contentType: "application/json",
      // The video id is the key, so the path must stay predictable.
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  }

  private async delete(videoId: string): Promise<void> {
    try {
      await del(pathFor(videoId));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async deleteExpired(): Promise<number> {
    const cutoff = Date.now() - TRANSCRIPT_CACHE_TTL_MS;
    const stale: string[] = [];
    let cursor: string | undefined;

    do {
      const page = await list({ prefix: `${PREFIX}/`, cursor, limit: 1000 });
      for (const blob of page.blobs) {
        if (new Date(blob.uploadedAt).getTime() <= cutoff) stale.push(blob.pathname);
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);

    if (stale.length > 0) await del(stale);
    return stale.length;
  }
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /not ?found|404|does not exist/i.test(`${error.name} ${error.message}`);
}

let instance: TranscriptCache | undefined;

/** Blob whenever credentials exist, mirroring getSessionStore. */
export function getTranscriptCache(): TranscriptCache {
  if (!instance) {
    instance = process.env.BLOB_READ_WRITE_TOKEN
      ? new BlobTranscriptCache()
      : new MemoryTranscriptCache();
  }
  return instance;
}

/** Test seam. */
export function setTranscriptCache(cache: TranscriptCache | undefined): void {
  instance = cache;
}
