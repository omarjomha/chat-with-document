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
