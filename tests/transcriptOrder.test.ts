import { describe, expect, it } from "vitest";

import { orderTurns, type TurnSlot } from "@/lib/realtime/turnOrder";

/**
 * Regression cover for transcript ordering.
 *
 * The original implementation ordered turns by when their text first arrived.
 * Because Whisper transcribes user speech asynchronously, a question's
 * transcript routinely lands after the answer has started streaming, so
 * replies rendered above the questions that prompted them.
 */
describe("orderTurns", () => {
  it("appends an item with no known anchor", () => {
    const slots = orderTurns([], { id: "a", role: "user", previousItemId: undefined });

    expect(slots.map((s) => s.id)).toEqual(["a"]);
  });

  it("places an item directly after its previous_item_id", () => {
    const existing: TurnSlot[] = [
      { id: "a", role: "user", text: "question", status: "final" },
      { id: "c", role: "assistant", text: "later", status: "final" },
    ];

    const slots = orderTurns(existing, { id: "b", role: "assistant", previousItemId: "a" });

    expect(slots.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("appends when the anchor is unknown rather than dropping the item", () => {
    const existing: TurnSlot[] = [{ id: "a", role: "user", text: "q", status: "final" }];

    const slots = orderTurns(existing, { id: "b", role: "assistant", previousItemId: "ghost" });

    expect(slots.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("keeps the user question above its answer even when announced in order", () => {
    let slots: TurnSlot[] = [];
    slots = orderTurns(slots, { id: "user-1", role: "user", previousItemId: undefined });
    slots = orderTurns(slots, { id: "asst-1", role: "assistant", previousItemId: "user-1" });

    expect(slots.map((s) => s.id)).toEqual(["user-1", "asst-1"]);
  });

  it("holds a question's position even though its text arrives after the answer", () => {
    // This is the exact failure: both items are announced first, then the
    // assistant's text streams, and only afterwards does the user's
    // transcription resolve.
    let slots: TurnSlot[] = [];
    slots = orderTurns(slots, { id: "user-1", role: "user", previousItemId: undefined });
    slots = orderTurns(slots, { id: "asst-1", role: "assistant", previousItemId: "user-1" });

    slots = slots.map((s) => (s.id === "asst-1" ? { ...s, text: "The answer." } : s));
    slots = slots.map((s) => (s.id === "user-1" ? { ...s, text: "The question?" } : s));

    expect(slots.map((s) => [s.role, s.text])).toEqual([
      ["user", "The question?"],
      ["assistant", "The answer."],
    ]);
  });

  it("stays ordered across several exchanges", () => {
    let slots: TurnSlot[] = [];
    slots = orderTurns(slots, { id: "u1", role: "user", previousItemId: undefined });
    slots = orderTurns(slots, { id: "a1", role: "assistant", previousItemId: "u1" });
    slots = orderTurns(slots, { id: "u2", role: "user", previousItemId: "a1" });
    slots = orderTurns(slots, { id: "a2", role: "assistant", previousItemId: "u2" });

    expect(slots.map((s) => s.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("ignores a repeat announcement of an item it already holds", () => {
    let slots: TurnSlot[] = [];
    slots = orderTurns(slots, { id: "a", role: "user", previousItemId: undefined });
    slots = orderTurns(slots, { id: "b", role: "assistant", previousItemId: "a" });
    slots = orderTurns(slots, { id: "a", role: "user", previousItemId: undefined });

    expect(slots.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("fills text on re-announcement when the slot is still empty", () => {
    let slots = orderTurns([], { id: "a", role: "user", previousItemId: undefined });
    slots = orderTurns(slots, {
      id: "a",
      role: "user",
      previousItemId: undefined,
      initialText: "typed message",
    });

    expect(slots[0].text).toBe("typed message");
  });

  it("does not overwrite text that has already streamed in", () => {
    let slots = orderTurns([], {
      id: "a",
      role: "assistant",
      previousItemId: undefined,
      initialText: "first",
    });
    slots = orderTurns(slots, {
      id: "a",
      role: "assistant",
      previousItemId: undefined,
      initialText: "second",
    });

    expect(slots[0].text).toBe("first");
  });
});
