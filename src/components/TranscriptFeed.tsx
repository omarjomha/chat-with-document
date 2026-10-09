"use client";

import type { TranscriptTurn } from "@/lib/realtime/useRealtimeSession";

interface TranscriptFeedProps {
  turns: TranscriptTurn[];
  emptyHint: string;
}

export function TranscriptFeed({ turns, emptyHint }: TranscriptFeedProps) {
  // Turns are reserved in conversation order the moment an item is announced,
  // which is before its text exists. Hide the empty ones so a placeholder
  // bubble never appears, while their position is still held in the array.
  const visible = turns.filter((turn) => turn.text.trim().length > 0);

  if (visible.length === 0) {
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
      {visible.map((turn) => (
        <TurnBubble key={turn.id} turn={turn} />
      ))}
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
