import { parseServerEvent, type RealtimeClientEvent, type RealtimeServerEvent } from "./events";
import { ConnectionWatchdog, type ConnectionLossReason } from "./reconnect";

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export type ConnectionState =
  "idle" | "requesting-mic" | "connecting" | "live" | "reconnecting" | "closed" | "error";

export interface RealtimeSessionHandle {
  send(event: RealtimeClientEvent): void;
  /** Tears the connection down. The microphone belongs to the caller and is left alone. */
  close(): void;
}

export interface ConnectOptions {
  /** Our backend route that mints the ephemeral secret. */
  tokenEndpoint: string;
  sessionId?: string;
  /** Element the model's audio is piped into. */
  audioElement: HTMLAudioElement;
  /**
   * Microphone to send, or undefined to connect receive-only (text mode).
   *
   * Owned by the caller so it survives a reconnect: asking for it again would
   * mean a second permission prompt on some browsers, mid-conversation, and
   * mute is a property of the track, so a reused track stays muted.
   */
  microphone?: MediaStream;
  onEvent(event: RealtimeServerEvent): void;
  /** Reports connecting, live and reconnecting. Never reports a loss; see onConnectionLost. */
  onStateChange(state: ConnectionState): void;
  onError(message: string): void;
  /**
   * The connection is gone and will not recover by itself. Already cleaned up
   * by the time this fires; the caller decides whether to rebuild.
   */
  onConnectionLost(reason: ConnectionLossReason): void;
}

/** The token route refused; `status` decides whether retrying could help. */
export class TokenRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TokenRequestError";
  }
}

export class MicrophoneUnavailableError extends Error {
  constructor(readonly reason: "denied" | "missing" | "insecure-context" | "unknown") {
    super(`Microphone unavailable: ${reason}`);
    this.name = "MicrophoneUnavailableError";
  }
}

/** Distinguishes "user said no" from "no device" from "not HTTPS". */
export async function requestMicrophone(): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    // getUserMedia is absent on insecure origins, which is the usual cause on
    // a phone hitting an http:// LAN address.
    throw new MicrophoneUnavailableError(
      typeof window !== "undefined" && !window.isSecureContext ? "insecure-context" : "missing",
    );
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new MicrophoneUnavailableError("denied");
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      throw new MicrophoneUnavailableError("missing");
    }
    throw new MicrophoneUnavailableError("unknown");
  }
}

interface EphemeralToken {
  value: string;
  model: string;
}

async function fetchEphemeralToken(
  tokenEndpoint: string,
  sessionId: string | undefined,
): Promise<EphemeralToken> {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sessionId ? { sessionId } : {}),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : "Could not start a session.";
    throw new TokenRequestError(message, response.status);
  }

  const token = payload as { value?: unknown; model?: unknown } | null;
  if (!token || typeof token.value !== "string") {
    throw new Error("Server returned an invalid session token.");
  }

  return { value: token.value, model: typeof token.model === "string" ? token.model : "" };
}

export async function connectRealtime(options: ConnectOptions): Promise<RealtimeSessionHandle> {
  const { audioElement, microphone, onEvent, onStateChange, onError, onConnectionLost } = options;

  onStateChange("connecting");

  const pc = new RTCPeerConnection({
    // Two servers, so one being unreachable from a given network is not fatal.
    iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
  });

  let closed = false;
  const watchdog = new ConnectionWatchdog({
    onLive: () => onStateChange("live"),
    onRecovering: () => onStateChange("reconnecting"),
    onLost: (reason) => {
      cleanup();
      onConnectionLost(reason);
    },
  });

  const cleanup = () => {
    if (closed) return;
    closed = true;
    watchdog.stop();
    try {
      pc.close();
    } catch {
      /* already closed */
    }
  };

  // Model audio -> <audio> element.
  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream) {
      audioElement.srcObject = stream;
      // Autoplay can still be refused; the caller starts this from a user
      // gesture, which is what satisfies iOS Safari.
      void audioElement.play().catch(() => {
        onError("Your browser blocked the audio. Tap the conversation area to turn it on.");
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (!closed) watchdog.update(pc.connectionState);
  };

  if (microphone) {
    for (const track of microphone.getTracks()) {
      pc.addTrack(track, microphone);
    }
  } else {
    // Text-only mode still needs to receive the model's audio.
    pc.addTransceiver("audio", { direction: "recvonly" });
  }

  const channel = pc.createDataChannel("oai-events");
  const queued: RealtimeClientEvent[] = [];

  channel.onopen = () => {
    while (queued.length > 0) {
      const event = queued.shift();
      if (event) channel.send(JSON.stringify(event));
    }
  };

  // A channel can die while the peer still reports connected, and nothing
  // typed or spoken would reach the model after that.
  channel.onclose = () => {
    if (!closed) watchdog.channelClosed();
  };

  channel.onmessage = (message: MessageEvent<string>) => {
    const event = parseServerEvent(message.data);
    if (!event) return;
    if (event.type === "error") {
      const detail = (event as { error?: { message?: string } }).error;
      onError(detail?.message ?? "The realtime session reported an error.");
    }
    onEvent(event);
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const token = await fetchEphemeralToken(options.tokenEndpoint, options.sessionId);

    const sdpResponse = await fetch(CALLS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.value}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
    });

    if (!sdpResponse.ok) {
      const detail = await sdpResponse.text().catch(() => "");
      throw new Error(
        `Realtime handshake failed (${sdpResponse.status}). ${detail.slice(0, 200)}`.trim(),
      );
    }

    const answerSdp = await sdpResponse.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  } catch (error) {
    // Previously a failed token request leaked the peer connection.
    cleanup();
    throw error;
  }

  watchdog.start();

  return {
    send(event) {
      if (channel.readyState === "open") {
        channel.send(JSON.stringify(event));
      } else {
        queued.push(event);
      }
    },
    close() {
      cleanup();
    },
  };
}

/** Whether a failed connection attempt is worth making again unchanged. */
export function isRetryableConnectError(error: unknown): boolean {
  if (error instanceof MicrophoneUnavailableError) return false;
  // A 4xx from our own route is a decision, not a fault: an expired document,
  // a rate limit, a bad request. Retrying would get the same answer, and for
  // the rate limit would only dig the hole deeper.
  if (error instanceof TokenRequestError) return error.status >= 500;
  // Network failures, an upstream handshake error: plausibly transient.
  return true;
}
