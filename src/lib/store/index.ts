import "server-only";

import { BlobSessionStore } from "./blob";
import { MemorySessionStore } from "./memory";
import type { SessionStore } from "./types";

export type { SessionStore, StoredSession } from "./types";
export { MemorySessionStore } from "./memory";
export { BlobSessionStore } from "./blob";

let instance: SessionStore | undefined;

/**
 * Blob storage is used whenever credentials exist, which covers deployment and
 * any local run after `vercel env pull`. Without credentials -- a fresh clone
 * with only an OpenAI key -- the in-memory store keeps the app usable rather
 * than failing at upload.
 */
export function getSessionStore(): SessionStore {
  if (!instance) {
    instance = process.env.BLOB_READ_WRITE_TOKEN
      ? new BlobSessionStore()
      : new MemorySessionStore();
  }
  return instance;
}

/** Test seam. */
export function setSessionStore(store: SessionStore | undefined): void {
  instance = store;
}
