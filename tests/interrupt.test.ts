import { describe, expect, it } from "vitest";

import { orderTurns, type TurnSlot } from "@/lib/realtime/turnOrder";
import { revealedText } from "@/lib/realtime/reveal";

/**
 * Models what the hook does when a reply is cut short, so the interrupt
 * contract is pinned down without mounting a WebRTC session.
 *
 * The failure being guarded against: response.cancel is asynchronous, so
 * deltas already in flight keep arriving afterwards and a late
 * response.output_audio_transcript.done carries the FULL transcript. An
 * interrupted reply therefore kept growing, then snapped back to its
 * untruncated text long after newer messages had been added below it.
 */
class TranscriptModel {
  turns: TurnSlot[] = [];
  reveal: Record<string, number> = {};
  private readonly sealed = new Set<string>();

  announce(id: string, role: TurnSlot["role"], previousItemId?: string, initialText?: string) {
    if (this.sealed.has(id)) return;
    this.turns = orderTurns(this.turns, { id, role, previousItemId, initialText });
  }

  /** A transcript delta. */
  append(id: string, delta: string) {
    if (this.sealed.has(id)) return;
    this.turns = this.turns.map((t) => (t.id === id ? { ...t, text: t.text + delta } : t));
  }

  /** The terminal event, which carries the whole transcript. */
  complete(id: string, transcript: string) {
    if (this.sealed.has(id)) return;
    this.turns = this.turns.map((t) =>
      t.id === id ? { ...t, text: transcript, status: "final" } : t,
    );
  }

  setRevealed(id: string, chars: number) {
    this.reveal[id] = chars;
  }

  interrupt() {
    const targets = this.turns.filter(
      (t) =>
        t.role === "assistant" &&
        !this.sealed.has(t.id) &&
        (this.reveal[t.id] ?? 0) < t.text.length,
    );
    for (const t of targets) {
      this.sealed.add(t.id);
      const spoken = revealedText(t.text, this.reveal[t.id] ?? 0);
      this.turns = this.turns.map((x) =>
        x.id === t.id ? { ...x, text: spoken, status: "final" } : x,
      );
      this.reveal[t.id] = spoken.length;
    }
  }

  get rendered() {
    return this.turns.filter((t) => t.text.trim().length > 0).map((t) => [t.role, t.text] as const);
  }
}

describe("interrupting a reply", () => {
  function conversationInterruptedMidReply() {
    const model = new TranscriptModel();
    model.announce("u1", "user", undefined);
    model.complete("u1", "What is the revenue?");
    model.announce("a1", "assistant", "u1");
    model.append("a1", "Revenue grew twelve percent and ");
    model.setRevealed("a1", 15); // "Revenue grew tw"
    return model;
  }

  it("trims the reply to what was actually spoken", () => {
    const model = conversationInterruptedMidReply();
    model.interrupt();

    expect(model.turns.find((t) => t.id === "a1")?.text).toBe("Revenue grew tw");
  });

  it("ignores deltas that arrive after the interrupt", () => {
    const model = conversationInterruptedMidReply();
    model.interrupt();
    model.append("a1", "margins improved as well.");

    expect(model.turns.find((t) => t.id === "a1")?.text).toBe("Revenue grew tw");
  });

  it("ignores a late done event carrying the full transcript", () => {
    const model = conversationInterruptedMidReply();
    model.interrupt();
    // This is what previously made an old bubble refill itself.
    model.complete("a1", "Revenue grew twelve percent and margins improved as well.");

    expect(model.turns.find((t) => t.id === "a1")?.text).toBe("Revenue grew tw");
  });

  it("marks the interrupted turn final", () => {
    const model = conversationInterruptedMidReply();
    model.interrupt();

    expect(model.turns.find((t) => t.id === "a1")?.status).toBe("final");
  });

  it("leaves no reveal work outstanding for the trimmed turn", () => {
    const model = conversationInterruptedMidReply();
    model.interrupt();

    const turn = model.turns.find((t) => t.id === "a1")!;
    expect(model.reveal.a1).toBe(turn.text.length);
  });

  it("keeps order intact when the conversation continues after an interrupt", () => {
    const model = conversationInterruptedMidReply();
    model.interrupt();

    model.announce("u2", "user", "a1");
    model.announce("a2", "assistant", "u2");
    model.append("a2", "Margins improved.");
    model.setRevealed("a2", 99);
    // Stale traffic from the cancelled reply lands only now.
    model.append("a1", " and margins improved as well.");
    model.complete("u2", "And margins?");

    expect(model.rendered).toEqual([
      ["user", "What is the revenue?"],
      ["assistant", "Revenue grew tw"],
      ["user", "And margins?"],
      ["assistant", "Margins improved."],
    ]);
  });

  it("does not resurrect a sealed turn if the server re-announces it", () => {
    const model = conversationInterruptedMidReply();
    model.interrupt();
    model.announce("a1", "assistant", "u1", "some replacement text");

    expect(model.turns.find((t) => t.id === "a1")?.text).toBe("Revenue grew tw");
  });

  it("is a no-op when nothing is mid-speech", () => {
    const model = new TranscriptModel();
    model.announce("u1", "user", undefined);
    model.complete("u1", "A question");
    const before = model.rendered;

    model.interrupt();

    expect(model.rendered).toEqual(before);
  });

  it("leaves a fully spoken reply untouched", () => {
    const model = new TranscriptModel();
    model.announce("a1", "assistant", undefined);
    model.append("a1", "All of it was said.");
    model.setRevealed("a1", 99);

    model.interrupt();

    expect(model.turns[0].text).toBe("All of it was said.");
  });
});
