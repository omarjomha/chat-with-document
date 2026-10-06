"use client";

import { useState } from "react";

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

  return (
    <div className="flex flex-col gap-6">
      {document ? (
        <DocumentPreview document={document} onClear={() => setDocument(undefined)} />
      ) : (
        <SourcePicker disabled={false} onIngested={setDocument} />
      )}

      <VoiceChat key={document?.sessionId ?? "no-document"} sessionId={document?.sessionId} />
    </div>
  );
}
