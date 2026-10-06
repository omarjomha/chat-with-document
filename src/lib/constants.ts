/** Spec: PDF uploads are capped at 25 MB. */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

/**
 * Upper bound on document characters injected into the Realtime session.
 *
 * gpt-realtime-2.1 has a 128k-token context window. At a conservative ~4 chars
 * per token, 360k chars is roughly 90k tokens, leaving ~38k for the system
 * preamble, the spoken conversation, and model output.
 *
 * The spec explicitly waives chunking and summarisation, so anything beyond
 * this is truncated and the user is told so in the UI.
 */
export const MAX_CONTEXT_CHARS = 360_000;

/** Rough chars-per-token ratio used only for user-facing estimates. */
export const APPROX_CHARS_PER_TOKEN = 4;
