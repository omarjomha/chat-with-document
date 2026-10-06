import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemorySessionStore } from "@/lib/store/memory";
import type { StoredSession } from "@/lib/store/types";

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
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
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("MemorySessionStore", () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore();
    vi.useRealTimers();
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

  it("expires sessions past the TTL", async () => {
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    const session = makeSession({ createdAt: threeHoursAgo });
    await store.save(session);

    await expect(store.get(session.id)).resolves.toBeUndefined();
  });

  it("keeps sessions inside the TTL", async () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const session = makeSession({ createdAt: oneHourAgo });
    await store.save(session);

    await expect(store.get(session.id)).resolves.toEqual(session);
  });

  it("overwrites a session saved under the same id", async () => {
    await store.save(makeSession({ title: "first.pdf" }));
    await store.save(makeSession({ title: "second.pdf" }));

    const found = await store.get(makeSession().id);
    expect(found?.title).toBe("second.pdf");
  });
});
