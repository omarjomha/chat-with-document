// @vitest-environment node
import { describe, expect, it } from "vitest";

import { clientAddress, guardRequest, isCrossOrigin } from "@/lib/security/guard";
import { RateLimiter } from "@/lib/security/rateLimit";

function request(headers: Record<string, string>): Request {
  return new Request("https://app.example.test/api/realtime/token", { method: "POST", headers });
}

describe("RateLimiter", () => {
  it("allows requests up to the limit and refuses the next", () => {
    const limiter = new RateLimiter(2, 60_000, () => 0);

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
  });

  it("counts each client separately", () => {
    const limiter = new RateLimiter(1, 60_000, () => 0);

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
  });

  it("lets a client back in once its earliest request leaves the window", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 60_000, () => now);

    limiter.check("a");
    now = 59_999;
    expect(limiter.check("a").allowed).toBe(false);
    now = 60_001;
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("does not count refusals, so retrying does not extend the lockout", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 60_000, () => now);

    limiter.check("a");
    for (now = 1_000; now < 60_000; now += 1_000) limiter.check("a");
    now = 60_001;
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("reports how long until the next request would be allowed", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 60_000, () => now);

    limiter.check("a");
    now = 15_000;
    expect(limiter.check("a").retryAfterSeconds).toBe(45);
  });

  it("forgets every client on reset", () => {
    const limiter = new RateLimiter(1, 60_000, () => 0);

    limiter.check("a");
    limiter.reset();
    expect(limiter.check("a").allowed).toBe(true);
  });
});

describe("isCrossOrigin", () => {
  it("accepts a request from the app's own origin", () => {
    expect(
      isCrossOrigin(request({ origin: "https://app.example.test", host: "app.example.test" })),
    ).toBe(false);
  });

  it("refuses a request from another site", () => {
    expect(
      isCrossOrigin(request({ origin: "https://evil.example", host: "app.example.test" })),
    ).toBe(true);
  });

  it("compares ports, since a different port is a different origin", () => {
    expect(
      isCrossOrigin(request({ origin: "https://localhost:4000", host: "localhost:3000" })),
    ).toBe(true);
  });

  it("prefers the forwarded host, which is what the browser actually addressed", () => {
    expect(
      isCrossOrigin(
        request({
          origin: "https://app.example.test",
          host: "internal:8080",
          "x-forwarded-host": "app.example.test",
        }),
      ),
    ).toBe(false);
  });

  it("refuses the opaque null origin from sandboxed frames", () => {
    expect(isCrossOrigin(request({ origin: "null", host: "app.example.test" }))).toBe(true);
  });

  it("lets a request with no Origin through, leaving it to the rate limit", () => {
    expect(isCrossOrigin(request({ host: "app.example.test" }))).toBe(false);
  });
});

describe("clientAddress", () => {
  it("uses x-real-ip when present", () => {
    expect(clientAddress(request({ "x-real-ip": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("falls back to the first x-forwarded-for hop", () => {
    expect(clientAddress(request({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe(
      "203.0.113.7",
    );
  });

  it("groups clients with no address under one key rather than exempting them", () => {
    expect(clientAddress(request({}))).toBe("unknown");
  });
});

describe("guardRequest", () => {
  it("refuses a cross-origin request with 403", async () => {
    const response = guardRequest(request({ origin: "https://evil.example" }));

    expect(response?.status).toBe(403);
  });

  it("checks origin before spending the caller's allowance", () => {
    const limiter = new RateLimiter(1, 60_000, () => 0);
    guardRequest(request({ origin: "https://evil.example", "x-real-ip": "1.1.1.1" }), limiter);

    expect(limiter.check("1.1.1.1").allowed).toBe(true);
  });

  it("refuses with 429, Retry-After, and a readable wait once over the limit", async () => {
    const limiter = new RateLimiter(1, 120_000, () => 0);
    const req = () => request({ "x-real-ip": "1.1.1.1" });

    expect(guardRequest(req(), limiter)).toBeUndefined();
    const response = guardRequest(req(), limiter);

    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBe("120");
    await expect(response?.json()).resolves.toEqual({
      error: "Too many requests. Try again in 2 minutes.",
    });
  });

  it("passes a same-origin request under the limit", () => {
    const limiter = new RateLimiter(5, 60_000);

    expect(
      guardRequest(
        request({ origin: "https://app.example.test", host: "app.example.test" }),
        limiter,
      ),
    ).toBeUndefined();
  });
});
