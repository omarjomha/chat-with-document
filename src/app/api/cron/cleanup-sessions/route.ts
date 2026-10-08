import { getTranscriptCache } from "@/lib/ingest/transcriptCache";
import { getSessionStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scheduled sweep of lapsed document sessions and cached transcripts.
 *
 * This is a backstop, not the primary mechanism. Sessions are swept on every
 * ingest and deleted explicitly when the user replaces a document, and expiry
 * is enforced on read regardless. The cron only matters for the case where
 * nobody touches the app after the last upload -- and on the Hobby plan it can
 * run at most once a day, so it could not be the primary mechanism anyway.
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;

  // Vercel sends `Authorization: Bearer $CRON_SECRET` when the variable is
  // set. Without a secret configured the endpoint would be publicly callable,
  // so refuse rather than run unauthenticated.
  if (!secret) {
    console.error("[cron] CRON_SECRET is not set; refusing to run");
    return Response.json({ error: "Not configured." }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    // Cached transcripts are swept here only. Unlike sessions they are not
    // swept on ingest: the whole point of the cache is to survive between
    // visits, and a week-long TTL means there is rarely anything to remove.
    const [removed, transcripts] = await Promise.all([
      getSessionStore().deleteExpired(),
      getTranscriptCache().deleteExpired(),
    ]);

    console.info(`[cron] swept ${removed} expired session(s), ${transcripts} cached transcript(s)`);
    return Response.json({ removed, transcripts }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[cron] sweep failed", error);
    return Response.json({ error: "Sweep failed." }, { status: 500 });
  }
}
