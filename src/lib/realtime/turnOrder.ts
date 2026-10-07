/**
 * Transcript ordering, kept pure and separate so it can be tested directly.
 *
 * Conversation order cannot be inferred from when text arrives. Whisper
 * transcribes user speech asynchronously, so a question's transcript routinely
 * resolves after the assistant's answer has begun streaming. Ordering by
 * arrival therefore rendered replies above the questions that prompted them.
 *
 * Instead, a slot is reserved the moment the server announces a conversation
 * item, using the server's own `previous_item_id` as the anchor.
 */

export interface TurnSlot {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "streaming" | "final";
}

export interface TurnAnnouncement {
  id: string;
  role: "user" | "assistant";
  /** The item this one follows, per the server. */
  previousItemId?: string;
  /** Present for typed messages; spoken audio starts empty. */
  initialText?: string;
}

export function orderTurns(current: TurnSlot[], announcement: TurnAnnouncement): TurnSlot[] {
  const existing = current.findIndex((turn) => turn.id === announcement.id);

  if (existing !== -1) {
    const incoming = announcement.initialText ?? "";
    // Never clobber text that has already streamed in.
    if (!incoming || current[existing].text) return current;
    const next = [...current];
    next[existing] = { ...next[existing], text: incoming };
    return next;
  }

  const slot: TurnSlot = {
    id: announcement.id,
    role: announcement.role,
    text: announcement.initialText ?? "",
    status: "streaming",
  };

  const anchor = announcement.previousItemId
    ? current.findIndex((turn) => turn.id === announcement.previousItemId)
    : -1;

  // An unknown anchor must not drop the turn; append instead.
  if (anchor === -1) return [...current, slot];

  const next = [...current];
  next.splice(anchor + 1, 0, slot);
  return next;
}
