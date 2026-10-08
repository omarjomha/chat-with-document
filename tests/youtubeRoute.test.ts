// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { YouTubeIngestError } from "@/lib/ingest/youtube";
import { resetRateLimiters } from "@/lib/security/rateLimit";

const loadYouTubeTranscript = vi.fn();
const createSession = vi.fn();

// Only the network call is replaced; the error type stays real so the route's
// `instanceof` check is exercised rather than stubbed around.
vi.mock("@/lib/ingest/youtube", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ingest/youtube")>()),
  loadYouTubeTranscript: (...args: unknown[]) => loadYouTubeTranscript(...args),
}));

vi.mock("@/lib/ingest/session", () => ({
  createSession: (...args: unknown[]) => createSession(...args),
}));

const { POST } = await import("@/app/api/ingest/youtube/route");

function post(body: unknown): Request {
  return new Request("https://example.test/api/ingest/youtube", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ingest/youtube", () => {
  beforeEach(() => {
    loadYouTubeTranscript.mockReset();
    createSession.mockReset();
    resetRateLimiters();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ingests a transcript and returns the session", async () => {
    loadYouTubeTranscript.mockResolvedValue({ title: "A talk", text: "line one" });
    createSession.mockResolvedValue({ sessionId: "s1", kind: "youtube", title: "A talk" });

    const response = await POST(post({ url: "https://youtu.be/dQw4w9WgXcQ" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ sessionId: "s1", kind: "youtube" });
    expect(loadYouTubeTranscript).toHaveBeenCalledWith("dQw4w9WgXcQ");
    expect(createSession).toHaveBeenCalledWith({
      kind: "youtube",
      title: "A talk",
      rawText: "line one",
    });
  });

  it("never caches an ingest response", async () => {
    loadYouTubeTranscript.mockResolvedValue({ title: "t", text: "x" });
    createSession.mockResolvedValue({ sessionId: "s1" });

    const response = await POST(post({ url: "https://youtu.be/dQw4w9WgXcQ" }));

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([
    ["a missing body", {}],
    ["a non-string url", { url: 42 }],
    ["an empty url", { url: "" }],
  ])("rejects %s with 400", async (_label, body) => {
    const response = await POST(post(body));

    expect(response.status).toBe(400);
    expect(loadYouTubeTranscript).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with 400", async () => {
    const response = await POST(
      new Request("https://example.test/api/ingest/youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects a non-YouTube link before reaching the network", async () => {
    const response = await POST(post({ url: "https://vimeo.com/12345" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid-url" });
    expect(loadYouTubeTranscript).not.toHaveBeenCalled();
  });

  it.each([
    ["not-found", 404],
    ["unavailable", 403],
    ["no-captions", 422],
    ["empty", 422],
    ["blocked", 502],
    ["unknown", 500],
  ] as const)("returns %s as HTTP %d with its own message", async (code, status) => {
    loadYouTubeTranscript.mockRejectedValue(new YouTubeIngestError(code, `message for ${code}`));

    const response = await POST(post({ url: "https://youtu.be/dQw4w9WgXcQ" }));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: `message for ${code}`, code });
  });

  it("hides the detail of an unexpected failure behind a 500", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    loadYouTubeTranscript.mockRejectedValue(new Error("DB password is hunter2"));

    const response = await POST(post({ url: "https://youtu.be/dQw4w9WgXcQ" }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "That video could not be processed." });
    expect(logged).toHaveBeenCalled();
  });
});
