// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_CONTEXT_CHARS } from "@/lib/constants";
import { MemoryTranscriptCache, setTranscriptCache } from "@/lib/ingest/transcriptCache";
import { buildInstructions } from "@/lib/prompt";
import { setSessionStore } from "@/lib/store";
import { MemorySessionStore } from "@/lib/store/memory";

const { POST } = await import("@/app/api/ingest/youtube/route");

/**
 * End-to-end coverage of the YouTube path.
 *
 * Everything here is the real implementation -- the route handler, client
 * selection, caption parsing, normalisation, the session store and the prompt
 * builder. Only `fetch` is stubbed, with response bodies copied in shape from
 * real YouTube responses captured while building this.
 *
 * It exists because the unit tests each verify one link in the chain, and the
 * chain itself was never exercised: a live run was blocked by YouTube flagging
 * the development machine's IP, so correctness of the whole path rested on
 * assumption. This replaces that assumption.
 */

const CAPTION_URL = "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&lang=en&fmt=srv3";

/** Shaped exactly like a real Android player response, trimmed to what we read. */
function playerResponse(title: string, tracks?: unknown[]): Response {
  return new Response(
    JSON.stringify({
      playabilityStatus: { status: "OK" },
      videoDetails: { title, videoId: "jNQXAC9IVRw", lengthSeconds: "19" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: tracks ?? [
            {
              baseUrl: CAPTION_URL,
              name: { runs: [{ text: "English" }] },
              languageCode: "en",
              isTranslatable: true,
            },
          ],
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** A human-written track, in the real `timedtext format="3"` shape. */
const WRITTEN_XML = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3">
<body>
<p t="1200" d="2160">All right, so here we are, in front of the elephants</p>
<p t="3360" d="4080">the cool thing about these guys is that they have really,
really, really long trunks</p>
<p t="7440" d="2000">and that&#39;s cool</p>
<p t="9440" d="2000">and that&#39;s pretty much all there is to say</p>
</body>
</timedtext>`;

/**
 * An auto-generated track, in the real shape: a stray <w>, per-word <s>
 * elements, and empty a="1" paragraphs for the rolling on-screen effect.
 */
const AUTO_XML = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3">
<head><ws id="0"/><ws id="1" mh="2" ju="0" sd="3"/><wp id="0"/><wp id="1" ap="6"/></head>
<body>
<w t="0" id="1" wp="1" ws="1"/>
<p t="0" d="2510" w="1">[Music]</p>
<p t="4390" w="1" a="1">
</p>
<p t="4400" d="4159" w="1"><s ac="0">This</s><s t="399" ac="0"> is</s><s t="560" ac="0"> a</s><s t="800" ac="0"> three.</s></p>
<p t="6869" d="1690" w="1" a="1">
</p>
<p t="6879" d="4561" w="1"><s ac="0">It</s><s t="241" ac="0"> is</s><s t="561" ac="0"> sloppily</s><s t="801" ac="0"> written.</s></p>
</body>
</timedtext>`;

function xml(body: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/xml" } });
}

function request(url: string): Request {
  return new Request("https://example.test/api/ingest/youtube", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

describe("YouTube ingestion, end to end", () => {
  const fetchMock = vi.fn();
  let store: MemorySessionStore;
  let cache: MemoryTranscriptCache;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    store = new MemorySessionStore();
    cache = new MemoryTranscriptCache();
    setSessionStore(store);
    setTranscriptCache(cache);
    delete process.env.YOUTUBE_PROXY_URL;
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setSessionStore(undefined);
    setTranscriptCache(undefined);
  });

  it("turns a pasted link into a stored, promptable session", async () => {
    fetchMock
      .mockResolvedValueOnce(playerResponse("Me at the zoo"))
      .mockResolvedValueOnce(xml(WRITTEN_XML));

    const response = await POST(request("https://www.youtube.com/watch?v=jNQXAC9IVRw"));
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      sessionId: string;
      kind: string;
      title: string;
      text: string;
      truncated: boolean;
      usedChars: number;
      approxTokens: number;
    };

    expect(payload.kind).toBe("youtube");
    expect(payload.title).toBe("Me at the zoo");
    expect(payload.truncated).toBe(false);
    expect(payload.usedChars).toBeGreaterThan(100);
    expect(payload.approxTokens).toBeGreaterThan(0);

    // The transcript survives intact, with the escaped apostrophe decoded and
    // the hard-wrapped caption line rejoined.
    expect(payload.text).toContain("in front of the elephants");
    expect(payload.text).toContain("that's cool");
    expect(payload.text).toContain("really, really, really long trunks");
    // No markup may survive into the text handed to the model.
    expect(payload.text).not.toMatch(/[<>]/);
    expect(payload.text).not.toContain("&#39;");

    // The session is retrievable, which is what the token route depends on.
    const stored = await store.get(payload.sessionId);
    expect(stored).toBeDefined();
    expect(stored!.kind).toBe("youtube");
    expect(stored!.title).toBe("Me at the zoo");
    expect(stored!.text).toBe(payload.text);

    // And it reaches the model as grounded instructions.
    const instructions = buildInstructions({
      title: stored!.title,
      kind: stored!.kind,
      text: stored!.text,
      truncated: stored!.truncated,
    });
    expect(instructions).toContain("video transcript");
    expect(instructions).toContain("Me at the zoo");
    expect(instructions).toContain("in front of the elephants");
  });

  it("reassembles an auto-generated transcript without duplication or run-together words", async () => {
    fetchMock
      .mockResolvedValueOnce(playerResponse("But what is a neural network?"))
      .mockResolvedValueOnce(xml(AUTO_XML));

    const response = await POST(request("https://youtu.be/jNQXAC9IVRw"));
    expect(response.status).toBe(200);

    const { text } = (await response.json()) as { text: string };

    expect(text).toContain("This is a three.");
    expect(text).toContain("It is sloppily written.");
    expect(text).toContain("[Music]");
    // The rollup placeholders must not become blank lines.
    expect(text).not.toMatch(/\n\s*\n/);
    // Per-word segments must not be concatenated without their spaces.
    expect(text).not.toMatch(/Thisisa|issloppily/);
  });

  it("serves a repeat request from cache without touching YouTube", async () => {
    fetchMock
      .mockResolvedValueOnce(playerResponse("Me at the zoo"))
      .mockResolvedValueOnce(xml(WRITTEN_XML));

    const first = await POST(request("https://youtu.be/jNQXAC9IVRw"));
    const firstPayload = (await first.json()) as { sessionId: string; text: string };
    const callsAfterFirst = fetchMock.mock.calls.length;

    // A different URL shape for the same video must hit the same cache entry.
    const second = await POST(request("https://www.youtube.com/shorts/jNQXAC9IVRw"));
    const secondPayload = (await second.json()) as { sessionId: string; text: string };

    expect(second.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    expect(secondPayload.text).toBe(firstPayload.text);
    // A fresh session each time, so replacing a document cannot leak the old one.
    expect(secondPayload.sessionId).not.toBe(firstPayload.sessionId);
  });

  it("truncates an over-long transcript and says so", async () => {
    const line = "This is a sentence of caption text that repeats to exceed the context budget.";
    const cues = Array.from(
      { length: Math.ceil((MAX_CONTEXT_CHARS * 1.2) / line.length) },
      (_unused, index) => `<p t="${index * 1000}" d="1000">${index} ${line}</p>`,
    ).join("\n");

    fetchMock
      .mockResolvedValueOnce(playerResponse("A very long lecture"))
      .mockResolvedValueOnce(xml(`<timedtext format="3"><body>${cues}</body></timedtext>`));

    const response = await POST(request("https://youtu.be/jNQXAC9IVRw"));
    const payload = (await response.json()) as {
      truncated: boolean;
      usedChars: number;
      originalChars: number;
      text: string;
    };

    expect(response.status).toBe(200);
    expect(payload.truncated).toBe(true);
    expect(payload.usedChars).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(payload.originalChars).toBeGreaterThan(MAX_CONTEXT_CHARS);
    expect(payload.text.length).toBe(payload.usedChars);

    // The model must be told the text is partial, or it will answer as though
    // the missing sections simply contain nothing.
    const instructions = buildInstructions({
      title: "A very long lecture",
      kind: "youtube",
      text: payload.text,
      truncated: payload.truncated,
    });
    expect(instructions).toMatch(/truncated/i);
  });

  it("uses the second client when the first is challenged, transparently to the caller", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            playabilityStatus: {
              status: "LOGIN_REQUIRED",
              reason: "Sign in to confirm you're not a bot",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(playerResponse("Me at the zoo"))
      .mockResolvedValueOnce(xml(WRITTEN_XML));

    const response = await POST(request("https://youtu.be/jNQXAC9IVRw"));

    expect(response.status).toBe(200);
    const { text } = (await response.json()) as { text: string };
    expect(text).toContain("in front of the elephants");
  });

  it("stores nothing when YouTube serves a block page instead of captions", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(playerResponse("Me at the zoo")).mockResolvedValueOnce(
      new Response(
        `<!DOCTYPE html><html><body><p>... but your computer or network may be
           sending automated queries.</p></body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } },
      ),
    );

    const response = await POST(request("https://youtu.be/jNQXAC9IVRw"));
    const payload = (await response.json()) as { error: string; code: string };

    expect(response.status).toBe(502);
    expect(payload.code).toBe("blocked");
    // Google's wording must never be presented to the user as a transcript.
    expect(payload.error).not.toMatch(/automated queries/);
    // And nothing may be cached or stored from a refusal.
    await expect(cache.get("jNQXAC9IVRw")).resolves.toBeUndefined();
  });
});
