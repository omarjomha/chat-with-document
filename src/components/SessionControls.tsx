"use client";

import type { ConnectionState } from "@/lib/realtime/client";

interface SessionControlsProps {
  state: ConnectionState;
  muted: boolean;
  hasMicrophone: boolean;
  modelSpeaking: boolean;
  onStartVoice: () => void;
  onStartText: () => void;
  onStop: () => void;
  onToggleMute: () => void;
  onInterrupt: () => void;
}

const BUSY_STATES: ReadonlySet<ConnectionState> = new Set<ConnectionState>([
  "requesting-mic",
  "connecting",
]);

const ACTIVE_STATES: ReadonlySet<ConnectionState> = new Set<ConnectionState>([
  "requesting-mic",
  "connecting",
  "live",
  "reconnecting",
]);

export function SessionControls({
  state,
  muted,
  hasMicrophone,
  modelSpeaking,
  onStartVoice,
  onStartText,
  onStop,
  onToggleMute,
  onInterrupt,
}: SessionControlsProps) {
  const isActive = ACTIVE_STATES.has(state);
  const isBusy = BUSY_STATES.has(state);

  if (!isActive) {
    return (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={onStartVoice}
          className="h-12 w-full rounded-xl bg-slate-900 text-base font-semibold text-white transition active:scale-[0.99] disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900"
        >
          Start Voice Chat
        </button>
        <button
          type="button"
          onClick={onStartText}
          className="h-11 w-full rounded-xl border border-slate-300 text-sm font-medium text-slate-700 transition active:scale-[0.99] dark:border-slate-700 dark:text-slate-200"
        >
          Use text chat instead
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        {hasMicrophone && (
          <button
            type="button"
            onClick={onToggleMute}
            disabled={isBusy}
            aria-pressed={muted}
            className={[
              "h-12 flex-1 rounded-xl text-sm font-semibold transition active:scale-[0.99] disabled:opacity-60",
              muted
                ? "bg-amber-500 text-white"
                : "border border-slate-300 text-slate-700 dark:border-slate-700 dark:text-slate-200",
            ].join(" ")}
          >
            {muted ? "Unmute mic" : "Mute mic"}
          </button>
        )}
        <button
          type="button"
          onClick={onStop}
          className="h-12 flex-1 rounded-xl bg-red-600 text-sm font-semibold text-white transition active:scale-[0.99]"
        >
          End session
        </button>
      </div>

      {modelSpeaking && (
        <button
          type="button"
          onClick={onInterrupt}
          className="h-11 w-full rounded-xl border border-slate-300 text-sm font-medium text-slate-700 transition active:scale-[0.99] dark:border-slate-700 dark:text-slate-200"
        >
          Stop talking
        </button>
      )}
    </div>
  );
}
