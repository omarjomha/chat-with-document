// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TRANSCRIPT_CACHE_TTL_MS } from "@/lib/constants";
import { resetServerEnvCache } from "@/lib/env";
import {
  MemoryTranscriptCache,
  setTranscriptCache,
  type TranscriptCache,
} from "@/lib/ingest/transcriptCache";
import { loadYouTubeTranscript } from "@/lib/ingest/youtube";

const CAPTION_URL = "https://www.youtube.com/api/timedtext?v=abc&lang=en";
const CAPTION_XML = `<timedtext format="3"><body><p t="0">hello world</p></body></timedtext>`;

function playerResponse(title = "A talk"): Response {
  return new Response(
    JSON.stringify({
      playabilityStatus: { status: "OK" },
      videoDetails: { title },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: CAPTION_URL, languageCode: "en" }],
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("MemoryTranscriptCache", () => {
  let cache: MemoryTranscriptCache;

  beforeEach(() => {
    cache = new MemoryTranscriptCache();
  });

  it("returns nothing for a video it has never seen", async () => {
    await expect(cache.get("abcdefghijk")).resolves.toBeUndefined();
  });

  it("round-trips a transcript", async () => {
    await cache.put({ videoId: "abcdefghijk", title: "A talk", text: "hello" });

    const entry = await cache.get("abcdefghijk");
    expect(entry).toMatchObject({ videoId: "abcdefghijk", title: "A talk", text: "hello" });
  });

  it("stamps an expiry one TTL ahead of caching", async () => {
    await cache.put({ videoId: "abcdefghijk", title: "t", text: "x" });

    const entry = await cache.get("abcdefghijk");
    expect(entry!.expiresAt - entry!.cachedAt).toBe(TRANSCRIPT_CACHE_TTL_MS);
  });

  it("keys entries separately per video", async () => {
    await cache.put({ videoId: "aaaaaaaaaaa", title: "A", text: "first" });
    await cache.put({ videoId: "bbbbbbbbbbb", title: "B", text: "second" });

    expect((await cache.get("aaaaaaaaaaa"))!.text).toBe("first");
    expect((await cache.get("bbbbbbbbbbb"))!.text).toBe("second");
  });

  it("overwrites a re-cached video rather than duplicating it", async () => {
    await cache.put({ videoId: "abcdefghijk", title: "old", text: "old" });
    await cache.put({ videoId: "abcdefghijk", title: "new", text: "new" });

    expect((await cache.get("abcdefghijk"))!.text).toBe("new");
    await expect(cache.deleteExpired()).resolves.toBe(0);
  });

  it("refuses a lapsed entry", async () => {
    vi.useFakeTimers();
    try {
      await cache.put({ videoId: "abcdefghijk", title: "t", text: "x" });
      vi.advanceTimersByTime(TRANSCRIPT_CACHE_TTL_MS + 1);

      await expect(cache.get("abcdefghijk")).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweeps only the lapsed entries", async () => {
    vi.useFakeTimers();
    try {
      await cache.put({ videoId: "aaaaaaaaaaa", title: "old", text: "old" });
      vi.advanceTimersByTime(TRANSCRIPT_CACHE_TTL_MS + 1);
      await cache.put({ videoId: "bbbbbbbbbbb", title: "fresh", text: "fresh" });

      await expect(cache.deleteExpired()).resolves.toBe(1);
      await expect(cache.get("bbbbbbbbbbb")).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("loadYouTubeTranscript", () => {
  const fetchMock = vi.fn();
  let cache: MemoryTranscriptCache;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    cache = new MemoryTranscriptCache();
    setTranscriptCache(cache);
    process.env.OPENAI_API_KEY = "sk-test";
    delete process.env.YOUTUBE_PROXY_URL;
    resetServerEnvCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setTranscriptCache(undefined);
    resetServerEnvCache();
  });

  it("fetches and caches on a miss", async () => {
    fetchMock
      .mockResolvedValueOnce(playerResponse())
      .mockResolvedValueOnce(new Response(CAPTION_XML));

    await expect(loadYouTubeTranscript("abcdefghijk")).resolves.toEqual({
      title: "A talk",
      text: "hello world",
    });

    await expect(cache.get("abcdefghijk")).resolves.toMatchObject({ text: "hello world" });
  });

  it("serves the second request from cache without touching YouTube", async () => {
    fetchMock
      .mockResolvedValueOnce(playerResponse())
      .mockResolvedValueOnce(new Response(CAPTION_XML));

    await loadYouTubeTranscript("abcdefghijk");
    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = await loadYouTubeTranscript("abcdefghijk");

    expect(second).toEqual({ title: "A talk", text: "hello world" });
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("does not cache a failure, so a block cannot become permanent", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Sorry...", { status: 429 }));

    await expect(loadYouTubeTranscript("abcdefghijk")).rejects.toThrow();
    await expect(cache.get("abcdefghijk")).resolves.toBeUndefined();
  });

  it("retries YouTube after an earlier failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Sorry...", { status: 429 }));
    await expect(loadYouTubeTranscript("abcdefghijk")).rejects.toThrow();

    fetchMock
      .mockResolvedValueOnce(playerResponse())
      .mockResolvedValueOnce(new Response(CAPTION_XML));
    await expect(loadYouTubeTranscript("abcdefghijk")).resolves.toMatchObject({
      text: "hello world",
    });
  });

  it("falls through to a live fetch when the cache read throws", async () => {
    const broken: TranscriptCache = {
      get: async () => {
        throw new Error("cache unreachable");
      },
      put: async () => {},
      deleteExpired: async () => 0,
    };
    setTranscriptCache(broken);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    fetchMock
      .mockResolvedValueOnce(playerResponse())
      .mockResolvedValueOnce(new Response(CAPTION_XML));

    await expect(loadYouTubeTranscript("abcdefghijk")).resolves.toMatchObject({
      text: "hello world",
    });
  });

  it("still returns the transcript when the cache write throws", async () => {
    const broken: TranscriptCache = {
      get: async () => undefined,
      put: async () => {
        throw new Error("cache read-only");
      },
      deleteExpired: async () => 0,
    };
    setTranscriptCache(broken);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    fetchMock
      .mockResolvedValueOnce(playerResponse())
      .mockResolvedValueOnce(new Response(CAPTION_XML));

    await expect(loadYouTubeTranscript("abcdefghijk")).resolves.toMatchObject({
      text: "hello world",
    });
  });

  it("keeps different videos independent", async () => {
    fetchMock
      .mockResolvedValueOnce(playerResponse("First"))
      .mockResolvedValueOnce(new Response(CAPTION_XML))
      .mockResolvedValueOnce(playerResponse("Second"))
      .mockResolvedValueOnce(
        new Response(`<timedtext format="3"><body><p t="0">other words</p></body></timedtext>`),
      );

    const first = await loadYouTubeTranscript("aaaaaaaaaaa");
    const second = await loadYouTubeTranscript("bbbbbbbbbbb");

    expect(first.title).toBe("First");
    expect(second.title).toBe("Second");
    expect(second.text).toBe("other words");
  });
});
