import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DISCONNECT_GRACE_MS } from "@/lib/realtime/reconnect";
import { SPEECH_CHARS_PER_SECOND } from "@/lib/realtime/reveal";
import { useRealtimeSession } from "@/lib/realtime/useRealtimeSession";

/*
 * The network dropping mid-answer, end to end through the hook.
 *
 * Transcript text arrives at generation speed and is revealed locally at
 * speech speed, so when the network goes the whole reply is already here while
 * the voice stops at once. The transcript must stop with the voice, rather
 * than printing on through a reply nobody heard.
 */

class FakeDataChannel {
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  send() {}
}

class FakePeerConnection {
  static all: FakePeerConnection[] = [];
  connectionState: RTCPeerConnectionState = "new";
  channel = new FakeDataChannel();
  ontrack: unknown = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor() {
    FakePeerConnection.all.push(this);
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
  close() {}
  become(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
  receive(event: object) {
    this.channel.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
  }
}

const REPLY =
  "The report covers three quarters of revenue, and the second quarter was the strongest by a wide margin.";

describe("a network drop mid-answer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakePeerConnection.all = [];
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    // Every handshake succeeds, so a rebuild after the loss can complete.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/api/realtime/token")
          ? Response.json({ value: "ek_test", model: "m" })
          : new Response("v=0 answer"),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function liveSessionMidReply() {
    const audioRef = { current: document.createElement("audio") };
    const hook = renderHook(() => useRealtimeSession({ audioRef }));

    await act(() => hook.result.current.start(false));
    const pc = FakePeerConnection.all[0];
    act(() => pc.become("connected"));
    expect(hook.result.current.state).toBe("live");

    // The whole reply arrives at once, as generation outruns speech.
    act(() => {
      pc.receive({
        type: "conversation.item.added",
        item: { id: "a1", type: "message", role: "assistant", content: [] },
      });
      pc.receive({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: REPLY });
      pc.receive({
        type: "response.output_audio_transcript.done",
        item_id: "a1",
        transcript: REPLY,
      });
      pc.receive({ type: "response.done" });
    });

    // A second of speech: about one second's worth of text is showing.
    act(() => vi.advanceTimersByTime(1_000));
    const shown = assistantText(hook.result.current.turns);
    expect(shown.length).toBeGreaterThan(SPEECH_CHARS_PER_SECOND / 2);
    expect(shown.length).toBeLessThan(REPLY.length);

    return { hook, pc, shown };
  }

  it("shows reconnecting and stops the transcript the moment the browser goes offline", async () => {
    const { hook, shown } = await liveSessionMidReply();

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(hook.result.current.state).toBe("reconnecting");

    act(() => vi.advanceTimersByTime(DISCONNECT_GRACE_MS - 100));
    expect(assistantText(hook.result.current.turns)).toBe(shown);
    // Nothing is playing, so there is nothing to interrupt.
    expect(hook.result.current.modelSpeaking).toBe(false);
  });

  it("stops the transcript when ICE reports the drop, too", async () => {
    const { hook, pc, shown } = await liveSessionMidReply();

    act(() => pc.become("disconnected"));
    expect(hook.result.current.state).toBe("reconnecting");

    act(() => vi.advanceTimersByTime(3_000));
    expect(assistantText(hook.result.current.turns)).toBe(shown);
  });

  it("keeps only what was heard once the connection is given up and rebuilt", async () => {
    const { hook, shown } = await liveSessionMidReply();

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    await act(() => vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS + 2_000));

    // The rebuilt connection comes up; the cut reply does not grow back.
    act(() => FakePeerConnection.all.at(-1)?.become("connected"));
    expect(hook.result.current.state).toBe("live");
    act(() => vi.advanceTimersByTime(10_000));
    expect(assistantText(hook.result.current.turns)).toBe(shown);
  });

  it("resumes the reveal when the connection heals by itself", async () => {
    const { hook, pc, shown } = await liveSessionMidReply();

    act(() => pc.become("disconnected"));
    act(() => vi.advanceTimersByTime(2_000));
    act(() => pc.become("connected"));
    act(() => vi.advanceTimersByTime(1_000));

    const resumed = assistantText(hook.result.current.turns);
    expect(resumed.length).toBeGreaterThan(shown.length);
    expect(REPLY.startsWith(resumed)).toBe(true);
  });

  it("keeps only what was heard when the user ends the session mid-answer", async () => {
    const { hook, shown } = await liveSessionMidReply();

    act(() => hook.result.current.stop());
    act(() => vi.advanceTimersByTime(10_000));

    expect(assistantText(hook.result.current.turns)).toBe(shown);
  });
});

function assistantText(turns: ReadonlyArray<{ role: string; text: string }>): string {
  return turns.find((turn) => turn.role === "assistant")?.text ?? "";
}
