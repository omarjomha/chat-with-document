"use client";

import type { ConnectionState } from "@/lib/realtime/client";

const LABELS: Record<ConnectionState, { text: string; dot: string; pulse: boolean }> = {
  idle: { text: "Not connected", dot: "bg-slate-400", pulse: false },
  "requesting-mic": { text: "Waiting for microphone", dot: "bg-amber-500", pulse: true },
  connecting: { text: "Connecting", dot: "bg-amber-500", pulse: true },
  live: { text: "Live", dot: "bg-emerald-500", pulse: false },
  reconnecting: { text: "Reconnecting", dot: "bg-amber-500", pulse: true },
  closed: { text: "Session ended", dot: "bg-slate-400", pulse: false },
  error: { text: "Connection problem", dot: "bg-red-500", pulse: false },
};

export function ConnectionStatus({ state }: { state: ConnectionState }) {
  const { text, dot, pulse } = LABELS[state];

  return (
    <div
      className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200"
      role="status"
      aria-live="polite"
    >
      <span className="relative flex h-2 w-2" aria-hidden="true">
        {pulse && (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${dot}`}
          />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
      </span>
      {text}
    </div>
  );
}
