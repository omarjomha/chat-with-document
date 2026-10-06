"use client";

import { useEffect, useRef } from "react";

import type { TranscriptTurn } from "@/lib/realtime/useRealtimeSession";

interface TranscriptFeedProps {
  turns: TranscriptTurn[];
  emptyHint: string;
}

export function TranscriptFeed({ turns, emptyHint }: TranscriptFeedProps) {
  const endRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest turn in view as text streams in.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  if (turns.length === 0) {
    return (
      <div className="flex min-h-40 items-center justify-center rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        {emptyHint}
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-3"
      role="log"
      aria-live="polite"
      aria-label="Conversation transcript"
    >
      {turns.map((turn) => (
        <TurnBubble key={turn.id} turn={turn} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function TurnBubble({ turn }: { turn: TranscriptTurn }) {
  const isUser = turn.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={[
          "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
          isUser
            ? "rounded-br-sm bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
            : "rounded-bl-sm bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100",
        ].join(" ")}
      >
        <span className="sr-only">{isUser ? "You said: " : "Assistant said: "}</span>
        {turn.text}
        {turn.status === "streaming" && (
          <span
            className="ml-0.5 inline-block h-4 w-0.5 translate-y-0.5 animate-pulse bg-current align-middle"
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
}
