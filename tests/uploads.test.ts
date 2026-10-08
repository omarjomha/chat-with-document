// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STAGED_UPLOAD_TTL_MS } from "@/lib/constants";

const blobList = vi.fn();
const blobDel = vi.fn();

vi.mock("@vercel/blob", () => ({
  list: (...args: unknown[]) => blobList(...args),
  del: (...args: unknown[]) => blobDel(...args),
}));

const { deleteStaleUploads, isStagedUploadPath } = await import("@/lib/ingest/uploads");

describe("isStagedUploadPath", () => {
  it.each([
    ["uploads/report-x1y2.pdf", true],
    ["uploads/Scan.PDF", true],
    ["report.pdf", false],
    ["sessions/abc.json", false],
    ["uploads/notes.txt", false],
    ["uploads/../sessions/abc.pdf", false],
  ])("%s -> %s", (pathname, expected) => {
    expect(isStagedUploadPath(pathname)).toBe(expected);
  });
});

describe("deleteStaleUploads", () => {
  const NOW = Date.UTC(2026, 9, 8, 12);

  beforeEach(() => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    blobList.mockReset();
    blobDel.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  const blob = (pathname: string, ageMs: number) => ({
    pathname,
    uploadedAt: new Date(NOW - ageMs).toISOString(),
  });

  it("removes only uploads older than the staging TTL", async () => {
    blobList.mockResolvedValue({
      blobs: [blob("uploads/old.pdf", STAGED_UPLOAD_TTL_MS + 1), blob("uploads/fresh.pdf", 1_000)],
      hasMore: false,
    });

    const removed = await deleteStaleUploads(NOW);

    expect(removed).toBe(1);
    expect(blobList).toHaveBeenCalledWith(expect.objectContaining({ prefix: "uploads/" }));
    expect(blobDel).toHaveBeenCalledWith(["uploads/old.pdf"]);
  });

  it("follows pagination", async () => {
    blobList
      .mockResolvedValueOnce({
        blobs: [blob("uploads/a.pdf", STAGED_UPLOAD_TTL_MS * 2)],
        hasMore: true,
        cursor: "next",
      })
      .mockResolvedValueOnce({
        blobs: [blob("uploads/b.pdf", STAGED_UPLOAD_TTL_MS * 2)],
        hasMore: false,
      });

    await deleteStaleUploads(NOW);

    expect(blobList).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "next" }));
    expect(blobDel).toHaveBeenCalledWith(["uploads/a.pdf", "uploads/b.pdf"]);
  });

  it("does not call delete when nothing is stale", async () => {
    blobList.mockResolvedValue({ blobs: [], hasMore: false });

    expect(await deleteStaleUploads(NOW)).toBe(0);
    expect(blobDel).not.toHaveBeenCalled();
  });

  it("does nothing without Blob credentials", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");

    expect(await deleteStaleUploads(NOW)).toBe(0);
    expect(blobList).not.toHaveBeenCalled();
  });
});
