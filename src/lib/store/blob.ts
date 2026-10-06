import "server-only";

import { del, get, put } from "@vercel/blob";

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
      const result = await get(pathFor(id), { access: "private" });
      // A missing session is an expected outcome (expired, wrong id).
      // statusCode 304 carries no body; we never send conditional headers, so
      // it should not occur, but the type requires handling it.
      if (!result || result.statusCode !== 200) return undefined;
      const raw = await new Response(result.stream).text();
      return JSON.parse(raw) as StoredSession;
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
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /not ?found|404|does not exist/i.test(`${error.name} ${error.message}`);
}
