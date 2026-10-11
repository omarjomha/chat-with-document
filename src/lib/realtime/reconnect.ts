/**
 * Pure pieces of connection recovery, kept apart from the WebRTC plumbing so
 * they can be tested without a peer connection.
 *
 * Recovery happens at two levels. A brief network blip -- a phone switching
 * between wifi and cellular, a lift, a tunnel -- usually heals inside ICE on
 * its own, so a `disconnected` peer is given a grace period before anything is
 * done about it. Past that, the connection is rebuilt from scratch: a fresh
 * token, a fresh peer connection, and the conversation so far replayed into
 * the new session so the model still knows what was said.
 */

import type { RealtimeClientEvent } from "./events";
import type { TurnSlot } from "./turnOrder";

/** How long a `disconnected` peer may take to recover on its own. */
export const DISCONNECT_GRACE_MS = 5_000;

/**
 * How long a new connection may take to reach `connected`.
 *
 * Without this, a network that silently eats STUN leaves the session sitting
 * in "Connecting" forever, since ICE can take a long time to declare failure.
 */
export const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Wait before each rebuild attempt. Four attempts over about fifteen seconds:
 * long enough to ride out a short outage, short enough that the user is not
 * left staring at "Reconnecting" for minutes. No jitter, since each browser
 * reconnects only itself -- there is no herd to spread out.
 */
export const RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

/** Returns the delay before attempt `attempt` (0-based), or undefined to give up. */
export function reconnectDelay(attempt: number): number | undefined {
  return RECONNECT_DELAYS_MS[attempt];
}

/**
 * Upper bound on conversation text replayed into a rebuilt session.
 *
 * The document is already in the session instructions, so the replay only has
 * to restore the thread of conversation. Keeping it short bounds the cost of a
 * flapping connection, which could otherwise re-send a long history many times.
 */
export const REPLAY_MAX_CHARS = 8_000;

/**
 * Re-creates the visible conversation as items in a new session.
 *
 * Each item reuses its original id. The server echoes every created item back
 * through `conversation.item.added`, and with the same id the transcript
 * recognises a turn it already shows instead of rendering it a second time.
 * Newest turns are kept first when the budget runs out, since they are what a
 * follow-up question is most likely to lean on.
 */
export function historyReplayEvents(
  turns: readonly TurnSlot[],
  maxChars: number = REPLAY_MAX_CHARS,
): Extract<RealtimeClientEvent, { type: "conversation.item.create" }>[] {
  const kept: TurnSlot[] = [];
  let budget = maxChars;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const text = turn.text.trim();
    if (!text) continue;
    if (text.length > budget) break;
    budget -= text.length;
    kept.push({ ...turn, text });
  }

  return kept.reverse().map(({ id, role, text }) => ({
    type: "conversation.item.create",
    item:
      role === "user"
        ? { id, type: "message", role, content: [{ type: "input_text", text }] }
        : { id, type: "message", role, content: [{ type: "output_text", text }] },
  }));
}

export type ConnectionLossReason =
  "failed" | "disconnected" | "offline" | "timeout" | "channel-closed";

interface WatchdogCallbacks {
  /** The peer reached `connected`, initially or after recovering. */
  onLive(): void;
  /** The peer dropped and is being given time to recover on its own. */
  onRecovering(): void;
  /** Recovery is not going to happen; the connection must be rebuilt. Fires once. */
  onLost(reason: ConnectionLossReason): void;
}

/**
 * Turns the peer connection's raw state changes into one decision: is this
 * connection still worth waiting for?
 */
export class ConnectionWatchdog {
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private finished = false;

  constructor(
    private readonly callbacks: WatchdogCallbacks,
    private readonly graceMs: number = DISCONNECT_GRACE_MS,
    private readonly connectTimeoutMs: number = CONNECT_TIMEOUT_MS,
  ) {}

  /** Starts the clock on the initial connection. */
  start(): void {
    this.connectTimer = setTimeout(() => this.lose("timeout"), this.connectTimeoutMs);
  }

  update(state: RTCPeerConnectionState): void {
    if (this.finished) return;
    switch (state) {
      case "connected":
        this.clearTimers();
        this.callbacks.onLive();
        break;
      case "disconnected":
        this.callbacks.onRecovering();
        this.graceTimer ??= setTimeout(() => this.lose("disconnected"), this.graceMs);
        break;
      case "failed":
        this.lose("failed");
        break;
      default:
        break;
    }
  }

  /**
   * The browser reported losing its network, as airplane mode or a dead radio
   * does at once.
   *
   * The peer connection only notices from missed ICE consent checks, which
   * takes seconds, and the model's voice has already stopped by then. Treated
   * as a drop with the same grace period, so a connection that rides it out
   * is kept; the browser's `online` event is reported through `update` with
   * the peer's current state, which settles it either way.
   */
  networkOffline(): void {
    if (this.finished) return;
    this.callbacks.onRecovering();
    this.graceTimer ??= setTimeout(() => this.lose("offline"), this.graceMs);
  }

  /** The data channel closed without us closing it. Nothing can be sent now. */
  channelClosed(): void {
    this.lose("channel-closed");
  }

  /** Stops watching, without reporting anything. */
  stop(): void {
    this.finished = true;
    this.clearTimers();
  }

  private lose(reason: ConnectionLossReason): void {
    if (this.finished) return;
    this.stop();
    this.callbacks.onLost(reason);
  }

  private clearTimers(): void {
    clearTimeout(this.graceTimer);
    clearTimeout(this.connectTimer);
    this.graceTimer = undefined;
    this.connectTimer = undefined;
  }
}
