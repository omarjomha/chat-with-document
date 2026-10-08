import { z } from "zod";

import { INGEST_RATE_LIMIT } from "@/lib/constants";
import { createSession } from "@/lib/ingest/session";
import { loadYouTubeTranscript, YouTubeIngestError } from "@/lib/ingest/youtube";
import { parseYouTubeVideoId } from "@/lib/ingest/youtubeUrl";
import { guardRequest } from "@/lib/security/guard";
import { createRateLimiter } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Fetching a long video's transcript is several round trips to YouTube.
export const maxDuration = 60;

const requestSchema = z.object({
  url: z.string().min(1).max(2048),
});

/** Every ingest failure the user can act on carries its own status. */
const STATUS_BY_CODE: Record<YouTubeIngestError["code"], number> = {
  "invalid-url": 400,
  "not-found": 404,
  unavailable: 403,
  "no-captions": 422,
  empty: 422,
  // 502: the request was fine and we are the ones who could not reach YouTube.
  blocked: 502,
  unknown: 500,
};

const limiter = createRateLimiter(INGEST_RATE_LIMIT.limit, INGEST_RATE_LIMIT.windowMs);

export async function POST(request: Request): Promise<Response> {
  const refused = guardRequest(request, limiter);
  if (refused) return refused;

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const videoId = parseYouTubeVideoId(parsed.data.url);
  if (!videoId) {
    return Response.json(
      { error: "That is not a YouTube video link.", code: "invalid-url" },
      { status: 400 },
    );
  }

  try {
    const { title, text } = await loadYouTubeTranscript(videoId);
    const result = await createSession({ kind: "youtube", title, rawText: text });

    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof YouTubeIngestError) {
      // These messages are written for the user and safe to surface.
      return Response.json(
        { error: error.message, code: error.code },
        { status: STATUS_BY_CODE[error.code] },
      );
    }

    const message = error instanceof Error ? error.message : "Unknown error.";
    console.error("[ingest] youtube ingestion failed", message);
    return Response.json({ error: "That video could not be processed." }, { status: 500 });
  }
}
