"use client";

import { useState } from "react";

import { PdfUploader } from "./PdfUploader";
import type { IngestResult } from "./types";
import { YouTubeInput } from "./YouTubeInput";

interface SourcePickerProps {
  disabled: boolean;
  onIngested: (result: IngestResult) => void;
}

type Tab = "pdf" | "youtube";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "pdf", label: "PDF" },
  { id: "youtube", label: "YouTube" },
];

/**
 * Chooses between the two ingest paths.
 *
 * Tabs rather than two stacked forms: at the 390px target both would not fit
 * above the fold, and picking a source is a choice of one.
 */
export function SourcePicker({ disabled, onIngested }: SourcePickerProps) {
  const [tab, setTab] = useState<Tab>("pdf");
  // Switching tabs remounts the form, which would hide an upload still running
  // and then surprise the user when it finished. Hold the tab until it does.
  const [busy, setBusy] = useState(false);
  const locked = disabled || busy;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Source</h2>

      <div
        role="tablist"
        aria-label="Document source"
        className="flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-900"
      >
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`source-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`source-panel-${id}`}
            disabled={locked}
            onClick={() => setTab(id)}
            className={[
              "min-h-10 flex-1 rounded-lg text-sm font-medium transition disabled:opacity-60",
              tab === id
                ? "bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-slate-100"
                : "text-slate-600 dark:text-slate-400",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`source-panel-${tab}`}
        aria-labelledby={`source-tab-${tab}`}
        // Keyed so switching tabs clears the other path's error and in-flight
        // state rather than leaving a stale message under the new form.
        key={tab}
      >
        {tab === "pdf" ? (
          <PdfUploader disabled={disabled} onIngested={onIngested} onBusyChange={setBusy} />
        ) : (
          <YouTubeInput disabled={disabled} onIngested={onIngested} onBusyChange={setBusy} />
        )}
      </div>
    </section>
  );
}
