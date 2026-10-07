import "server-only";

import { del, get, list, put } from "@vercel/blob";

import { SESSION_TTL_MS } from "@/lib/constants";

import type { SessionStore, StoredSession } from "./types";

const PREFIX = "sessions";

function pathFor(id: string): string {
  return `${PREFIX}/${id}.json`;
}

/**
 * Durable store backed by Vercel Blob.
 *
 * Blobs are private, so the extracted document text is never reachable by URL
 * -- only this server can read it, using the store credentials.
 *
 * Vercel Blob has no TTL or lifecycle feature, so expiry is enforced here:
 * `get` refuses a lapsed session regardless of whether its file still exists,
 * which means stale document text can never reach the model even if physical
 * cleanup has not yet run.
 */
export class BlobSessionStore implements SessionStore {
  async save(session: StoredSession): Promise<void> {
    await put(pathFor(session.id), JSON.stringify(session), {
      access: "private",
      contentType: "application/json",
      // Session ids are UUIDs, so the path is already unique; a random suffix
      // would make the blob unreadable by id.
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  }

  async get(id: string): Promise<StoredSession | undefined> {
    try {
      // useCache defaults to true, which serves deleted or just-expired
      // sessions from the CDN cache -- verified in production, where a token
      // was still minted with the context of a session deleted moments
      // earlier. Correctness wins over latency here: the payload is a few KB
      // and is read once per session start.
      const result = await get(pathFor(id), { access: "private", useCache: false });
      // A missing session is an expected outcome (expired, wrong id).
      // statusCode 304 carries no body; we never send conditional headers, so
      // it should not occur, but the type requires handling it.
      if (!result || result.statusCode !== 200) return undefined;

      const session = JSON.parse(await new Response(result.stream).text()) as StoredSession;

      if (session.expiresAt <= Date.now()) {
        // Lapsed but not yet swept. Remove it now and report it as gone.
        await this.delete(id);
        return undefined;
      }

      return session;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await del(pathFor(id));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  /**
   * Sweeps lapsed sessions using each blob's uploadedAt, which `list` returns
   * as metadata. Deciding from metadata avoids downloading every session just
   * to read its expiry.
   */
  async deleteExpired(): Promise<number> {
    const cutoff = Date.now() - SESSION_TTL_MS;
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
