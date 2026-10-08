// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PdfExtractionError } from "@/lib/ingest/pdf";

const blobGet = vi.fn();
const blobDel = vi.fn();
const extractPdfText = vi.fn();
const createSession = vi.fn();

vi.mock("@vercel/blob", () => ({
  get: (...args: unknown[]) => blobGet(...args),
  del: (...args: unknown[]) => blobDel(...args),
}));

// Only extraction is replaced; the error type stays real so the route's
// `instanceof` check is exercised rather than stubbed around.
vi.mock("@/lib/ingest/pdf", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ingest/pdf")>()),
  extractPdfText: (...args: unknown[]) => extractPdfText(...args),
}));

vi.mock("@/lib/ingest/session", () => ({
  createSession: (...args: unknown[]) => createSession(...args),
}));

const { POST } = await import("@/app/api/ingest/pdf/route");

const PATHNAME = "uploads/report-abc123.pdf";

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://app.example.test/api/ingest/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function stagedBlob(size = 4) {
  return {
    statusCode: 200,
    blob: { size },
    stream: new Response(new Uint8Array(size)).body,
  };
}

describe("POST /api/ingest/pdf", () => {
  beforeEach(() => {
    blobGet.mockReset().mockResolvedValue(stagedBlob());
    blobDel.mockReset().mockResolvedValue(undefined);
    extractPdfText.mockReset().mockResolvedValue({ text: "body", pages: 3, pagesWithoutText: 1 });
    createSession.mockReset().mockResolvedValue({ sessionId: "s1", kind: "pdf" });
  });

  afterEach(() => vi.restoreAllMocks());

  it("extracts, stores, and deletes the uploaded file", async () => {
    const response = await POST(post({ pathname: PATHNAME, filename: "report.pdf" }));

    expect(response.status).toBe(200);
    expect(createSession).toHaveBeenCalledWith({
      kind: "pdf",
      title: "report.pdf",
      rawText: "body",
      pages: 3,
      pagesWithoutText: 1,
    });
    expect(blobDel).toHaveBeenCalledWith(PATHNAME);
  });

  it.each([
    ["encrypted", "This PDF is password-protected."],
    ["corrupt", "This file could not be read as a PDF."],
    ["no-text-layer", "No selectable text found."],
    ["unreadable", "The text in this PDF can't be read back."],
  ] as const)(
    "returns a %s PDF as 422 with its message, and still deletes it",
    async (code, msg) => {
      extractPdfText.mockRejectedValue(new PdfExtractionError(code, msg));

      const response = await POST(post({ pathname: PATHNAME, filename: "x.pdf" }));

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toEqual({ error: msg, code });
      expect(blobDel).toHaveBeenCalledWith(PATHNAME);
    },
  );

  it("refuses an oversized blob before parsing it", async () => {
    blobGet.mockResolvedValue(stagedBlob(26 * 1024 * 1024));

    const response = await POST(post({ pathname: PATHNAME, filename: "big.pdf" }));

    expect(response.status).toBe(413);
    expect(extractPdfText).not.toHaveBeenCalled();
    expect(blobDel).toHaveBeenCalledWith(PATHNAME);
  });

  it("reports a missing upload as 404", async () => {
    blobGet.mockResolvedValue(null);

    const response = await POST(post({ pathname: PATHNAME, filename: "x.pdf" }));

    expect(response.status).toBe(404);
  });

  it("hides an unexpected failure behind a generic 500", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    extractPdfText.mockRejectedValue(new Error("worker crashed at 0xdeadbeef"));

    const response = await POST(post({ pathname: PATHNAME, filename: "x.pdf" }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "The PDF could not be processed." });
    expect(logged).toHaveBeenCalled();
  });

  it("does not let a failed cleanup mask the result", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    blobDel.mockRejectedValue(new Error("blob store unavailable"));

    const response = await POST(post({ pathname: PATHNAME, filename: "x.pdf" }));

    expect(response.status).toBe(200);
  });

  it("rejects a malformed body", async () => {
    const response = await POST(post({ pathname: "" }));

    expect(response.status).toBe(400);
    expect(blobGet).not.toHaveBeenCalled();
  });

  it.each([
    ["a stored session", "sessions/6f1c1d1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f.json"],
    ["a cached transcript", "transcripts/dQw4w9WgXcQ.json"],
    ["a path that climbs out of the folder", "uploads/../transcripts/x.pdf"],
  ])("will not read or delete %s", async (_label, pathname) => {
    const response = await POST(post({ pathname, filename: "x.pdf" }));

    expect(response.status).toBe(400);
    expect(blobGet).not.toHaveBeenCalled();
    expect(blobDel).not.toHaveBeenCalled();
  });

  it("refuses another site's page", async () => {
    const response = await POST(
      post({ pathname: PATHNAME, filename: "x.pdf" }, { origin: "https://evil.example" }),
    );

    expect(response.status).toBe(403);
    expect(blobGet).not.toHaveBeenCalled();
  });
});
