/** Spec: PDF uploads are capped at 25 MB. */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

/**
 * Blob folder for PDFs between upload and extraction.
 *
 * The ingest route reads and then deletes whatever pathname the browser names,
 * so it must be confined to this folder; otherwise a crafted request could
 * point it at a stored session or a cached transcript and delete that instead.
 */
export const PDF_UPLOAD_PREFIX = "uploads/";

/**
 * How long an uploaded PDF may sit unextracted before the sweep removes it.
 * Extraction normally follows within seconds; a leftover means the browser
 * went away between the two steps, leaving the user's file behind.
 */
export const STAGED_UPLOAD_TTL_MS = 60 * 60 * 1000;

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

/**
 * How long an ingested document stays usable.
 *
 * Checked on read, so an expired session is unusable the moment it lapses --
 * independent of when its file is physically removed. Vercel Blob has no TTL
 * or lifecycle feature, so deletion is entirely our responsibility.
 */
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * How long a fetched YouTube transcript stays cached.
 *
 * Far longer than SESSION_TTL_MS, and deliberately so: captions for a published
 * video do not change, and the cached text is public content rather than the
 * user's own upload, so it carries none of the privacy weight that keeps
 * sessions short-lived. The length is set by what it protects against -- YouTube
 * blocking the server's whole network for "automated queries", which lasts
 * hours -- so a week of not re-asking for the same video is the point.
 */
export const TRANSCRIPT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-client allowance for minting Realtime sessions.
 *
 * Every mint opens a billed session, which makes this the endpoint worth
 * abusing. Ten in ten minutes covers a real user starting, stopping and
 * starting again, plus a few automatic reconnects on a poor network, while
 * capping what one script in a loop can spend.
 */
export const TOKEN_RATE_LIMIT = { limit: 10, windowMs: 10 * 60 * 1000 } as const;

/**
 * Per-client allowance for ingesting a document.
 *
 * For YouTube this protects the server's IP reputation as much as its CPU:
 * YouTube blocks a whole network for hours after a few dozen requests, so one
 * visitor pasting links in a loop could take the feature down for everyone.
 */
export const INGEST_RATE_LIMIT = { limit: 10, windowMs: 10 * 60 * 1000 } as const;
