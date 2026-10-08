import type { DocumentKind } from "@/lib/prompt";

/**
 * Client-side mirror of the ingestion API response.
 *
 * Kept separate from the server module so client components never pull a
 * `server-only` import into the browser bundle.
 */
export interface IngestResult {
  sessionId: string;
  kind: DocumentKind;
  title: string;
  text: string;
  truncated: boolean;
  originalChars: number;
  usedChars: number;
  approxTokens: number;
  pages?: number;
  pagesWithoutText?: number;
}
