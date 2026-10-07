"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import {
  connectRealtime,
  MicrophoneUnavailableError,
  type ConnectionState,
  type RealtimeSessionHandle,
} from "./client";
import { textMessageEvent, type RealtimeServerEvent } from "./events";

export interface TranscriptTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** `streaming` turns render with a live caret. */
  status: "streaming" | "final";
}

export interface UseRealtimeSessionOptions {
  sessionId?: string;
  tokenEndpoint?: string;
  /**
   * The <audio> element the model's voice plays through, owned and rendered
   * by the calling component.
   *
   * It must be in the document: browsers may delay or refuse playback for a
   * detached media element, which showed up as the voice starting only after
   * its transcript had finished printing.
   */
  audioRef: RefObject<HTMLAudioElement | null>;
}

export interface RealtimeSession {
  state: ConnectionState;
  turns: TranscriptTurn[];
  error?: string;
  muted: boolean;
  hasMicrophone: boolean;
  userSpeaking: boolean;
  /** True while the model is producing audio, so the UI can offer "interrupt". */
  modelSpeaking: boolean;
  start(useMicrophone: boolean): Promise<void>;
  stop(): void;
  toggleMute(): void;
  sendText(text: string): void;
  interrupt(): void;
  clearError(): void;
}

const ACTIVE_STATES: ReadonlySet<ConnectionState> = new Set<ConnectionState>([
  "requesting-mic",
  "connecting",
  "live",
  "reconnecting",
]);

export function useRealtimeSession(options: UseRealtimeSessionOptions): RealtimeSession {
  const { sessionId, tokenEndpoint = "/api/realtime/token", audioRef } = options;

  const [state, setState] = useState<ConnectionState>("idle");
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [error, setError] = useState<string>();
  const [muted, setMuted] = useState(false);
  const [hasMicrophone, setHasMicrophone] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [modelSpeaking, setModelSpeaking] = useState(false);

  const handleRef = useRef<RealtimeSessionHandle | null>(null);
  const startingRef = useRef(false);

  /*
   * The <audio> sink is rendered by the consuming component and attached here
   * by ref, rather than created with document.createElement.
   *
   * A detached media element is unreliable: browsers may delay or refuse
   * playback for an element that is not in the document, which showed up as
   * the model's voice starting only after its transcript had finished
   * printing. Keeping it in the tree fixes that.
   */

  const upsertTurn = useCallback(
    (
      id: string,
      role: TranscriptTurn["role"],
      mutate: (previous: string) => string,
      status: TranscriptTurn["status"],
    ) => {
      setTurns((current) => {
        const index = current.findIndex((turn) => turn.id === id);
        if (index === -1) {
          return [...current, { id, role, text: mutate(""), status }];
        }
        const next = [...current];
        next[index] = { ...next[index], text: mutate(next[index].text), status };
        return next;
      });
    },
    [],
  );

  const handleEvent = useCallback(
    (event: RealtimeServerEvent) => {
      switch (event.type) {
        case "input_audio_buffer.speech_started":
          setUserSpeaking(true);
          // Barge-in: the model yields the floor immediately.
          setModelSpeaking(false);
          break;

        case "input_audio_buffer.speech_stopped":
          setUserSpeaking(false);
          break;

        case "conversation.item.input_audio_transcription.delta": {
          const { item_id: itemId, delta } = event as { item_id: string; delta: string };
          upsertTurn(itemId, "user", (previous) => previous + delta, "streaming");
          break;
        }

        case "conversation.item.input_audio_transcription.completed": {
          const { item_id: itemId, transcript } = event as {
            item_id: string;
            transcript: string;
          };
          upsertTurn(itemId, "user", () => transcript, "final");
          break;
        }

        case "response.created":
          setModelSpeaking(true);
          break;

        case "response.output_audio_transcript.delta":
        case "response.output_text.delta": {
          const { item_id: itemId, delta } = event as { item_id: string; delta: string };
          upsertTurn(itemId, "assistant", (previous) => previous + delta, "streaming");
          break;
        }

        case "response.output_audio_transcript.done": {
          const { item_id: itemId, transcript } = event as {
            item_id: string;
            transcript: string;
          };
          upsertTurn(itemId, "assistant", () => transcript, "final");
          break;
        }

        case "response.output_text.done": {
          const { item_id: itemId, text } = event as { item_id: string; text: string };
          upsertTurn(itemId, "assistant", () => text, "final");
          break;
        }

        case "response.done":
          setModelSpeaking(false);
          setTurns((current) =>
            current.map((turn) =>
              turn.status === "streaming" ? { ...turn, status: "final" } : turn,
            ),
          );
          break;

        default:
          if (process.env.NODE_ENV === "development") {
            console.debug("[realtime] unhandled event", event.type);
          }
          break;
      }
    },
    [upsertTurn],
  );

  const stop = useCallback(() => {
    handleRef.current?.close();
    handleRef.current = null;
    setModelSpeaking(false);
    setUserSpeaking(false);
  }, []);

  const start = useCallback(
    async (useMicrophone: boolean) => {
      if (startingRef.current || ACTIVE_STATES.has(state)) return;
      startingRef.current = true;
      setError(undefined);
      setTurns([]);

      const audioElement = audioRef.current;
      if (!audioElement) {
        setState("error");
        setError("Audio output is not ready yet. Try again in a moment.");
        startingRef.current = false;
        return;
      }

      try {
        const handle = await connectRealtime({
          tokenEndpoint,
          sessionId,
          audioElement,
          useMicrophone,
          onEvent: handleEvent,
          onStateChange: setState,
          onError: setError,
        });
        handleRef.current = handle;
        setHasMicrophone(handle.hasMicrophone);
        setMuted(false);
      } catch (caught) {
        setState("error");
        if (caught instanceof MicrophoneUnavailableError) {
          setError(micErrorMessage(caught.reason));
        } else {
          setError(caught instanceof Error ? caught.message : "Could not start the session.");
        }
      } finally {
        startingRef.current = false;
      }
    },
    [audioRef, handleEvent, sessionId, state, tokenEndpoint],
  );

  const toggleMute = useCallback(() => {
    // The track toggle is a side effect, so it must stay out of the state
    // updater -- React may invoke an updater more than once.
    const next = !muted;
    handleRef.current?.setMuted(next);
    setMuted(next);
  }, [muted]);

  const sendText = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !handleRef.current) return;
    // Render the typed message immediately; the server emits no transcription
    // event for text input.
    const localId = `local-${Date.now()}`;
    setTurns((current) => [
      ...current,
      { id: localId, role: "user", text: trimmed, status: "final" },
    ]);
    for (const event of textMessageEvent(trimmed)) {
      handleRef.current.send(event);
    }
  }, []);

  const interrupt = useCallback(() => {
    handleRef.current?.send({ type: "response.cancel" });
    setModelSpeaking(false);
  }, []);

  // Tear the peer connection down if the component unmounts mid-session.
  useEffect(() => stop, [stop]);

  return {
    state,
    turns,
    error,
    muted,
    hasMicrophone,
    userSpeaking,
    modelSpeaking,
    start,
    stop,
    toggleMute,
    sendText,
    interrupt,
    clearError: () => setError(undefined),
  };
}

function micErrorMessage(reason: MicrophoneUnavailableError["reason"]): string {
  switch (reason) {
    case "denied":
      return "Microphone permission was denied. Allow it in your browser settings, or switch to text chat.";
    case "missing":
      return "No microphone was found. You can still use text chat.";
    case "insecure-context":
      return "Microphone access needs HTTPS. Open the deployed URL rather than a local IP address, or use text chat.";
    default:
      return "Could not access the microphone. You can still use text chat.";
  }
}
