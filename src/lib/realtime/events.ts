/**
 * Typed view over the Realtime data-channel protocol.
 *
 * We model only the events this app consumes. Everything else is surfaced as
 * `UnknownRealtimeEvent` rather than discarded, so protocol drift shows up in
 * logs instead of silently breaking the transcript.
 */

export interface UnknownRealtimeEvent {
  type: string;
  [key: string]: unknown;
}

export type RealtimeServerEvent =
  | { type: "session.created" }
  | { type: "session.updated" }
  | { type: "input_audio_buffer.speech_started" }
  | { type: "input_audio_buffer.speech_stopped" }
  /**
   * Emitted whenever an item joins the conversation: for the user when the
   * input audio buffer is committed, and for the assistant when a response
   * begins. This is the only reliable source of conversation ordering --
   * Whisper transcription of user speech resolves asynchronously and often
   * lands after the assistant has already started replying.
   */
  | {
      type: "conversation.item.added";
      previous_item_id?: string | null;
      item: {
        id: string;
        type: string;
        role?: string;
        content?: Array<{ type: string; text?: string; transcript?: string | null }>;
      };
    }
  | {
      type: "conversation.item.input_audio_transcription.delta";
      item_id: string;
      delta: string;
    }
  | {
      type: "conversation.item.input_audio_transcription.completed";
      item_id: string;
      transcript: string;
    }
  | { type: "response.created"; response: { id: string } }
  | {
      type: "response.output_audio_transcript.delta";
      item_id: string;
      delta: string;
    }
  | {
      type: "response.output_audio_transcript.done";
      item_id: string;
      transcript: string;
    }
  | { type: "response.output_text.delta"; item_id: string; delta: string }
  | { type: "response.output_text.done"; item_id: string; text: string }
  | { type: "response.done" }
  | { type: "error"; error: { message?: string; code?: string; type?: string } }
  | UnknownRealtimeEvent;

/** Narrows an event by its `type` discriminator. */
export function isEvent<T extends RealtimeServerEvent["type"]>(
  event: RealtimeServerEvent,
  type: T,
): event is Extract<RealtimeServerEvent, { type: T }> {
  return event.type === type;
}

export function parseServerEvent(raw: string): RealtimeServerEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { type?: unknown }).type === "string"
    ) {
      return parsed as RealtimeServerEvent;
    }
  } catch {
    // Malformed frame — ignore rather than tearing down the session.
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Client -> server events                                             */
/* ------------------------------------------------------------------ */

export type RealtimeClientEvent =
  | {
      type: "conversation.item.create";
      item:
        | {
            /** Optional; set when replaying history so the echo can be matched up. */
            id?: string;
            type: "message";
            role: "user";
            content: Array<{ type: "input_text"; text: string }>;
          }
        | {
            id?: string;
            type: "message";
            role: "assistant";
            content: Array<{ type: "output_text"; text: string }>;
          };
    }
  | { type: "response.create" }
  | { type: "response.cancel" };

export function textMessageEvent(text: string): RealtimeClientEvent[] {
  return [
    {
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    },
    { type: "response.create" },
  ];
}
