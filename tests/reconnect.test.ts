import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  connectRealtime,
  isRetryableConnectError,
  MicrophoneUnavailableError,
  TokenRequestError,
} from "@/lib/realtime/client";
import {
  ConnectionWatchdog,
  historyReplayEvents,
  reconnectDelay,
  RECONNECT_DELAYS_MS,
} from "@/lib/realtime/reconnect";
import type { TurnSlot } from "@/lib/realtime/turnOrder";

describe("reconnectDelay", () => {
  it("backs off between attempts", () => {
    const delays = RECONNECT_DELAYS_MS.map((_, attempt) => reconnectDelay(attempt) ?? 0);

    for (let i = 1; i < delays.length; i += 1) expect(delays[i]).toBeGreaterThan(delays[i - 1]);
  });

  it("gives up after the last scheduled attempt", () => {
    expect(reconnectDelay(RECONNECT_DELAYS_MS.length)).toBeUndefined();
  });
});

describe("historyReplayEvents", () => {
  const turn = (id: string, role: TurnSlot["role"], text: string): TurnSlot => ({
    id,
    role,
    text,
    status: "final",
  });

  it("replays each turn as an item with its original id and the right content type", () => {
    const events = historyReplayEvents([
      turn("item_1", "user", "What is the deadline?"),
      turn("item_2", "assistant", "Seven business days."),
    ]);

    expect(events).toEqual([
      {
        type: "conversation.item.create",
        item: {
          id: "item_1",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "What is the deadline?" }],
        },
      },
      {
        type: "conversation.item.create",
        item: {
          id: "item_2",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Seven business days." }],
        },
      },
    ]);
  });

  it("never asks for a response, so the model does not speak up unprompted", () => {
    const events = historyReplayEvents([turn("item_1", "user", "hello")]);

    expect(events.every((event) => event.type === "conversation.item.create")).toBe(true);
  });

  it("skips turns with no text, such as speech never transcribed", () => {
    const events = historyReplayEvents([
      turn("item_1", "user", "  "),
      turn("item_2", "user", "hi"),
    ]);

    expect(events).toHaveLength(1);
  });

  it("keeps the newest turns, in order, when the history is over budget", () => {
    const events = historyReplayEvents(
      [turn("old", "user", "a".repeat(10)), turn("mid", "user", "bbbb"), turn("new", "user", "cc")],
      8,
    );

    expect(events.map((event) => event.item.id)).toEqual(["mid", "new"]);
  });

  it("returns nothing for an empty conversation", () => {
    expect(historyReplayEvents([])).toEqual([]);
  });
});

describe("ConnectionWatchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function watch() {
    const callbacks = { onLive: vi.fn(), onRecovering: vi.fn(), onLost: vi.fn() };
    const watchdog = new ConnectionWatchdog(callbacks, 5_000, 15_000);
    watchdog.start();
    return { watchdog, ...callbacks };
  }

  it("reports live once connected", () => {
    const { watchdog, onLive } = watch();

    watchdog.update("connected");

    expect(onLive).toHaveBeenCalledOnce();
  });

  it("gives a dropped connection time to heal before declaring it lost", () => {
    const { watchdog, onRecovering, onLost } = watch();
    watchdog.update("connected");

    watchdog.update("disconnected");
    vi.advanceTimersByTime(4_999);

    expect(onRecovering).toHaveBeenCalledOnce();
    expect(onLost).not.toHaveBeenCalled();
  });

  it("does nothing more when the connection heals inside the grace period", () => {
    const { watchdog, onLive, onLost } = watch();
    watchdog.update("connected");

    watchdog.update("disconnected");
    vi.advanceTimersByTime(3_000);
    watchdog.update("connected");
    vi.advanceTimersByTime(60_000);

    expect(onLive).toHaveBeenCalledTimes(2);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("declares the connection lost when the grace period runs out", () => {
    const { watchdog, onLost } = watch();
    watchdog.update("connected");

    watchdog.update("disconnected");
    vi.advanceTimersByTime(5_000);

    expect(onLost).toHaveBeenCalledWith("disconnected");
  });

  it("does not restart the grace period on repeated disconnected reports", () => {
    const { watchdog, onLost } = watch();
    watchdog.update("connected");

    watchdog.update("disconnected");
    vi.advanceTimersByTime(4_000);
    watchdog.update("disconnected");
    vi.advanceTimersByTime(1_000);

    expect(onLost).toHaveBeenCalledOnce();
  });

  it("declares a failed connection lost at once", () => {
    const { watchdog, onLost } = watch();

    watchdog.update("failed");

    expect(onLost).toHaveBeenCalledWith("failed");
  });

  it("times out a connection that never connects", () => {
    const { onLost } = watch();

    vi.advanceTimersByTime(15_000);

    expect(onLost).toHaveBeenCalledWith("timeout");
  });

  it("treats a closed data channel as lost", () => {
    const { watchdog, onLost } = watch();
    watchdog.update("connected");

    watchdog.channelClosed();

    expect(onLost).toHaveBeenCalledWith("channel-closed");
  });

  it("reports a loss only once", () => {
    const { watchdog, onLost } = watch();

    watchdog.update("failed");
    watchdog.channelClosed();
    vi.advanceTimersByTime(60_000);

    expect(onLost).toHaveBeenCalledOnce();
  });

  it("stays silent after being stopped", () => {
    const { watchdog, onLost, onLive } = watch();

    watchdog.stop();
    watchdog.update("connected");
    watchdog.update("failed");
    vi.advanceTimersByTime(60_000);

    expect(onLive).not.toHaveBeenCalled();
    expect(onLost).not.toHaveBeenCalled();
  });
});

describe("isRetryableConnectError", () => {
  it.each([
    ["a network failure", new TypeError("Failed to fetch"), true],
    ["a server fault minting the token", new TokenRequestError("boom", 502), true],
    ["an upstream handshake failure", new Error("Realtime handshake failed (503)."), true],
    ["an expired document", new TokenRequestError("expired", 404), false],
    ["the rate limit", new TokenRequestError("slow down", 429), false],
    ["a refused microphone", new MicrophoneUnavailableError("denied"), false],
  ])("treats %s as retryable: %s", (_label, error, expected) => {
    expect(isRetryableConnectError(error)).toBe(expected);
  });
});

/* ------------------------------------------------------------------ */
/* connectRealtime against a fake peer connection                      */
/* ------------------------------------------------------------------ */

class FakeDataChannel {
  readyState = "connecting";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
}

class FakePeerConnection {
  static last: FakePeerConnection;
  connectionState: RTCPeerConnectionState = "new";
  channel = new FakeDataChannel();
  closed = false;
  ontrack: unknown = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor() {
    FakePeerConnection.last = this;
  }
  addTrack() {}
  addTransceiver() {}
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0 offer" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() {
    this.closed = true;
  }
  /** Test helper: move to a state and notify, as the browser would. */
  become(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

describe("connectRealtime", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function options() {
    return {
      tokenEndpoint: "/api/realtime/token",
      audioElement: document.createElement("audio"),
      onEvent: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn(),
      onConnectionLost: vi.fn(),
    };
  }

  function answerHandshake() {
    fetchMock
      .mockResolvedValueOnce(Response.json({ value: "ek_test", model: "m" }))
      .mockResolvedValueOnce(new Response("v=0 answer"));
  }

  it("closes the peer connection when the token request is refused", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "Too many requests." }, { status: 429 }),
    );

    await expect(connectRealtime(options())).rejects.toMatchObject({
      name: "TokenRequestError",
      status: 429,
      message: "Too many requests.",
    });
    expect(FakePeerConnection.last.closed).toBe(true);
  });

  it("closes the peer connection when the SDP exchange fails", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ value: "ek_test" }))
      .mockResolvedValueOnce(new Response("nope", { status: 503 }));

    await expect(connectRealtime(options())).rejects.toThrow(/handshake failed \(503\)/);
    expect(FakePeerConnection.last.closed).toBe(true);
  });

  it("reports live, then a drop, then the loss, cleaning up before the caller hears", async () => {
    answerHandshake();
    const opts = options();
    await connectRealtime(opts);
    const pc = FakePeerConnection.last;

    pc.become("connected");
    expect(opts.onStateChange).toHaveBeenLastCalledWith("live");

    pc.become("disconnected");
    expect(opts.onStateChange).toHaveBeenLastCalledWith("reconnecting");

    opts.onConnectionLost.mockImplementation(() => expect(pc.closed).toBe(true));
    vi.advanceTimersByTime(10_000);
    expect(opts.onConnectionLost).toHaveBeenCalledWith("disconnected");
  });

  it("does not report a loss for a connection the caller closed", async () => {
    answerHandshake();
    const opts = options();
    const handle = await connectRealtime(opts);
    const pc = FakePeerConnection.last;
    pc.become("connected");

    handle.close();
    pc.become("failed");
    pc.channel.onclose?.();
    vi.advanceTimersByTime(60_000);

    expect(opts.onConnectionLost).not.toHaveBeenCalled();
  });

  it("queues events until the data channel opens", async () => {
    answerHandshake();
    const handle = await connectRealtime(options());
    const { channel } = FakePeerConnection.last;

    handle.send({ type: "response.cancel" });
    expect(channel.sent).toEqual([]);

    channel.readyState = "open";
    channel.onopen?.();
    expect(channel.sent).toEqual([JSON.stringify({ type: "response.cancel" })]);
  });
});
