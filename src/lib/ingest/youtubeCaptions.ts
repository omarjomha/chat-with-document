/**
 * Parsing for YouTube's `timedtext format="3"` caption XML.
 *
 * Kept separate from the fetching module so it can be tested against real
 * fixtures without a network call.
 */

/** Matches each caption paragraph, including the empty rollup placeholders. */
const PARAGRAPH = /<p\b[^>]*>([\s\S]*?)<\/p>/g;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Caption text arrives HTML-escaped: `It&#39;s` for `It's`. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return codePoint(parseInt(entity.slice(2), 16)) ?? match;
    }
    if (entity.startsWith("#")) {
      return codePoint(parseInt(entity.slice(1), 10)) ?? match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function codePoint(value: number): string | undefined {
  // Reject NaN and anything outside Unicode, which String.fromCodePoint throws on.
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return undefined;
  return String.fromCodePoint(value);
}

/**
 * Extracts the spoken lines from a caption track.
 *
 * Handles both shapes YouTube serves:
 *
 * - Human-written tracks put plain text in each `<p>`.
 * - Auto-generated tracks split a `<p>` into per-word `<s>` elements, and
 *   interleave empty `<p a="1">` placeholders for the rolling on-screen effect.
 *   Each `<s>` carries its own leading space, so stripping the tags and
 *   concatenating reproduces the sentence exactly.
 *
 * Both therefore reduce to: take each paragraph, drop inner markup, decode.
 */
export function parseCaptionXml(xml: string): string[] {
  const lines: string[] = [];

  for (const [, inner] of xml.matchAll(PARAGRAPH)) {
    const text = decodeEntities(inner.replace(/<[^>]*>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    // Empty after stripping means a rollup placeholder rather than speech.
    if (text) lines.push(text);
  }

  return lines;
}
