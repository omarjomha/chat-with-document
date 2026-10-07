// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_TTL_MS } from "@/lib/constants";
import { createSession } from "@/lib/ingest/session";
import { getSessionStore, setSessionStore } from "@/lib/store";
import { MemorySessionStore } from "@/lib/store/memory";

describe("createSession", () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore();
    setSessionStore(store);
  });

  afterEach(() => {
    setSessionStore(undefined);
  });

  it("persists the ingested document and returns its id", async () => {
    const result = await createSession({
      kind: "pdf",
      title: "Report.pdf",
      rawText: "Revenue grew twelve percent.",
      pages: 3,
    });

    const stored = await store.get(result.sessionId);
    expect(stored?.title).toBe("Report.pdf");
    expect(stored?.text).toBe("Revenue grew twelve percent.");
    expect(stored?.pages).toBe(3);
  });

  it("stamps an expiry one TTL ahead of creation", async () => {
    const result = await createSession({ kind: "pdf", title: "a.pdf", rawText: "text" });

    const stored = await store.get(result.sessionId);
    expect(stored).toBeDefined();
    expect(stored!.expiresAt - stored!.createdAt).toBe(SESSION_TTL_MS);
  });

  it("normalises the text before storing it", async () => {
    const result = await createSession({
      kind: "pdf",
      title: "a.pdf",
      rawText: "messy   text\r\nwith junk",
    });

    expect(result.text).toBe("messy text\nwith junk");
  });

  it("sweeps lapsed sessions as a side effect of ingesting a new one", async () => {
    await store.save({
      id: "stale",
      kind: "pdf",
      title: "old.pdf",
      text: "old",
      truncated: false,
      originalChars: 3,
      usedChars: 3,
      approxTokens: 1,
      createdAt: Date.now() - SESSION_TTL_MS * 2,
      expiresAt: Date.now() - 1,
    });

    await createSession({ kind: "pdf", title: "new.pdf", rawText: "fresh" });

    await expect(store.get("stale")).resolves.toBeUndefined();
  });

  it("still ingests when the sweep fails", async () => {
    const broken = new MemorySessionStore();
    broken.deleteExpired = async () => {
      throw new Error("sweep exploded");
    };
    setSessionStore(broken);

    const result = await createSession({ kind: "pdf", title: "a.pdf", rawText: "text" });

    expect(result.sessionId).toBeTruthy();
    await expect(broken.get(result.sessionId)).resolves.toBeDefined();
  });

  it("uses the configured store rather than a fresh one", async () => {
    expect(getSessionStore()).toBe(store);
  });
});
