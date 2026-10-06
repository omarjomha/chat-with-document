// @vitest-environment node
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractPdfText, PdfExtractionError } from "@/lib/ingest/pdf";
import { normalizeExtractedText } from "@/lib/ingest/normalize";

/**
 * Integration test against a real PDF committed to the repo (the assessment
 * spec itself), so extraction is exercised end to end rather than mocked.
 *
 * Runs in the node environment: pdf.js needs real Node APIs, and jsdom does not
 * give import.meta.url a file:// scheme.
 */
const SPEC_PDF = path.resolve(process.cwd(), "docs", "Talk to a Document.pdf");

async function loadSpecPdf(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(SPEC_PDF));
}

describe("extractPdfText", () => {
  it("extracts text and page count from a real PDF", async () => {
    const result = await extractPdfText(await loadSpecPdf());

    expect(result.pages).toBe(5);
    expect(result.text.length).toBeGreaterThan(1000);
  });

  it("recovers content that is actually in the document", async () => {
    const { text } = await extractPdfText(await loadSpecPdf());
    const normalized = normalizeExtractedText(text).text;

    expect(normalized).toContain("Realtime API");
    expect(normalized).toContain("YouTube");
    expect(normalized).toMatch(/25\s*MB/);
  });

  it("produces text that survives normalisation without collapsing to nothing", async () => {
    const { text } = await extractPdfText(await loadSpecPdf());
    const normalized = normalizeExtractedText(text);

    expect(normalized.usedChars).toBeGreaterThan(1000);
    expect(normalized.truncated).toBe(false);
    // Normalisation only ever removes characters. pdf.js already emits fairly
    // clean text for this file, so equality here is expected, not a failure.
    expect(normalized.originalChars).toBeLessThanOrEqual(text.length);
  });

  it("rejects an empty file with a distinct code", async () => {
    await expect(extractPdfText(new Uint8Array(0))).rejects.toMatchObject({
      name: "PdfExtractionError",
      code: "empty",
    });
  });

  it("rejects a non-PDF payload rather than returning garbage", async () => {
    const notAPdf = new TextEncoder().encode("this is plainly not a pdf file");

    await expect(extractPdfText(notAPdf)).rejects.toBeInstanceOf(PdfExtractionError);
  });
});
