import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

import { MAX_PDF_BYTES } from "@/lib/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Issues short-lived client tokens for direct browser-to-Blob uploads.
 *
 * Vercel caps function request bodies at 4.5 MB, but the spec requires PDFs up
 * to 25 MB. Routing the bytes straight to Blob storage sidesteps that limit
 * while keeping extraction server-side, which the spec also requires.
 *
 * The size and content-type limits below are enforced by Blob itself, so an
 * oversized or non-PDF upload is rejected at the storage layer rather than
 * after we have already paid to transfer it.
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ["application/pdf"],
        maximumSizeInBytes: MAX_PDF_BYTES,
        addRandomSuffix: true,
        // Uploaded PDFs are never reachable by URL; only this server can read
        // them, using the store credentials.
        access: "private",
        validUntil: Date.now() + 60_000,
      }),
      // Extraction is driven by an explicit client call to /api/ingest/pdf so
      // the user gets the result synchronously. Nothing to do on completion.
      onUploadCompleted: async () => {},
    });

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload could not be authorised.";
    console.error("[ingest] blob upload handshake failed", message);
    return Response.json({ error: message }, { status: 400 });
  }
}
