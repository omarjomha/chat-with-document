import { describe, expect, it } from "vitest";

import { cleanText, normalizeExtractedText } from "@/lib/ingest/normalize";

describe("cleanText", () => {
  it("normalises CRLF and CR line endings", () => {
    expect(cleanText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("collapses horizontal whitespace runs from column gutters", () => {
    expect(cleanText("word     another\tword")).toBe("word another word");
  });

  it("collapses non-breaking spaces, which PDF extraction emits freely", () => {
    expect(cleanText("a  b")).toBe("a b");
  });

  it("strips control characters but keeps newlines and tabs intact", () => {
    expect(cleanText("a\u0000\u0007b\nc")).toBe("ab\nc");
  });

  it("drops glyphs that extraction could not map to a character", () => {
    expect(cleanText("caf� and icons")).toBe("caf and icons");
  });

  it("rejoins words split by a soft hyphen at a line break", () => {
    expect(cleanText("exam­\nple")).toBe("example");
  });

  it("collapses runs of blank lines to a single paragraph break", () => {
    expect(cleanText("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("trims trailing spaces before newlines", () => {
    expect(cleanText("a   \nb")).toBe("a\nb");
  });
});

describe("normalizeExtractedText", () => {
  it("reports no truncation when the text fits", () => {
    const result = normalizeExtractedText("short text", 100);

    expect(result.truncated).toBe(false);
    expect(result.text).toBe("short text");
    expect(result.originalChars).toBe(10);
    expect(result.usedChars).toBe(10);
  });

  it("truncates when over the limit and flags it", () => {
    const result = normalizeExtractedText("x".repeat(500), 100);

    expect(result.truncated).toBe(true);
    expect(result.usedChars).toBeLessThanOrEqual(100);
    expect(result.originalChars).toBe(500);
  });

  it("reports the pre-truncation length so the UI can show what was dropped", () => {
    const result = normalizeExtractedText("y".repeat(1000), 50);

    expect(result.originalChars).toBe(1000);
    expect(result.usedChars).toBeLessThanOrEqual(50);
  });

  it("prefers a paragraph boundary when truncating", () => {
    const text = `${"a".repeat(90)}\n\n${"b".repeat(50)}`;
    const result = normalizeExtractedText(text, 100);

    expect(result.text).toBe("a".repeat(90));
  });

  it("falls back to a sentence boundary", () => {
    const text = `${"a".repeat(85)}. ${"b".repeat(50)}`;
    const result = normalizeExtractedText(text, 100);

    expect(result.text.endsWith(".")).toBe(true);
    expect(result.text).toBe(`${"a".repeat(85)}.`);
  });

  it("never splits a word when a space boundary is available", () => {
    const text = `${"a".repeat(95)} ${"b".repeat(50)}`;
    const result = normalizeExtractedText(text, 100);

    expect(result.text).toBe("a".repeat(95));
  });

  it("hard-cuts text with no boundaries rather than returning nothing", () => {
    const result = normalizeExtractedText("あ".repeat(500), 100);

    expect(result.text.length).toBe(100);
    expect(result.truncated).toBe(true);
  });

  it("estimates tokens from the kept text, not the original", () => {
    const result = normalizeExtractedText("z".repeat(400), 100);

    expect(result.approxTokens).toBe(25);
  });
});
