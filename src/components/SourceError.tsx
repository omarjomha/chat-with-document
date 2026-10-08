/**
 * Shared failure surface for the two ingest paths.
 *
 * Both of them fail in ways the user can act on -- wrong file type, a video
 * with no captions -- so the message is always the server's own wording rather
 * than a generic "something went wrong".
 */
export function SourceError({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
    >
      {message}
    </p>
  );
}

/** Pulls the `error` string out of an ingest route's JSON body, if present. */
export function readError(payload: unknown): string | undefined {
  if (payload && typeof payload === "object" && "error" in payload) {
    const { error } = payload as { error: unknown };
    if (typeof error === "string") return error;
  }
  return undefined;
}
