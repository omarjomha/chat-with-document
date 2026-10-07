import { describe, expect, it } from "vitest";

import {
  advanceReveal,
  hasPendingReveal,
  revealedText,
  SPEECH_CHARS_PER_SECOND,
} from "@/lib/realtime/reveal";

describe("advanceReveal", () => {
  it("advances at the configured rate", () => {
    expect(advanceReveal(0, 1000, 1000, 10)).toBe(10);
    expect(advanceReveal(0, 1000, 500, 10)).toBe(5);
  });

  it("accumulates from the current position", () => {
    expect(advanceReveal(20, 1000, 1000, 10)).toBe(30);
  });

  it("never reveals more than has been received", () => {
    expect(advanceReveal(0, 5, 10_000, 100)).toBe(5);
  });

  it("stays put when no time has passed", () => {
    expect(advanceReveal(12, 100, 0)).toBe(12);
  });

  it("does not go backwards on a negative elapsed time", () => {
    expect(advanceReveal(12, 100, -500)).toBe(12);
  });

  it("clamps an over-large cursor down to what was received", () => {
    // Can happen if a turn's text is replaced by a shorter final transcript.
    expect(advanceReveal(50, 10, 0)).toBe(10);
  });

  it("reveals nothing when no text has arrived yet", () => {
    expect(advanceReveal(0, 0, 1000)).toBe(0);
  });

  it("accumulates fractional characters across small ticks", () => {
    // At 18 chars/sec a 50ms tick is 0.9 characters, so a single tick must not
    // round down to zero progress or the reveal would never move.
    let revealed = 0;
    for (let i = 0; i < 10; i += 1) {
      revealed = advanceReveal(revealed, 1000, 50);
    }
    expect(revealed).toBeCloseTo(9, 5);
  });

  it("uses a default rate in a plausible speech range", () => {
    // ~120-220 wpm at roughly 6.5 chars per word.
    expect(SPEECH_CHARS_PER_SECOND).toBeGreaterThan(12);
    expect(SPEECH_CHARS_PER_SECOND).toBeLessThan(25);
  });
});

describe("revealedText", () => {
  it("slices to whole characters only", () => {
    expect(revealedText("hello world", 4.9)).toBe("hell");
  });

  it("returns nothing at a zero cursor", () => {
    expect(revealedText("hello", 0)).toBe("");
  });

  it("returns the whole string once the cursor passes its length", () => {
    expect(revealedText("hello", 99)).toBe("hello");
  });
});

describe("hasPendingReveal", () => {
  const assistant = { id: "a", role: "assistant", text: "hello there" };

  it("is true when an assistant turn is not fully revealed", () => {
    expect(hasPendingReveal([assistant], { a: 3 })).toBe(true);
  });

  it("is false once the assistant turn is fully revealed", () => {
    expect(hasPendingReveal([assistant], { a: assistant.text.length })).toBe(false);
  });

  it("treats a missing cursor as nothing revealed yet", () => {
    expect(hasPendingReveal([assistant], {})).toBe(true);
  });

  it("ignores user turns, which are never paced", () => {
    expect(hasPendingReveal([{ id: "u", role: "user", text: "a question" }], {})).toBe(false);
  });

  it("is false for an empty transcript", () => {
    expect(hasPendingReveal([], {})).toBe(false);
  });
});
