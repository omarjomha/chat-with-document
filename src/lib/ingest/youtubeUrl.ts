/**
 * YouTube URL parsing.
 *
 * Deliberately free of `server-only` and of any youtubei.js import so the
 * browser can reject a bad link instantly, the same way the PDF picker checks
 * size and type before starting an upload.
 */

/** YouTube video ids are exactly 11 characters of URL-safe base64. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Path prefixes that carry the id as the next segment. */
const ID_BEARING_PREFIXES = new Set(["shorts", "embed", "live", "v", "e"]);

function isYouTubeHost(host: string): boolean {
  return (
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com")
  );
}

/**
 * Extracts the video id from any of the link shapes YouTube hands out.
 *
 * Returns `null` rather than throwing: callers turn that into a message, and a
 * parse failure is an expected outcome of user input rather than an exception.
 */
export function parseYouTubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // People paste "youtube.com/watch?v=..." without a scheme constantly, and
  // the URL parser would read that as a relative path.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const segments = url.pathname.split("/").filter(Boolean);

  // Short links put the id directly in the path: youtu.be/ID?t=42
  if (host === "youtu.be") {
    return segments.length === 1 && VIDEO_ID.test(segments[0]) ? segments[0] : null;
  }

  if (!isYouTubeHost(host)) return null;

  // The canonical form, which may carry a playlist, timestamp, or tracking
  // parameters alongside the id.
  if (segments.length === 1 && segments[0] === "watch") {
    const id = url.searchParams.get("v");
    return id && VIDEO_ID.test(id) ? id : null;
  }

  if (segments.length === 2 && ID_BEARING_PREFIXES.has(segments[0])) {
    return VIDEO_ID.test(segments[1]) ? segments[1] : null;
  }

  return null;
}

/** Canonical watch URL, used as the stored title's link and for logging. */
export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
