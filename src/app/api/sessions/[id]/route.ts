import { z } from "zod";

import { getSessionStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().uuid() });

/**
 * Deletes an ingested document on request.
 *
 * Called when the user replaces their document, and on page unload via
 * sendBeacon. Best-effort by nature -- a crash or a closed laptop never fires
 * it -- so expiry in the store remains the actual guarantee.
 *
 * Next 16 passes route params as a promise.
 */
async function removeSession(context: { params: Promise<{ id: string }> }): Promise<Response> {
  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) {
    return Response.json({ error: "Invalid session id." }, { status: 400 });
  }

  try {
    await getSessionStore().delete(parsed.data.id);
    // Deleting something already gone is a success from the caller's view.
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("[sessions] delete failed", error);
    return Response.json({ error: "Could not delete the session." }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return removeSession(context);
}

/**
 * sendBeacon can only issue POST, so page-unload cleanup arrives here.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return removeSession(context);
}
