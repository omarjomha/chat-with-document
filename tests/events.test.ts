import { describe, expect, it } from "vitest";

import { parseServerEvent, textMessageEvent } from "@/lib/realtime/events";

describe("parseServerEvent", () => {
  it("parses a well-formed event", () => {
    const event = parseServerEvent(JSON.stringify({ type: "response.done", extra: 1 }));

    expect(event?.type).toBe("response.done");
  });

  it("returns undefined for malformed JSON rather than throwing", () => {
    expect(parseServerEvent("{not json")).toBeUndefined();
  });

  it("rejects JSON without a string type discriminator", () => {
    expect(parseServerEvent(JSON.stringify({ noType: true }))).toBeUndefined();
    expect(parseServerEvent(JSON.stringify({ type: 42 }))).toBeUndefined();
  });

  it("passes through unknown event types so protocol drift stays visible", () => {
    const event = parseServerEvent(JSON.stringify({ type: "some.future.event" }));

    expect(event?.type).toBe("some.future.event");
  });
});

describe("textMessageEvent", () => {
  it("creates the item then explicitly requests a response", () => {
    const [create, respond] = textMessageEvent("hello there");

    expect(create.type).toBe("conversation.item.create");
    expect(respond.type).toBe("response.create");
  });

  it("wraps the text as input_text on a user message", () => {
    const [create] = textMessageEvent("hello there");

    expect(create).toMatchObject({
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello there" }],
      },
    });
  });
});
