"use client";

import { useState } from "react";

import { useRealtimeSession } from "@/lib/realtime/useRealtimeSession";

import { ConnectionStatus } from "./ConnectionStatus";
import { SessionControls } from "./SessionControls";
import { TextChatInput } from "./TextChatInput";
import { TranscriptFeed } from "./TranscriptFeed";

interface VoiceChatProps {
  /** Set in Stage 2 once a document has been ingested. */
  sessionId?: string;
}

export function VoiceChat({ sessionId }: VoiceChatProps) {
  const session = useRealtimeSession({ sessionId });
  const [textMode, setTextMode] = useState(false);

  const isLive = session.state === "live" || session.state === "reconnecting";
  // Text input is always available during a live session: it doubles as the
  // spec's microphone fallback and as a quiet-room alternative.
  const showTextInput = isLive && (textMode || !session.hasMicrophone);

  async function startVoice() {
    setTextMode(false);
    await session.start(true);
  }

  async function startText() {
    setTextMode(true);
    await session.start(false);
  }

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Conversation</h2>
        <ConnectionStatus state={session.state} />
      </header>

      {session.error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          <p className="min-w-0">{session.error}</p>
          <button
            type="button"
            onClick={session.clearError}
            aria-label="Dismiss error"
            className="shrink-0 text-lg leading-none opacity-60"
          >
            ×
          </button>
        </div>
      )}

      {session.userSpeaking && (
        <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Listening…</p>
      )}

      <TranscriptFeed
        turns={session.turns}
        emptyHint={
          isLive
            ? session.hasMicrophone
              ? "Say something to get started."
              : "Type a message to get started."
            : "Start a session to begin the conversation."
        }
      />

      {showTextInput && <TextChatInput disabled={!isLive} onSend={session.sendText} />}

      <SessionControls
        state={session.state}
        muted={session.muted}
        hasMicrophone={session.hasMicrophone}
        modelSpeaking={session.modelSpeaking}
        onStartVoice={startVoice}
        onStartText={startText}
        onStop={session.stop}
        onToggleMute={session.toggleMute}
        onInterrupt={session.interrupt}
      />

      {isLive && session.hasMicrophone && !textMode && (
        <button
          type="button"
          onClick={() => setTextMode(true)}
          className="text-xs font-medium text-slate-500 underline underline-offset-4 dark:text-slate-400"
        >
          Type instead
        </button>
      )}
    </section>
  );
}
