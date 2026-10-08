import "server-only";

import { z } from "zod";

/**
 * Server-only environment contract.
 *
 * Importing this module from a Client Component is a build-time error thanks to
 * `server-only`, which is what keeps OPENAI_API_KEY off the client. The spec
 * requires that API keys never reach the browser; this enforces it mechanically
 * rather than by convention.
 */
const serverEnvSchema = z.object({
  OPENAI_API_KEY: z
    .string()
    .min(1, "OPENAI_API_KEY is required. Copy .env.example to .env.local and set it."),
  OPENAI_REALTIME_MODEL: z.string().min(1).default("gpt-realtime-2.1"),
  OPENAI_REALTIME_VOICE: z.string().min(1).default("marin"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid server environment -> ${issues}`);
  }

  cached = parsed.data;
  return cached;
}

/** Test seam: clears the memoised env so tests can vary process.env. */
export function resetServerEnvCache(): void {
  cached = undefined;
}

/**
 * Optional egress prefix for YouTube requests. The target URL is appended
 * percent-encoded, so `https://proxy.example/?url=` becomes
 * `https://proxy.example/?url=https%3A%2F%2Fwww.youtube.com%2F...`.
 *
 * Empty-string handling matters: Vercel surfaces an unset project variable as
 * "" rather than undefined, and a bare `.optional()` would then route every
 * request through a prefix of nothing.
 */
const youtubeProxySchema = z
  .union([z.literal(""), z.url()])
  .optional()
  .transform((value) => value || undefined);

/**
 * Read separately from getServerEnv on purpose.
 *
 * getServerEnv validates the whole contract at once, which is right for the
 * Realtime route -- it cannot work without a key, so failing loudly is correct.
 * But YouTube ingestion needs none of that, and reading it through the same
 * accessor meant a missing OPENAI_API_KEY broke transcript extraction too. The
 * spec allows YouTube to be demonstrated locally, so a clone with no OpenAI key
 * should still be able to ingest a video.
 */
export function getYouTubeProxyUrl(): string | undefined {
  const parsed = youtubeProxySchema.safeParse(process.env.YOUTUBE_PROXY_URL);
  if (!parsed.success) {
    console.warn("[env] YOUTUBE_PROXY_URL is not a valid URL; ignoring it");
    return undefined;
  }
  return parsed.data;
}
