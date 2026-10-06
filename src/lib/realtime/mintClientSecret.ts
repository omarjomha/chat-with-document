import "server-only";

import { getServerEnv } from "@/lib/env";
import { buildInstructions, type DocumentContext } from "@/lib/prompt";

const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

/** How long the ephemeral secret stays valid. Short by design. */
const EXPIRES_AFTER_SECONDS = 600;

export interface MintedSecret {
  value: string;
  expiresAt: number;
  model: string;
}

export class RealtimeMintError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RealtimeMintError";
  }
}

/**
 * Exchanges the long-lived server API key for a short-lived client secret that
 * the browser can safely use to negotiate a WebRTC session.
 *
 * Document context is baked into the session instructions here, so the browser
 * never transmits document text to OpenAI itself.
 */
export async function mintClientSecret(
  context: DocumentContext | undefined,
  safetyIdentifier: string,
): Promise<MintedSecret> {
  const env = getServerEnv();

  const response = await fetch(CLIENT_SECRETS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      // Stable, privacy-preserving per-session identifier, per OpenAI guidance.
      "OpenAI-Safety-Identifier": safetyIdentifier,
    },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: EXPIRES_AFTER_SECONDS },
      session: {
        type: "realtime",
        model: env.OPENAI_REALTIME_MODEL,
        instructions: buildInstructions(context),
        audio: {
          input: {
            // Enables user-side transcripts so the UI can show both halves of
            // the conversation, which the spec requires.
            transcription: { model: "whisper-1" },
            noise_reduction: { type: "near_field" },
            turn_detection: { type: "server_vad", create_response: true },
          },
          output: { voice: env.OPENAI_REALTIME_VOICE },
        },
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // Deliberately not echoing the upstream body to the client; log it instead.
    console.error("[realtime] client_secrets failed", response.status, detail.slice(0, 500));
    throw new RealtimeMintError(
      response.status === 401
        ? "OpenAI rejected the API key."
        : "Could not start a realtime session upstream.",
      response.status === 401 ? 500 : 502,
    );
  }

  const payload: unknown = await response.json();
  const value = extractSecret(payload);
  if (!value) {
    console.error(
      "[realtime] unexpected client_secrets shape",
      JSON.stringify(payload).slice(0, 500),
    );
    throw new RealtimeMintError("Unexpected response from OpenAI.", 502);
  }

  return {
    value,
    expiresAt: Date.now() + EXPIRES_AFTER_SECONDS * 1000,
    model: env.OPENAI_REALTIME_MODEL,
  };
}

/**
 * The secret has moved position across API revisions, so accept the documented
 * shape first and fall back to known variants rather than hard-failing.
 */
function extractSecret(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const root = payload as Record<string, unknown>;

  if (typeof root.value === "string") return root.value;

  const nested = root.client_secret;
  if (typeof nested === "object" && nested !== null) {
    const inner = (nested as Record<string, unknown>).value;
    if (typeof inner === "string") return inner;
  }

  return undefined;
}
