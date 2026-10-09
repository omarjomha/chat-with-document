/**
 * Paces the assistant's transcript so it tracks the spoken audio instead of
 * racing ahead of it.
 *
 * Why this is needed: OpenAI generates text and audio in parallel, and
 * transcript deltas arrive at generation speed while audio plays at speech
 * speed. The API exposes no word-level timing, so the whole reply would
 * otherwise appear before the voice had said much of it.
 *
 * Why there is no early flush: `response.done` signals that *generation*
 * finished, not that *playback* did -- it fires well before the voice stops.
 * Flushing there would dump the remaining text early and reintroduce the very
 * problem this solves. The reveal simply runs at a steady rate until it catches
 * up with the text received.
 *
 * Why a constant rate is defensible: the model's voice speaks at a consistent
 * pace (audio.output.speed defaults to 1.0), so speech rate is predictable in a
 * way that, say, a human speaker's would not be.
 */

/**
 * Reveal rate in characters per second.
 *
 * Around 165 wpm at roughly 6.5 characters per word including the space. Tuned
 * slightly fast on purpose: if the estimate is off, text drifting a little
 * *ahead* of the voice reads like ordinary captions, whereas text lagging
 * *behind* what you can already hear feels broken.
 */
export const SPEECH_CHARS_PER_SECOND = 18;

/** Advances a reveal cursor, never past what has actually been received. */
export function advanceReveal(
  revealed: number,
  receivedLength: number,
  elapsedMs: number,
  charsPerSecond: number = SPEECH_CHARS_PER_SECOND,
): number {
  if (receivedLength <= 0) return 0;
  if (elapsedMs <= 0) return Math.min(revealed, receivedLength);

  const advanced = revealed + (charsPerSecond * elapsedMs) / 1000;
  return Math.min(advanced, receivedLength);
}

/**
 * Slices text to the reveal cursor. The cursor is tracked as a float so slow
 * rates still accumulate across ticks; only whole characters are shown.
 */
export function revealedText(text: string, revealed: number): string {
  return text.slice(0, Math.floor(revealed));
}

/**
 * The one assistant turn whose reveal may advance right now: the earliest that
 * has not finished being spoken.
 *
 * The voice plays replies one after another, never together, so the text must
 * do the same. Advancing every turn at once printed a queued second reply
 * while the first was still being read out.
 *
 * A turn still streaming holds the floor even when its cursor has caught up
 * with the text received so far: more of it is coming, and its audio is still
 * ahead of anything queued behind it.
 */
export function speakingTurnId(
  turns: ReadonlyArray<{ id: string; role: string; text: string; status: string }>,
  reveal: Readonly<Record<string, number>>,
): string | undefined {
  return turns.find(
    (turn) =>
      turn.role === "assistant" &&
      ((reveal[turn.id] ?? 0) < turn.text.length || turn.status === "streaming"),
  )?.id;
}

/** True when any revealing is still outstanding, used to gate the timer. */
export function hasPendingReveal(
  turns: ReadonlyArray<{ id: string; role: string; text: string }>,
  reveal: Readonly<Record<string, number>>,
): boolean {
  return turns.some(
    (turn) => turn.role === "assistant" && (reveal[turn.id] ?? 0) < turn.text.length,
  );
}
