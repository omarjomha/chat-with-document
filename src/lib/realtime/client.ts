import { parseServerEvent, type RealtimeClientEvent, type RealtimeServerEvent } from "./events";

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export type ConnectionState =
  "idle" | "requesting-mic" | "connecting" | "live" | "reconnecting" | "closed" | "error";

export interface RealtimeSessionHandle {
  send(event: RealtimeClientEvent): void;
  /** Returns the new muted state. No-op in text-only mode. */
  setMuted(muted: boolean): void;
  close(): void;
  readonly hasMicrophone: boolean;
}

export interface ConnectOptions {
  /** Our backend route that mints the ephemeral secret. */
  tokenEndpoint: string;
  sessionId?: string;
  /** Element the model's audio is piped into. */
  audioElement: HTMLAudioElement;
  /** When false, connect receive-only (text fallback mode). */
  useMicrophone: boolean;
  onEvent(event: RealtimeServerEvent): void;
  onStateChange(state: ConnectionState): void;
  onError(message: string): void;
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
    throw new Error(message);
  }

  const token = payload as { value?: unknown; model?: unknown } | null;
  if (!token || typeof token.value !== "string") {
    throw new Error("Server returned an invalid session token.");
  }

  return { value: token.value, model: typeof token.model === "string" ? token.model : "" };
}

export async function connectRealtime(options: ConnectOptions): Promise<RealtimeSessionHandle> {
  const { audioElement, onEvent, onStateChange, onError } = options;

  let micStream: MediaStream | undefined;
  let hasMicrophone = false;

  if (options.useMicrophone) {
    onStateChange("requesting-mic");
    micStream = await requestMicrophone();
    hasMicrophone = true;
  }

  onStateChange("connecting");

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    micStream?.getTracks().forEach((track) => track.stop());
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
        onError("Tap the page to enable audio playback.");
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (closed) return;
    switch (pc.connectionState) {
      case "connected":
        onStateChange("live");
        break;
      case "disconnected":
        onStateChange("reconnecting");
        break;
      case "failed":
        onStateChange("error");
        onError("Connection lost. Check your network and start a new session.");
        cleanup();
        break;
      case "closed":
        onStateChange("closed");
        break;
      default:
        break;
    }
  };

  if (micStream) {
    for (const track of micStream.getTracks()) {
      pc.addTrack(track, micStream);
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

  channel.onmessage = (message: MessageEvent<string>) => {
    const event = parseServerEvent(message.data);
    if (!event) return;
    if (event.type === "error") {
      const detail = (event as { error?: { message?: string } }).error;
      onError(detail?.message ?? "The realtime session reported an error.");
    }
    onEvent(event);
  };

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
    cleanup();
    throw new Error(
      `Realtime handshake failed (${sdpResponse.status}). ${detail.slice(0, 200)}`.trim(),
    );
  }

  const answerSdp = await sdpResponse.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  return {
    send(event) {
      if (channel.readyState === "open") {
        channel.send(JSON.stringify(event));
      } else {
        queued.push(event);
      }
    },
    setMuted(muted) {
      micStream?.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    },
    close() {
      cleanup();
      onStateChange("closed");
    },
    get hasMicrophone() {
      return hasMicrophone;
    },
  };
}
