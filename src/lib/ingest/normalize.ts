import { APPROX_CHARS_PER_TOKEN, MAX_CONTEXT_CHARS } from "@/lib/constants";

export interface NormalizedText {
  /** Cleaned text, truncated to MAX_CONTEXT_CHARS if necessary. */
  text: string;
  /** Character count after cleaning but before truncation. */
  originalChars: number;
  /** Character count actually kept. */
  usedChars: number;
  truncated: boolean;
  /** Rough estimate for display only; not used for billing or limits. */
  approxTokens: number;
}

/**
 * PDF and caption extraction both produce text littered with layout artefacts:
 * hard-wrapped lines, runs of spaces from column gutters, stray control
 * characters, and inconsistent line endings. Collapsing them matters because
 * every wasted character consumes context budget.
 */
export function cleanText(raw: string): string {
  return (
    raw
      // Normalise line endings first so later rules only deal with \n.
      .replace(/\r\n?/g, "\n")
      // Strip control characters except tab and newline.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      // PDF extraction often emits a soft hyphen at a line break; rejoin.
      .replace(/\u00AD\n/g, "")
      // Collapse horizontal whitespace runs (column gutters, justified text).
      .replace(/[ \t\u00A0]+/g, " ")
      // Trim trailing spaces on each line.
      .replace(/ +\n/g, "\n")
      // Collapse 3+ blank lines down to a paragraph break.
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Truncates on a boundary rather than mid-word so the model never sees a
 * fragment. Prefers a paragraph break, then a sentence end, then a space,
 * falling back to a hard cut for text with no boundaries at all (e.g. CJK).
 */
function truncateOnBoundary(text: string, limit: number): string {
  const slice = text.slice(0, limit);
  // Cap how much content we are willing to give back to land on a boundary.
  // A percentage alone scales badly: at the real 360k limit, 10% would discard
  // 36k characters just to find a full stop. 2000 chars is negligible against a
  // large limit while still generous for the small limits used in tests.
  const giveback = Math.min(Math.floor(limit * 0.2), 2000);
  const searchFrom = limit - giveback;

  const paragraph = slice.lastIndexOf("\n\n");
  if (paragraph >= searchFrom) return slice.slice(0, paragraph).trimEnd();

  const sentence = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf(".\n"),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
  );
  if (sentence >= searchFrom) return slice.slice(0, sentence + 1).trimEnd();

  const space = slice.lastIndexOf(" ");
  if (space >= searchFrom) return slice.slice(0, space).trimEnd();

  return slice.trimEnd();
}

export function normalizeExtractedText(
  raw: string,
  limit: number = MAX_CONTEXT_CHARS,
): NormalizedText {
  const cleaned = cleanText(raw);
  const originalChars = cleaned.length;
  const truncated = originalChars > limit;
  const text = truncated ? truncateOnBoundary(cleaned, limit) : cleaned;

  return {
    text,
    originalChars,
    usedChars: text.length,
    truncated,
    approxTokens: Math.round(text.length / APPROX_CHARS_PER_TOKEN),
  };
}
