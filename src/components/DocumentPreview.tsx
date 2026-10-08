"use client";

import { useState } from "react";

import type { IngestResult } from "./types";

interface DocumentPreviewProps {
  document: IngestResult;
  onClear: () => void;
}

/**
 * Collapsible preview of the extracted text, which the spec requires.
 *
 * Collapsed by default: the point of the screen is the conversation, and a
 * 90k-token wall of text would bury the controls on a 390px screen.
 */
export function DocumentPreview({ document, onClear }: DocumentPreviewProps) {
  const [open, setOpen] = useState(false);

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {document.title}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{describe(document)}</p>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="shrink-0 text-xs font-medium text-slate-500 underline underline-offset-4 dark:text-slate-400"
        >
          Replace
        </button>
      </div>

      {document.truncated && (
        <p
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          This document is longer than the model&apos;s context window. The first{" "}
          {formatNumber(document.usedChars)} of {formatNumber(document.originalChars)} characters
          were loaded — roughly {percentKept(document)}%. Questions about later sections may not be
          answerable.
        </p>
      )}

      {document.pagesWithoutText !== undefined && document.pagesWithoutText > 0 && (
        <p
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {document.pagesWithoutText} of {document.pages} pages had no selectable text — probably
          scanned images — so the assistant can&apos;t see what&apos;s on them.
        </p>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="self-start text-xs font-medium text-slate-600 underline underline-offset-4 dark:text-slate-300"
      >
        {open ? "Hide extracted text" : "Show extracted text"}
      </button>

      {open && (
        <div className="max-h-72 overflow-y-auto overscroll-contain rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
          <pre className="font-sans text-xs leading-relaxed whitespace-pre-wrap text-slate-700 dark:text-slate-300">
            {document.text}
          </pre>
        </div>
      )}
    </section>
  );
}

function describe(document: IngestResult): string {
  const parts: string[] = [];
  if (document.kind === "pdf" && document.pages) {
    parts.push(`${document.pages} page${document.pages === 1 ? "" : "s"}`);
  }
  if (document.kind === "youtube") parts.push("YouTube transcript");
  parts.push(`${formatNumber(document.usedChars)} characters`);
  parts.push(`~${formatNumber(document.approxTokens)} tokens`);
  return parts.join(" · ");
}

function percentKept(document: IngestResult): number {
  if (document.originalChars === 0) return 100;
  return Math.round((document.usedChars / document.originalChars) * 100);
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}
