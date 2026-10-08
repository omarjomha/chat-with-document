"use client";

import { useRef, useState } from "react";

import { useRealtimeSession, type RealtimeSession } from "@/lib/realtime/useRealtimeSession";

import { ConnectionStatus } from "./ConnectionStatus";
import { SessionControls } from "./SessionControls";
import { TextChatInput } from "./TextChatInput";
import { TranscriptFeed } from "./TranscriptFeed";

interface VoiceChatProps {
  /** Set in Stage 2 once a document has been ingested. */
  sessionId?: string;
}

export function VoiceChat({ sessionId }: VoiceChatProps) {
  // This component owns the audio sink; the hook only needs a handle to it.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const session = useRealtimeSession({ sessionId, audioRef });
  const [textMode, setTextMode] = useState(false);

  const isLive = session.state === "live" || session.state === "reconnecting";
  const inSession = isLive || session.state === "connecting" || session.state === "requesting-mic";
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

  /*
   * Any tap retries playback that the browser refused. The client tells the
   * user to "tap the page" when autoplay is blocked -- most often after a
   * reconnect, which attaches a new stream outside any user gesture -- and this
   * is what makes that instruction true.
   */
  function resumeAudio() {
    const audio = audioRef.current;
    if (audio?.srcObject && audio.paused) void audio.play().catch(() => {});
  }

  return (
    <section className="flex flex-col gap-4" onPointerDown={resumeAudio}>
      {/*
        The model's voice plays through this element. It must live in the
        document -- a detached media element can have its playback delayed or
        refused, which showed up as the voice starting only after the
        transcript had finished printing. `playsInline` keeps iOS from taking
        over the screen or routing to the earpiece.
      */}
      <audio ref={audioRef} autoPlay playsInline />

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
            className="-m-2 flex h-9 w-9 shrink-0 items-center justify-center text-lg leading-none opacity-60"
          >
            ×
          </button>
        </div>
      )}

      {session.state === "reconnecting" && (
        <p
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          Connection dropped. Reconnecting — the conversation will pick up where it left off.
        </p>
      )}

      {isLive && session.hasMicrophone && (
        <MicStatus muted={session.muted} speaking={session.userSpeaking} />
      )}

      <TranscriptFeed turns={session.turns} emptyHint={emptyHint(session, Boolean(sessionId))} />

      {/*
        Pinned to the bottom of the screen while a session is running. On a
        phone the transcript soon pushes everything below the fold, and mute,
        end and "stop talking" are exactly the controls that must not need a
        scroll to reach mid-answer.
      */}
      <div
        className={[
          "flex flex-col gap-2",
          inSession
            ? "sticky bottom-0 z-10 -mx-4 border-t border-slate-200 bg-white/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur dark:border-slate-800 dark:bg-slate-950/95"
            : "",
        ].join(" ")}
      >
        {/* Disabled while reconnecting: there is no channel to send on. */}
        {showTextInput && (
          <TextChatInput disabled={session.state !== "live"} onSend={session.sendText} />
        )}

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
            className="min-h-10 text-xs font-medium text-slate-500 underline underline-offset-4 dark:text-slate-400"
          >
            Type instead
          </button>
        )}
      </div>
    </section>
  );
}

/** What the empty transcript says, so every state tells the user what happens next. */
function emptyHint(session: RealtimeSession, hasDocument: boolean): string {
  switch (session.state) {
    case "requesting-mic":
      return "Allow microphone access to start talking.";
    case "connecting":
      return "Connecting…";
    case "live":
    case "reconnecting":
      return session.hasMicrophone
        ? "Ask a question out loud to get started."
        : "Type a question to get started.";
    default:
      return hasDocument
        ? "Start a voice chat to ask about it."
        : "Load a PDF or YouTube video above — or start now to chat without one.";
  }
}

/**
 * Always-present microphone state line.
 *
 * Muting previously produced no affirmative feedback -- the UI simply stopped
 * showing "Listening", which is indistinguishable from silence. Rendering a
 * steady baseline state makes the mute transition visible.
 */
function MicStatus({ muted, speaking }: { muted: boolean; speaking: boolean }) {
  const { label, dot, tone } = muted
    ? {
        label: "Muted — the assistant can't hear you",
        dot: "bg-amber-500",
        tone: "text-amber-700 dark:text-amber-400",
      }
    : speaking
      ? {
          label: "Listening…",
          dot: "bg-emerald-500 animate-pulse",
          tone: "text-emerald-700 dark:text-emerald-400",
        }
      : {
          label: "Mic on",
          dot: "bg-emerald-500",
          tone: "text-slate-500 dark:text-slate-400",
        };

  return (
    <p
      className={`flex items-center gap-2 text-xs font-medium ${tone}`}
      role="status"
      aria-live="polite"
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
      {label}
    </p>
  );
}
