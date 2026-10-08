import "server-only";

import { del, list } from "@vercel/blob";

import { PDF_UPLOAD_PREFIX, STAGED_UPLOAD_TTL_MS } from "@/lib/constants";

/**
 * True for a pathname the PDF routes may act on: inside the upload folder, a
 * PDF, and with no way to climb out of the folder.
 */
export function isStagedUploadPath(pathname: string): boolean {
  return (
    pathname.startsWith(PDF_UPLOAD_PREFIX) &&
    pathname.toLowerCase().endsWith(".pdf") &&
    !pathname.split("/").includes("..")
  );
}

/**
 * Removes uploads that were never extracted.
 *
 * The extraction route deletes the PDF on every outcome, but it only runs if
 * the browser asks for it. Closing the tab mid-upload leaves the user's file in
 * storage with nothing to remove it, so the daily cron sweeps them.
 */
export async function deleteStaleUploads(now: number = Date.now()): Promise<number> {
  // Without Blob credentials uploads cannot have happened.
  if (!process.env.BLOB_READ_WRITE_TOKEN) return 0;

  const cutoff = now - STAGED_UPLOAD_TTL_MS;
  const stale: string[] = [];
  let cursor: string | undefined;

  do {
    const page = await list({ prefix: PDF_UPLOAD_PREFIX, cursor, limit: 1000 });
    for (const blob of page.blobs) {
      if (new Date(blob.uploadedAt).getTime() <= cutoff) stale.push(blob.pathname);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  if (stale.length > 0) await del(stale);
  return stale.length;
}
