import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { DocumentContext } from "@/lib/prompt";
import { mintClientSecret, RealtimeMintError } from "@/lib/realtime/mintClientSecret";
import { getSessionStore } from "@/lib/store";

// Node.js runtime on Fluid Compute. The Edge runtime is deprecated on Vercel,
// and we need Node built-ins here anyway.
export const runtime = "nodejs";
// Never cache a credential-minting endpoint.
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  /** Absent means no document has been ingested yet. */
  sessionId: z.string().uuid().optional(),
});

export async function POST(request: Request): Promise<Response> {
  let body: unknown = {};
  if (request.headers.get("content-length") !== "0") {
    body = await request.json().catch(() => ({}));
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request body.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { sessionId } = parsed.data;

  let context: DocumentContext | undefined;
  if (sessionId) {
    const session = await getSessionStore().get(sessionId);
    if (!session) {
      // Better to say so than to silently start an ungrounded conversation the
      // user believes is about their document.
      return Response.json(
        { error: "That document session has expired. Please upload it again." },
        { status: 404 },
      );
    }
    context = {
      title: session.title,
      kind: session.kind,
      text: session.text,
      truncated: session.truncated,
    };
  }

  try {
    const secret = await mintClientSecret(context, randomUUID());
    return Response.json(
      { value: secret.value, expiresAt: secret.expiresAt, model: secret.model },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof RealtimeMintError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    // Configuration problems (missing/invalid env) land here.
    const message = error instanceof Error ? error.message : "Unknown error.";
    console.error("[realtime] token route failed", message);
    return Response.json(
      { error: "Realtime session could not be started. Check server configuration." },
      { status: 500 },
    );
  }
}
