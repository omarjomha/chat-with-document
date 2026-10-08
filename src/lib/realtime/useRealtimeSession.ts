"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import {
  connectRealtime,
  isRetryableConnectError,
  MicrophoneUnavailableError,
  requestMicrophone,
  type ConnectionState,
  type RealtimeSessionHandle,
} from "./client";
import { textMessageEvent, type RealtimeServerEvent } from "./events";
import { historyReplayEvents, reconnectDelay } from "./reconnect";
import { advanceReveal, hasPendingReveal, revealedText } from "./reveal";
import { orderTurns, type TurnSlot } from "./turnOrder";

/** A transcript turn. `streaming` turns render with a live caret. */
export type TranscriptTurn = TurnSlot;

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

/** 50ms is ~0.9 characters at the default rate: smooth without busy-looping. */
const REVEAL_TICK_MS = 50;

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
  // Outlives individual connections, so a rebuild reuses it without a prompt.
  const micRef = useRef<MediaStream | undefined>(undefined);
  /*
   * Bumped by start and stop. A reconnect that was scheduled, or a connection
   * that resolved, under an older generation belongs to a session the user
   * has since ended and must not touch state.
   */
  const generationRef = useRef(0);
  // Cancels a pending reconnect: its timer, or its wait for the network.
  const cancelRetryRef = useRef<(() => void) | undefined>(undefined);

  // Per-turn reveal cursor, in characters. Fractional so slow rates still
  // accumulate across short ticks.
  const [reveal, setReveal] = useState<Record<string, number>>({});
  // Lets the pacing timer read the latest turns without being torn down and
  // rebuilt on every transcript delta.
  const turnsRef = useRef<TranscriptTurn[]>([]);
  // Mirrors the cursors so the seal logic can stay dependency-free. Without
  // this, handleEvent would be rebuilt on every 50ms tick while the live data
  // channel kept calling the version captured at connect time.
  const revealRef = useRef<Record<string, number>>({});
  /*
   * Turns that were cut short and must never be written to again.
   *
   * response.cancel is asynchronous: deltas already in flight keep arriving
   * after it, and a late response.output_audio_transcript.done carries the
   * FULL transcript. Without sealing, an interrupted reply kept growing and
   * then snapped back to its untruncated text -- long after newer messages had
   * been added below it.
   */
  const sealedRef = useRef<Set<string>>(new Set());

  /*
   * The <audio> sink is rendered by the consuming component and attached here
   * by ref, rather than created with document.createElement.
   *
   * A detached media element is unreliable: browsers may delay or refuse
   * playback for an element that is not in the document, which showed up as
   * the model's voice starting only after its transcript had finished
   * printing. Keeping it in the tree fixes that.
   */

  /**
   * Reserves a turn's position in the transcript the moment the conversation
   * item is announced, before any of its text exists.
   *
   * Ordering cannot be derived from when text arrives. Whisper transcribes the
   * user's speech asynchronously, so a question's transcript routinely lands
   * after the answer has begun streaming -- which rendered replies above the
   * questions that prompted them. `previous_item_id` is the server's own
   * ordering, so honour it when the anchor is known and fall back to appending.
   */
  const reserveTurn = useCallback(
    (
      id: string,
      role: TranscriptTurn["role"],
      previousItemId: string | undefined,
      initialText: string,
    ) => {
      if (sealedRef.current.has(id)) return;
      setTurns((current) => orderTurns(current, { id, role, previousItemId, initialText }));
    },
    [],
  );

  const upsertTurn = useCallback(
    (
      id: string,
      role: TranscriptTurn["role"],
      mutate: (previous: string) => string,
      status: TranscriptTurn["status"],
    ) => {
      // An interrupted turn is finished. Later deltas and the late `done` event
      // (which carries the full, untruncated transcript) must be dropped.
      if (sealedRef.current.has(id)) return;
      setTurns((current) => {
        const index = current.findIndex((turn) => turn.id === id);
        // Normally the slot already exists, reserved by conversation.item.added.
        // Appending is a fallback for an item we were never told about.
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

  /**
   * Cuts every still-speaking assistant turn down to what was actually heard.
   *
   * Targets turns whose reveal cursor has not caught up, rather than turns that
   * are merely "not final": response.done marks a turn final when generation
   * ends, which is well before the voice stops, so status alone would miss a
   * reply that is still being spoken.
   */
  const sealUnspokenAssistantTurns = useCallback(() => {
    const cursors = revealRef.current;
    const targets = turnsRef.current.filter(
      (turn) =>
        turn.role === "assistant" &&
        !sealedRef.current.has(turn.id) &&
        (cursors[turn.id] ?? 0) < turn.text.length,
    );
    if (targets.length === 0) return;

    const spokenById = new Map(
      targets.map((turn) => [turn.id, revealedText(turn.text, cursors[turn.id] ?? 0)] as const),
    );
    // Mutated outside the updaters below, which must stay pure.
    for (const turn of targets) sealedRef.current.add(turn.id);

    setTurns((current) =>
      current.map((turn) => {
        const spoken = spokenById.get(turn.id);
        return spoken === undefined ? turn : { ...turn, text: spoken, status: "final" as const };
      }),
    );
    // Pin each cursor to its trimmed length so the pacing timer sees no work.
    setReveal((current) => {
      const next = { ...current };
      for (const [id, spoken] of spokenById) next[id] = spoken.length;
      return next;
    });
  }, []);

  const handleEvent = useCallback(
    (event: RealtimeServerEvent) => {
      switch (event.type) {
        case "input_audio_buffer.speech_started":
          setUserSpeaking(true);
          // Barge-in: the model yields the floor immediately. Server VAD cancels
          // its response, so trim whatever it had not yet said. This is the
          // common way to interrupt -- far more so than the button.
          setModelSpeaking(false);
          sealUnspokenAssistantTurns();
          break;

        case "input_audio_buffer.speech_stopped":
          setUserSpeaking(false);
          break;

        case "conversation.item.added": {
          const { item, previous_item_id: previousItemId } = event as {
            item: {
              id: string;
              type: string;
              role?: string;
              content?: Array<{ type: string; text?: string; transcript?: string | null }>;
            };
            previous_item_id?: string | null;
          };

          // Ignore non-message items such as tool calls.
          if (item.type !== "message") break;
          if (item.role !== "user" && item.role !== "assistant") break;

          // A typed message arrives with its text already present; spoken audio
          // arrives empty and is filled in by transcription events later.
          const initialText =
            item.content
              ?.map((part) => part.text ?? part.transcript ?? "")
              .join("")
              .trim() ?? "";

          reserveTurn(item.id, item.role, previousItemId ?? undefined, initialText);
          break;
        }

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
    [reserveTurn, sealUnspokenAssistantTurns, upsertTurn],
  );

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  useEffect(() => {
    revealRef.current = reveal;
  }, [reveal]);

  const pendingReveal = hasPendingReveal(turns, reveal);

  /*
   * Advances the reveal cursors while any assistant text is still outstanding.
   * The timer only runs when there is something to reveal, so an idle session
   * carries no recurring work.
   */
  useEffect(() => {
    if (!pendingReveal) return;

    let previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const elapsed = now - previous;
      previous = now;

      setReveal((current) => {
        let changed = false;
        const next = { ...current };

        for (const turn of turnsRef.current) {
          if (turn.role !== "assistant") continue;
          const advanced = advanceReveal(current[turn.id] ?? 0, turn.text.length, elapsed);
          if (advanced !== (current[turn.id] ?? 0)) {
            next[turn.id] = advanced;
            changed = true;
          }
        }

        return changed ? next : current;
      });
    }, REVEAL_TICK_MS);

    return () => clearInterval(timer);
  }, [pendingReveal]);

  const releaseMicrophone = useCallback(() => {
    micRef.current?.getTracks().forEach((track) => track.stop());
    micRef.current = undefined;
  }, []);

  const cancelPendingRetry = useCallback(() => {
    cancelRetryRef.current?.();
    cancelRetryRef.current = undefined;
  }, []);

  const stop = useCallback(() => {
    generationRef.current += 1;
    cancelPendingRetry();
    handleRef.current?.close();
    handleRef.current = null;
    releaseMicrophone();
    setModelSpeaking(false);
    setUserSpeaking(false);
    // An error stays on screen until the user starts again; it explains itself.
    setState((current) => (current === "idle" || current === "error" ? current : "closed"));
  }, [cancelPendingRetry, releaseMicrophone]);

  // Rebuild attempts since the session was last live. Reset only on reaching
  // live, so a network where ICE never completes still runs out of attempts.
  const attemptRef = useRef(0);
  // Indirection so a connection can report its loss to the newest handler.
  const lostRef = useRef<() => void>(() => {});

  /** Opens one connection for the current session. Shared by start and every rebuild. */
  const openConnection = useCallback(
    async (generation: number, rebuilding: boolean) => {
      const audioElement = audioRef.current;
      if (!audioElement) throw new Error("Audio output is not ready yet. Try again in a moment.");

      const current = () => generationRef.current === generation;
      const handle = await connectRealtime({
        tokenEndpoint,
        sessionId,
        audioElement,
        microphone: micRef.current,
        onEvent: (event) => {
          if (current()) handleEvent(event);
        },
        onStateChange: (next) => {
          if (!current()) return;
          if (next === "live") attemptRef.current = 0;
          // To the user a rebuild is one continuous "Reconnecting", not a fresh start.
          setState(rebuilding && next === "connecting" ? "reconnecting" : next);
        },
        onError: (message) => {
          if (current()) setError(message);
        },
        onConnectionLost: () => {
          if (current()) lostRef.current();
        },
      });

      if (!current()) {
        // The user stopped while this was negotiating.
        handle.close();
        return;
      }
      handleRef.current = handle;

      // The new session knows the document, from its instructions, but not the
      // conversation. Queued until the data channel opens.
      if (rebuilding) {
        for (const event of historyReplayEvents(turnsRef.current)) handle.send(event);
      }
    },
    [audioRef, handleEvent, sessionId, tokenEndpoint],
  );

  const fail = useCallback(
    (caught: unknown) => {
      releaseMicrophone();
      setState("error");
      if (caught instanceof MicrophoneUnavailableError) {
        setError(micErrorMessage(caught.reason));
      } else {
        setError(caught instanceof Error ? caught.message : "Could not start the session.");
      }
    },
    [releaseMicrophone],
  );

  /**
   * The connection dropped and did not heal by itself. Rebuild it with
   * backoff, holding off entirely while the browser reports being offline,
   * since an attempt then would fail instantly and waste one of the few.
   */
  const handleConnectionLost = useCallback(() => {
    const generation = generationRef.current;
    handleRef.current = null;
    setModelSpeaking(false);
    setUserSpeaking(false);
    // The voice stopped mid-reply, so the transcript keeps only what was heard,
    // and nothing still streaming is going to finish.
    sealUnspokenAssistantTurns();
    setTurns((current) =>
      current.map((turn) => (turn.status === "streaming" ? { ...turn, status: "final" } : turn)),
    );

    const attempt = async () => {
      cancelRetryRef.current = undefined;
      if (generationRef.current !== generation) return;
      attemptRef.current += 1;
      try {
        await openConnection(generation, true);
      } catch (caught) {
        if (generationRef.current !== generation) return;
        if (isRetryableConnectError(caught)) schedule();
        else fail(caught);
      }
    };

    const schedule = () => {
      const delay = reconnectDelay(attemptRef.current);
      if (delay === undefined) {
        fail(
          new Error(
            "The connection was lost and could not be restored. Check your network, then start a new session.",
          ),
        );
        return;
      }
      setState("reconnecting");

      if (navigator.onLine === false) {
        const onOnline = () => {
          window.removeEventListener("online", onOnline);
          void attempt();
        };
        window.addEventListener("online", onOnline);
        cancelRetryRef.current = () => window.removeEventListener("online", onOnline);
        return;
      }

      const timer = setTimeout(() => void attempt(), delay);
      cancelRetryRef.current = () => clearTimeout(timer);
    };

    schedule();
  }, [fail, openConnection, sealUnspokenAssistantTurns]);

  useEffect(() => {
    lostRef.current = handleConnectionLost;
  }, [handleConnectionLost]);

  const start = useCallback(
    async (useMicrophone: boolean) => {
      if (startingRef.current || ACTIVE_STATES.has(state)) return;
      startingRef.current = true;
      generationRef.current += 1;
      const generation = generationRef.current;
      attemptRef.current = 0;
      setError(undefined);
      setTurns([]);
      setReveal({});
      sealedRef.current = new Set();
      setMuted(false);

      try {
        if (useMicrophone) {
          setState("requesting-mic");
          const stream = await requestMicrophone();
          if (generationRef.current !== generation) {
            // Stopped while the permission prompt was up; do not leave the mic on.
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          micRef.current = stream;
        }
        setHasMicrophone(micRef.current !== undefined);
        await openConnection(generation, false);
      } catch (caught) {
        if (generationRef.current === generation) fail(caught);
      } finally {
        startingRef.current = false;
      }
    },
    [fail, openConnection, state],
  );

  const toggleMute = useCallback(() => {
    // The track toggle is a side effect, so it must stay out of the state
    // updater -- React may invoke an updater more than once.
    const next = !muted;
    micRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    setMuted(next);
  }, [muted]);

  const sendText = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !handleRef.current) return;
    // No optimistic turn here. The server echoes the item back via
    // conversation.item.added with its real id and text, and adding our own
    // would render the message twice under two different ids.
    for (const event of textMessageEvent(trimmed)) {
      handleRef.current.send(event);
    }
  }, []);

  const interrupt = useCallback(() => {
    handleRef.current?.send({ type: "response.cancel" });
    setModelSpeaking(false);
    sealUnspokenAssistantTurns();
  }, [sealUnspokenAssistantTurns]);

  // Tear the peer connection down if the component unmounts mid-session.
  useEffect(() => stop, [stop]);

  /*
   * Assistant turns are surfaced sliced to their reveal cursor so the text
   * tracks the voice. The unsliced text stays in state as the source of truth,
   * and a turn still streaming visually is reported as such even once its text
   * has fully arrived.
   */
  const pacedTurns = turns.map((turn) => {
    if (turn.role !== "assistant") return turn;
    const cursor = reveal[turn.id] ?? 0;
    const shown = revealedText(turn.text, cursor);
    const caughtUp = cursor >= turn.text.length;
    return { ...turn, text: shown, status: caughtUp ? turn.status : "streaming" };
  });

  return {
    state,
    turns: pacedTurns,
    error,
    muted,
    hasMicrophone,
    userSpeaking,
    /*
     * Outstanding reveal counts as still speaking.
     *
     * response.done fires when generation finishes, which is well before the
     * voice stops. Using it alone hid the interrupt control while the model was
     * still audibly talking. The reveal cursor tracks the speech, so it is the
     * better signal for whether there is anything left to interrupt.
     */
    modelSpeaking: modelSpeaking || pendingReveal,
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
