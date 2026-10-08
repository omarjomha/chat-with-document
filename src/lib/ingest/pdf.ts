import "server-only";

import { extractText, getDocumentProxy } from "unpdf";

export type PdfErrorCode =
  "encrypted" | "corrupt" | "empty" | "no-text-layer" | "unreadable" | "unknown";

export class PdfExtractionError extends Error {
  constructor(
    readonly code: PdfErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PdfExtractionError";
  }
}

export interface PdfExtraction {
  /** Raw concatenated text; call normalizeExtractedText before use. */
  text: string;
  pages: number;
  /**
   * Pages that yielded no text, typically scanned images in an otherwise
   * digital document. Their content is invisible to the model, and the user
   * should be told rather than discover it by asking about them.
   */
  pagesWithoutText: number;
}

/** Any letter or digit, in any script. Punctuation and whitespace alone are not content. */
const READABLE = /[\p{L}\p{N}]/gu;
/**
 * What pdf.js emits for a glyph it cannot map back to a character: the
 * replacement character, or a private-use code point from a font that has no
 * character map. Such text renders fine on screen and is noise when extracted.
 */
const UNREADABLE = /[�-]/gu;

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/**
 * True when extraction produced mostly glyphs that map to no character.
 *
 * Happens with PDFs whose fonts were embedded without a character map, often
 * from older publishing tools or deliberate copy protection. The page looks
 * normal but the extracted "text" is gibberish, and handing that to the model
 * would have it confidently discussing noise.
 */
export function isMostlyUnreadable(text: string): boolean {
  const unreadable = count(text, UNREADABLE);
  return unreadable > 0 && unreadable >= count(text, READABLE);
}

/** Maps pdf.js failure modes onto actionable messages. */
function toExtractionError(error: unknown): PdfExtractionError {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);

  if (name === "PasswordException" || /password/i.test(message)) {
    return new PdfExtractionError(
      "encrypted",
      "This PDF is password-protected. Remove the password and try again.",
    );
  }
  if (name === "InvalidPDFException" || /invalid pdf|structure/i.test(message)) {
    return new PdfExtractionError(
      "corrupt",
      // pdf.js reports a truncated file -- an interrupted download -- the same
      // way as a damaged one, so the message covers both.
      "This file could not be read as a PDF. It may be damaged, incomplete, or not actually a PDF.",
    );
  }
  return new PdfExtractionError("unknown", "The PDF could not be processed.");
}

export async function extractPdfText(data: Uint8Array): Promise<PdfExtraction> {
  if (data.byteLength === 0) {
    throw new PdfExtractionError("empty", "The uploaded file is empty.");
  }

  let pages: number;
  let pageTexts: string[];

  try {
    // getDocumentProxy surfaces password/structure errors distinctly, which a
    // bare extractText call would flatten into a generic failure.
    const pdf = await getDocumentProxy(data);
    // Per page rather than merged, so pages with no text can be counted.
    const result = await extractText(pdf, { mergePages: false });
    pages = result.totalPages;
    pageTexts = result.text;
  } catch (error) {
    throw toExtractionError(error);
  }

  const pagesWithoutText = pageTexts.filter((page) => count(page, READABLE) === 0).length;

  // A scanned PDF parses cleanly but yields no characters. This is a common
  // real-world case and deserves its own message rather than an empty preview.
  if (pagesWithoutText === pages) {
    throw new PdfExtractionError(
      "no-text-layer",
      `No selectable text found across ${pages} page${pages === 1 ? "" : "s"}. This looks like a scanned PDF; it would need OCR, which this app does not do.`,
    );
  }

  // A blank line between pages gives truncation a paragraph boundary to land on.
  const text = pageTexts.join("\n\n");

  if (isMostlyUnreadable(text)) {
    throw new PdfExtractionError(
      "unreadable",
      "The text in this PDF can't be read back: its fonts don't say which characters they draw, so extraction produces gibberish. Exporting or printing it to a new PDF sometimes fixes this.",
    );
  }

  return { text, pages, pagesWithoutText };
}
