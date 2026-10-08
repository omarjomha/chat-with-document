/**
 * Parsing for YouTube's timed-text caption XML.
 *
 * Kept separate from the fetching module so it can be tested against real
 * fixtures without a network call.
 */

/** Format 3 wraps each caption card in <p>; the legacy format uses <text>. */
const FORMAT3_PARAGRAPH = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
const LEGACY_TEXT = /<text\b[^>]*>([\s\S]*?)<\/text>/g;

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
 * Checks that a response body is actually a caption document.
 *
 * This guard exists because of a measured failure, not a hypothetical one.
 * Requesting a caption URL can return HTTP 200 with an HTML page -- an interstitial,
 * a consent screen, or Google's "your computer or network may be sending
 * automated queries" page. HTML contains <p> elements, so without this check
 * the parser below turns that page into a plausible-looking transcript and the
 * model then discusses Google's error message as if it were the video.
 *
 * Verified: the Sorry page parses into
 * "... but your computer or network may be sending automated queries. To
 * protect our users, we can't process your request right now."
 *
 * Requiring a timed-text root element is a cheap, total defence, since every
 * real caption document has one and no HTML page does.
 */
export function looksLikeCaptionXml(body: string): boolean {
  return /<\s*(timedtext|transcript)\b/i.test(body);
}

/**
 * Extracts the spoken lines from a caption track.
 *
 * Handles every shape YouTube serves:
 *
 * - Human-written format 3 tracks put plain text in each `<p>`.
 * - Auto-generated tracks split a `<p>` into per-word `<s>` elements, and
 *   interleave empty `<p a="1">` placeholders for the rolling on-screen effect.
 *   Each `<s>` carries its own leading space, so stripping the tags and
 *   concatenating reproduces the sentence exactly.
 * - The legacy format uses `<text start= dur=>` instead of `<p>`. We request
 *   `fmt=srv3` so this should not arrive, but a client whose URL carries no
 *   format parameter is one YouTube change away from returning it, and the
 *   fallback costs one regex.
 *
 * All of them therefore reduce to: take each cue, drop inner markup, decode.
 */
export function parseCaptionXml(xml: string): string[] {
  // Format 3 is what we ask for, so try it first and only fall back when it
  // yields nothing -- a document with both shapes does not exist.
  const lines = extractCues(xml, FORMAT3_PARAGRAPH);
  return lines.length > 0 ? lines : extractCues(xml, LEGACY_TEXT);
}

function extractCues(xml: string, pattern: RegExp): string[] {
  const lines: string[] = [];

  for (const [, inner] of xml.matchAll(pattern)) {
    const text = decodeEntities(inner.replace(/<[^>]*>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    // Empty after stripping means a rollup placeholder rather than speech.
    if (text) lines.push(text);
  }

  return lines;
}
