// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TOKEN_RATE_LIMIT } from "@/lib/constants";
import { RealtimeMintError } from "@/lib/realtime/mintClientSecret";
import { resetRateLimiters } from "@/lib/security/rateLimit";
import { MemorySessionStore, setSessionStore } from "@/lib/store";
import type { StoredSession } from "@/lib/store";

const mintClientSecret = vi.fn();

// Only the upstream call is replaced; the error type stays real so the route's
// `instanceof` check is exercised rather than stubbed around.
vi.mock("@/lib/realtime/mintClientSecret", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/realtime/mintClientSecret")>()),
  mintClientSecret: (...args: unknown[]) => mintClientSecret(...args),
}));

const { POST } = await import("@/app/api/realtime/token/route");

const SESSION_ID = "6f1c1d1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";

function post(body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://app.example.test/api/realtime/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function storedSession(overrides: Partial<StoredSession> = {}): StoredSession {
  const now = Date.now();
  return {
    id: SESSION_ID,
    kind: "pdf",
    title: "report.pdf",
    text: "The answer is forty-two.",
    truncated: false,
    originalChars: 24,
    usedChars: 24,
    approxTokens: 6,
    pages: 1,
    createdAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  };
}

describe("POST /api/realtime/token", () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    mintClientSecret.mockReset();
    mintClientSecret.mockResolvedValue({ value: "ek_test", expiresAt: 123, model: "m" });
    store = new MemorySessionStore();
    setSessionStore(store);
    resetRateLimiters();
  });

  afterEach(() => {
    setSessionStore(undefined);
    vi.restoreAllMocks();
  });

  it("returns only the ephemeral secret, never cached", async () => {
    const response = await POST(post({}));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      value: "ek_test",
      expiresAt: 123,
      model: "m",
    });
  });

  it("mints an ungrounded session when no document has been loaded", async () => {
    await POST(post({}));

    expect(mintClientSecret).toHaveBeenCalledWith(undefined, expect.any(String));
  });

  it("accepts an empty body", async () => {
    const response = await POST(post());

    expect(response.status).toBe(200);
  });

  it("injects the stored document as context", async () => {
    await store.save(storedSession());

    await POST(post({ sessionId: SESSION_ID }));

    expect(mintClientSecret).toHaveBeenCalledWith(
      { title: "report.pdf", kind: "pdf", text: "The answer is forty-two.", truncated: false },
      expect.any(String),
    );
  });

  it("refuses an expired session instead of starting an ungrounded one", async () => {
    await store.save(storedSession({ expiresAt: Date.now() - 1 }));

    const response = await POST(post({ sessionId: SESSION_ID }));

    expect(response.status).toBe(404);
    expect(mintClientSecret).not.toHaveBeenCalled();
  });

  it("rejects a session id that is not a UUID", async () => {
    const response = await POST(post({ sessionId: "../../etc/passwd" }));

    expect(response.status).toBe(400);
    expect(mintClientSecret).not.toHaveBeenCalled();
  });

  it("passes an upstream failure through with its own status", async () => {
    mintClientSecret.mockRejectedValue(new RealtimeMintError("OpenAI rejected the API key.", 500));

    const response = await POST(post({}));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "OpenAI rejected the API key." });
  });

  it("hides configuration detail behind a generic 500", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mintClientSecret.mockRejectedValue(new Error("Invalid server environment -> OPENAI_API_KEY"));

    const response = await POST(post({}));

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).not.toContain("OPENAI_API_KEY");
    expect(logged).toHaveBeenCalled();
  });

  it("refuses another site's page before minting anything", async () => {
    const response = await POST(post({}, { origin: "https://evil.example" }));

    expect(response.status).toBe(403);
    expect(mintClientSecret).not.toHaveBeenCalled();
  });

  it("serves the app's own page", async () => {
    const response = await POST(post({}, { origin: "https://app.example.test" }));

    expect(response.status).toBe(200);
  });

  it("stops minting for one client once it exceeds its allowance", async () => {
    const from = { "x-real-ip": "203.0.113.9" };
    for (let i = 0; i < TOKEN_RATE_LIMIT.limit; i += 1) {
      expect((await POST(post({}, from))).status).toBe(200);
    }

    const refused = await POST(post({}, from));

    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBeTruthy();
    expect(mintClientSecret).toHaveBeenCalledTimes(TOKEN_RATE_LIMIT.limit);
    // Someone else is unaffected.
    expect((await POST(post({}, { "x-real-ip": "203.0.113.10" }))).status).toBe(200);
  });
});
