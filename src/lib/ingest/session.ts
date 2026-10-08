import "server-only";

import { randomUUID } from "node:crypto";

import { SESSION_TTL_MS } from "@/lib/constants";
import type { DocumentKind } from "@/lib/prompt";
import { getSessionStore } from "@/lib/store";
import type { StoredSession } from "@/lib/store/types";

import { normalizeExtractedText } from "./normalize";

/** Shape returned to the browser after a successful ingestion. */
export interface IngestResult {
  sessionId: string;
  kind: DocumentKind;
  title: string;
  /** Full normalised text, for the collapsible preview the spec requires. */
  text: string;
  truncated: boolean;
  originalChars: number;
  usedChars: number;
  approxTokens: number;
  pages?: number;
  /** PDF pages with no extractable text, likely scanned. Shown, not stored. */
  pagesWithoutText?: number;
}

/**
 * Normalises extracted text, persists it, and shapes the client response.
 *
 * Shared by the PDF and YouTube routes so both sources travel an identical
 * path from raw text to Realtime context.
 */
export async function createSession(input: {
  kind: DocumentKind;
  title: string;
  rawText: string;
  pages?: number;
  pagesWithoutText?: number;
}): Promise<IngestResult> {
  const normalized = normalizeExtractedText(input.rawText);
  const now = Date.now();

  const session: StoredSession = {
    id: randomUUID(),
    kind: input.kind,
    title: input.title,
    text: normalized.text,
    truncated: normalized.truncated,
    originalChars: normalized.originalChars,
    usedChars: normalized.usedChars,
    approxTokens: normalized.approxTokens,
    pages: input.pages,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };

  const store = getSessionStore();
  await store.save(session);

  // Opportunistic sweep. The Hobby plan caps cron at once per day, so relying
  // on the scheduled job alone would leave lapsed documents on disk for up to
  // 24h. Sweeping on write keeps the store clean whenever the app is in use.
  // Failure here must never fail the ingestion the user is waiting on.
  try {
    const removed = await store.deleteExpired();
    if (removed > 0) console.info(`[ingest] swept ${removed} expired session(s)`);
  } catch (error) {
    console.warn("[ingest] expired-session sweep failed", error);
  }

  return {
    sessionId: session.id,
    kind: session.kind,
    title: session.title,
    text: session.text,
    truncated: session.truncated,
    originalChars: session.originalChars,
    usedChars: session.usedChars,
    approxTokens: session.approxTokens,
    pages: session.pages,
    pagesWithoutText: input.pagesWithoutText,
  };
}
