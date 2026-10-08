// @vitest-environment node
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractPdfText, isMostlyUnreadable, PdfExtractionError } from "@/lib/ingest/pdf";
import { normalizeExtractedText } from "@/lib/ingest/normalize";

import { makePdf } from "./fixtures/makePdf";

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

  it("reports a truncated file, as from an interrupted download, as corrupt", async () => {
    const whole = await loadSpecPdf();

    await expect(extractPdfText(whole.slice(0, whole.length / 2))).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("asks for the password to be removed from an encrypted PDF", async () => {
    await expect(extractPdfText(makePdf(["secret"], { encrypted: true }))).rejects.toMatchObject({
      code: "encrypted",
      message: expect.stringMatching(/password/i),
    });
  });

  it("rejects a PDF where no page has text, naming it as scanned", async () => {
    await expect(extractPdfText(makePdf(["", "", ""]))).rejects.toMatchObject({
      code: "no-text-layer",
      message: expect.stringContaining("3 pages"),
    });
  });

  it("counts pages without text in an otherwise readable PDF instead of hiding them", async () => {
    const result = await extractPdfText(makePdf(["Introduction", "", "Conclusion", ""]));

    expect(result.pages).toBe(4);
    expect(result.pagesWithoutText).toBe(2);
    expect(result.text).toContain("Introduction");
    expect(result.text).toContain("Conclusion");
  });

  it("accepts a very short document rather than mistaking it for a scan", async () => {
    const result = await extractPdfText(makePdf(["Hi"]));

    expect(result.pagesWithoutText).toBe(0);
    expect(result.text.trim()).toBe("Hi");
  });

  it("separates pages with a paragraph break, so truncation can land between them", async () => {
    const { text } = await extractPdfText(makePdf(["Page one.", "Page two."]));

    expect(text).toMatch(/Page one\.\s*\n\n\s*Page two\./);
  });
});

describe("isMostlyUnreadable", () => {
  it("flags text that is mostly unmapped glyphs", () => {
    expect(isMostlyUnreadable(" �� a")).toBe(true);
  });

  it("tolerates a few stray unmapped glyphs in real text", () => {
    expect(isMostlyUnreadable("A normal sentence with one odd glyph  in it.")).toBe(false);
  });

  it("does not flag ordinary text, in any script", () => {
    expect(isMostlyUnreadable("Résumé — 東京 2026")).toBe(false);
  });
});
