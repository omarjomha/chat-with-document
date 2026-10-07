"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
export function DocumentChat() {
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
    <div className="flex flex-col gap-6">
      {document ? (
        <DocumentPreview document={document} onClear={handleClear} />
      ) : (
        <SourcePicker disabled={false} onIngested={setDocument} />
      )}

      <VoiceChat key={document?.sessionId ?? "no-document"} sessionId={document?.sessionId} />
    </div>
  );
}
