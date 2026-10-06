import "server-only";

import { randomUUID } from "node:crypto";

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
}): Promise<IngestResult> {
  const normalized = normalizeExtractedText(input.rawText);

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
    createdAt: Date.now(),
  };

  await getSessionStore().save(session);

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
  };
}
