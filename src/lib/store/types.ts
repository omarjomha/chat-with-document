import type { DocumentKind } from "@/lib/prompt";

export interface StoredSession {
  id: string;
  kind: DocumentKind;
  /** Filename or video title, shown in the UI and given to the model. */
  title: string;
  /** Normalised, already-truncated text. */
  text: string;
  truncated: boolean;
  originalChars: number;
  usedChars: number;
  approxTokens: number;
  /** PDF page count, or undefined for YouTube. */
  pages?: number;
  createdAt: number;
}

/**
 * Persistence seam for ingested documents.
 *
 * The spec says in-memory storage is sufficient, which holds for a long-lived
 * server. It does not hold on Vercel: functions are stateless between
 * invocations, and although Fluid Compute reuses instances, it gives no
 * guarantee that the request minting a token reaches the instance that
 * ingested the document. A bare Map would therefore work locally and fail
 * intermittently in production -- the worst failure shape.
 *
 * This interface keeps the simple implementation for local development and a
 * durable one for deployment, chosen by environment.
 */
export interface SessionStore {
  save(session: StoredSession): Promise<void>;
  get(id: string): Promise<StoredSession | undefined>;
  delete(id: string): Promise<void>;
}
