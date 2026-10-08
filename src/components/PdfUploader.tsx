"use client";

import { upload } from "@vercel/blob/client";
import { useRef, useState } from "react";

import { MAX_PDF_BYTES, PDF_UPLOAD_PREFIX } from "@/lib/constants";

import { readError, SourceError } from "./SourceError";
import type { IngestResult } from "./types";

interface PdfUploaderProps {
  disabled: boolean;
  onIngested: (result: IngestResult) => void;
}

type Phase = "idle" | "uploading" | "extracting";

const PHASE_LABEL: Record<Exclude<Phase, "idle">, string> = {
  uploading: "Uploading…",
  extracting: "Extracting text…",
};

export function PdfUploader({ disabled, onIngested }: PdfUploaderProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const busy = phase !== "idle";

  async function handleFile(file: File) {
    setError(undefined);

    // Check locally first so the user gets an instant answer instead of
    // waiting out an upload that the server will reject.
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("That is not a PDF. Please choose a .pdf file.");
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setError(`That PDF is ${formatBytes(file.size)}. The limit is 25 MB.`);
      return;
    }
    if (file.size === 0) {
      setError("That file is empty.");
      return;
    }

    try {
      setPhase("uploading");
      // Straight to Blob storage: Vercel caps function bodies at 4.5 MB, well
      // under the 25 MB the spec requires.
      const blob = await upload(stagingPath(file.name), file, {
        access: "private",
        handleUploadUrl: "/api/ingest/pdf/upload",
      });

      setPhase("extracting");
      const response = await fetch("/api/ingest/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pathname: blob.pathname, filename: file.name }),
      });

      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setError(readError(payload) ?? "The PDF could not be processed.");
        return;
      }

      onIngested(payload as IngestResult);
    } catch (caught) {
      setError(uploadErrorMessage(caught));
    } finally {
      setPhase("idle");
      // Allow re-selecting the same file after an error.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label
        className={[
          "flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed px-4 py-6 text-center transition",
          disabled || busy
            ? "cursor-not-allowed border-slate-200 opacity-60 dark:border-slate-800"
            : "border-slate-300 active:scale-[0.99] dark:border-slate-700",
        ].join(" ")}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          disabled={disabled || busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
        {busy ? (
          <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
            {PHASE_LABEL[phase]}
          </span>
        ) : (
          <>
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Choose a PDF
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">Up to 25 MB</span>
          </>
        )}
      </label>

      {error && <SourceError message={error} />}
    </div>
  );
}

/**
 * The Blob client discards the handshake route's response body and throws its
 * own fixed wording, so the server's reason -- usually the rate limit -- never
 * reaches here. Say what is actionable instead of echoing library internals.
 */
function uploadErrorMessage(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : "";
  if (/client token/i.test(message)) {
    return "The server refused the upload. If you have uploaded several files in the last few minutes, wait a little and try again.";
  }
  if (caught instanceof TypeError) {
    return "Could not reach the server. Check your connection and try again.";
  }
  return message || "Upload failed.";
}

/**
 * Where the file goes in Blob: the staging folder, the only place the server
 * will extract from. A slash in the name would read as a subfolder, and a PDF
 * picked by MIME type alone may lack the extension the server requires.
 */
function stagingPath(name: string): string {
  const safe = name.replaceAll("/", "_");
  return `${PDF_UPLOAD_PREFIX}${safe.toLowerCase().endsWith(".pdf") ? safe : `${safe}.pdf`}`;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}
