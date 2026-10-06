import type { SessionStore, StoredSession } from "./types";

/** Sessions older than this are evicted so a long dev run cannot grow forever. */
const TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Process-local store for local development.
 *
 * Deliberately not used in production -- see the note on SessionStore.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, StoredSession>();

  async save(session: StoredSession): Promise<void> {
    this.evictExpired();
    this.sessions.set(session.id, session);
  }

  async get(id: string): Promise<StoredSession | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (Date.now() - session.createdAt > TTL_MS) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  private evictExpired(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, session] of this.sessions) {
      if (session.createdAt < cutoff) this.sessions.delete(id);
    }
  }
}
