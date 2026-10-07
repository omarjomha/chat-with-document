import { beforeEach, describe, expect, it } from "vitest";

import { SESSION_TTL_MS } from "@/lib/constants";
import { MemorySessionStore } from "@/lib/store/memory";
import type { StoredSession } from "@/lib/store/types";

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  const createdAt = overrides.createdAt ?? Date.now();
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "pdf",
    title: "Example.pdf",
    text: "hello world",
    truncated: false,
    originalChars: 11,
    usedChars: 11,
    approxTokens: 3,
    pages: 1,
    createdAt,
    expiresAt: createdAt + SESSION_TTL_MS,
    ...overrides,
  };
}

describe("MemorySessionStore", () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it("round-trips a saved session", async () => {
    const session = makeSession();
    await store.save(session);

    await expect(store.get(session.id)).resolves.toEqual(session);
  });

  it("returns undefined for an unknown id rather than throwing", async () => {
    await expect(store.get("missing")).resolves.toBeUndefined();
  });

  it("deletes a session", async () => {
    const session = makeSession();
    await store.save(session);
    await store.delete(session.id);

    await expect(store.get(session.id)).resolves.toBeUndefined();
  });

  it("treats deleting an unknown id as a no-op", async () => {
    await expect(store.delete("missing")).resolves.toBeUndefined();
  });

  it("refuses a session whose expiry has passed", async () => {
    const session = makeSession({ expiresAt: Date.now() - 1 });
    await store.save(session);

    await expect(store.get(session.id)).resolves.toBeUndefined();
  });

  it("serves a session that has not yet expired", async () => {
    const session = makeSession({ expiresAt: Date.now() + 60_000 });
    await store.save(session);

    await expect(store.get(session.id)).resolves.toEqual(session);
  });

  it("drops an expired session from storage once read", async () => {
    const session = makeSession({ expiresAt: Date.now() - 1 });
    await store.save(session);
    await store.get(session.id);

    // A subsequent sweep finds nothing because the read already removed it.
    await expect(store.deleteExpired()).resolves.toBe(0);
  });

  it("overwrites a session saved under the same id", async () => {
    await store.save(makeSession({ title: "first.pdf" }));
    await store.save(makeSession({ title: "second.pdf" }));

    const found = await store.get(makeSession().id);
    expect(found?.title).toBe("second.pdf");
  });
});

describe("MemorySessionStore.deleteExpired", () => {
  it("removes only the lapsed sessions and reports the count", async () => {
    const store = new MemorySessionStore();
    const now = Date.now();

    await store.save(makeSession({ id: "a", expiresAt: now + 60_000 }));
    await store.save(makeSession({ id: "b", expiresAt: now - 1 }));
    await store.save(makeSession({ id: "c", expiresAt: now - 60_000 }));

    await expect(store.deleteExpired()).resolves.toBe(2);
    await expect(store.get("a")).resolves.toBeDefined();
    await expect(store.get("b")).resolves.toBeUndefined();
    await expect(store.get("c")).resolves.toBeUndefined();
  });

  it("returns zero when nothing has lapsed", async () => {
    const store = new MemorySessionStore();
    await store.save(makeSession({ expiresAt: Date.now() + 60_000 }));

    await expect(store.deleteExpired()).resolves.toBe(0);
  });

  it("leaves unexpired sessions untouched", async () => {
    const store = new MemorySessionStore();
    await store.save(makeSession({ id: "fresh", expiresAt: Date.now() + 60_000 }));

    await store.deleteExpired();

    await expect(store.get("fresh")).resolves.toBeDefined();
  });
});
