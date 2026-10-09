"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { DocumentPreview } from "./DocumentPreview";
import { SourcePicker } from "./SourcePicker";
import type { IngestResult } from "./types";
import { VoiceChat } from "./VoiceChat";

/**
 * Owns the ingest-then-converse flow.
 *
 * The session is keyed by sessionId so that replacing the document tears down
 * any live conversation -- continuing to talk against stale context would be
 * worse than making the user start again.
 */
export function DocumentChat({ children }: { children?: ReactNode }) {
  const [document, setDocument] = useState<IngestResult>();

  // Mirrors `document` so the unload handler can read the current id without
  // re-registering the listener on every change. Written in an effect, not
  // during render, since refs must not be mutated while rendering.
  const sessionIdRef = useRef<string>(undefined);
  useEffect(() => {
    sessionIdRef.current = document?.sessionId;
  }, [document?.sessionId]);

  const discard = useCallback(async (sessionId: string) => {
    try {
      await fetch(`/api/sessions/${sessionId}`, { method: "DELETE", keepalive: true });
    } catch {
      // Best-effort: expiry in the store is the real guarantee.
    }
  }, []);

  // Drop the stored document when the user leaves. `pagehide` fires on mobile
  // Safari where `beforeunload` often does not, and sendBeacon survives the
  // teardown that would abort a normal fetch.
  useEffect(() => {
    function handlePageHide() {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      navigator.sendBeacon?.(`/api/sessions/${sessionId}`);
    }

    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, []);

  function handleClear() {
    const previous = document?.sessionId;
    setDocument(undefined);
    if (previous) void discard(previous);
  }

  return (
    // The page heading and the source scroll with the conversation, above its
    // controls, so they are handed to VoiceChat rather than rendered beside it.
    <VoiceChat key={document?.sessionId ?? "no-document"} sessionId={document?.sessionId}>
      {children}
      {document ? (
        <DocumentPreview document={document} onClear={handleClear} />
      ) : (
        <SourcePicker disabled={false} onIngested={setDocument} />
      )}
    </VoiceChat>
  );
}
