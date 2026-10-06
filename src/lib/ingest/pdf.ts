import "server-only";

import { extractText, getDocumentProxy } from "unpdf";

export type PdfErrorCode = "encrypted" | "corrupt" | "empty" | "no-text-layer" | "unknown";

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
      "This file could not be read as a PDF. It may be corrupt or not actually a PDF.",
    );
  }
  return new PdfExtractionError("unknown", "The PDF could not be processed.");
}

export async function extractPdfText(data: Uint8Array): Promise<PdfExtraction> {
  if (data.byteLength === 0) {
    throw new PdfExtractionError("empty", "The uploaded file is empty.");
  }

  let pages: number;
  let text: string;

  try {
    // getDocumentProxy surfaces password/structure errors distinctly, which a
    // bare extractText call would flatten into a generic failure.
    const pdf = await getDocumentProxy(data);
    const result = await extractText(pdf, { mergePages: true });
    pages = result.totalPages;
    text = result.text;
  } catch (error) {
    throw toExtractionError(error);
  }

  // A scanned PDF parses cleanly but yields no characters. This is a common
  // real-world case and deserves its own message rather than an empty preview.
  if (text.trim().length === 0) {
    throw new PdfExtractionError(
      "no-text-layer",
      `No selectable text found across ${pages} page${pages === 1 ? "" : "s"}. This looks like a scanned PDF; it would need OCR, which this app does not do.`,
    );
  }

  return { text, pages };
}
