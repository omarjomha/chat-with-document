import type { SessionStore, StoredSession } from "./types";

/**
 * Process-local store for local development.
 *
 * Deliberately not used in production -- see the note on SessionStore.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, StoredSession>();

  async save(session: StoredSession): Promise<void> {
    // Deliberately does not sweep: createSession drives cleanup so both store
    // implementations behave identically, and save stays a plain write.
    this.sessions.set(session.id, session);
  }

  async get(id: string): Promise<StoredSession | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async deleteExpired(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
