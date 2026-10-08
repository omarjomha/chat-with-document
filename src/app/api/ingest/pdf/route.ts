import { del, get } from "@vercel/blob";
import { z } from "zod";

import { MAX_PDF_BYTES } from "@/lib/constants";
import { extractPdfText, PdfExtractionError } from "@/lib/ingest/pdf";
import { createSession } from "@/lib/ingest/session";
import { isStagedUploadPath } from "@/lib/ingest/uploads";
import { guardRequest } from "@/lib/security/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// PDF parsing is CPU-bound; large documents need more than the brief default.
export const maxDuration = 120;

const requestSchema = z.object({
  /** Blob pathname returned by the client upload. Confined to the upload folder. */
  pathname: z.string().min(1).max(512).refine(isStagedUploadPath),
  /** Original filename, used as the display title. */
  filename: z.string().min(1).max(255),
});

export async function POST(request: Request): Promise<Response> {
  // Origin only. The rate limit sits on the upload handshake instead, which
  // refuses before any bytes are stored; limiting here would strand a PDF
  // that had already been uploaded.
  const refused = guardRequest(request);
  if (refused) return refused;

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { pathname, filename } = parsed.data;

  try {
    const blob = await get(pathname, { access: "private" });
    if (!blob || blob.statusCode !== 200) {
      return Response.json({ error: "Uploaded file could not be found." }, { status: 404 });
    }

    // Defence in depth: Blob already enforces this at upload time, but the
    // pathname arrives from the client and we parse whatever it points at.
    if (blob.blob.size > MAX_PDF_BYTES) {
      await safeDelete(pathname);
      return Response.json({ error: "That PDF is larger than 25 MB." }, { status: 413 });
    }

    const bytes = new Uint8Array(await new Response(blob.stream).arrayBuffer());
    const { text, pages, pagesWithoutText } = await extractPdfText(bytes);

    const result = await createSession({
      kind: "pdf",
      title: filename,
      rawText: text,
      pages,
      pagesWithoutText,
    });

    // The PDF itself is a transient staging artefact; only the extracted text
    // is needed from here, so do not retain the original document.
    await safeDelete(pathname);

    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    await safeDelete(pathname);

    if (error instanceof PdfExtractionError) {
      // These messages are written for the user and safe to surface.
      return Response.json({ error: error.message, code: error.code }, { status: 422 });
    }

    const message = error instanceof Error ? error.message : "Unknown error.";
    console.error("[ingest] pdf ingestion failed", message);
    return Response.json({ error: "The PDF could not be processed." }, { status: 500 });
  }
}

/** Cleanup must never mask the original failure. */
async function safeDelete(pathname: string): Promise<void> {
  try {
    await del(pathname);
  } catch (error) {
    console.warn("[ingest] could not delete staged blob", pathname, error);
  }
}
