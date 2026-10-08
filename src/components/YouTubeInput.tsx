"use client";

import { useState } from "react";

import { parseYouTubeVideoId } from "@/lib/ingest/youtubeUrl";

import { readError, SourceError } from "./SourceError";
import type { IngestResult } from "./types";

interface YouTubeInputProps {
  disabled: boolean;
  onIngested: (result: IngestResult) => void;
}

export function YouTubeInput({ disabled, onIngested }: YouTubeInputProps) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);

    // Mirrors the PDF path: reject what we can recognise as wrong without a
    // round trip, so a typo is answered instantly.
    if (!parseYouTubeVideoId(url)) {
      setError("That is not a YouTube video link. Paste a watch, youtu.be, or Shorts URL.");
      return;
    }

    try {
      setBusy(true);
      const response = await fetch("/api/ingest/youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setError(readError(payload) ?? "That video could not be processed.");
        return;
      }

      onIngested(payload as IngestResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const locked = disabled || busy;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <label htmlFor="youtube-url" className="sr-only">
        YouTube video link
      </label>
      <input
        id="youtube-url"
        // Deliberately not type="url": the native bubble would pre-empt our own
        // validation with wording that varies by browser, and we can say
        // something more useful than "please enter a URL".
        type="text"
        inputMode="url"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="https://youtube.com/watch?v=…"
        value={url}
        disabled={locked}
        onChange={(event) => setUrl(event.target.value)}
        className="min-h-11 rounded-xl border border-slate-300 px-3 text-base text-slate-900 placeholder:text-slate-400 disabled:opacity-60 dark:border-slate-700 dark:text-slate-100 dark:placeholder:text-slate-500"
      />

      <button
        type="submit"
        disabled={locked || url.trim().length === 0}
        className="min-h-11 rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white transition active:scale-[0.99] disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
      >
        {busy ? "Fetching transcript…" : "Load transcript"}
      </button>

      {error && <SourceError message={error} />}
    </form>
  );
}
