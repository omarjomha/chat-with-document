import "server-only";

import { getYouTubeProxyUrl } from "@/lib/env";

import { getTranscriptCache } from "./transcriptCache";
import { looksLikeCaptionXml, parseCaptionXml } from "./youtubeCaptions";

export type YouTubeErrorCode =
  "invalid-url" | "not-found" | "unavailable" | "no-captions" | "empty" | "blocked" | "unknown";

export class YouTubeIngestError extends Error {
  constructor(
    readonly code: YouTubeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "YouTubeIngestError";
  }
}

export interface YouTubeTranscript {
  /** Video title, used as the session title. */
  title: string;
  /** Caption lines joined into prose; call normalizeExtractedText before use. */
  text: string;
}

/**
 * The mobile clients are the point of this whole module.
 *
 * YouTube gates the *web* client's caption URLs behind a Proof-of-Origin token
 * minted by its browser attestation runtime, and marks such URLs with
 * `exp=xpe`. Fetching one returns HTTP 200 with an empty body. The Android and
 * iOS clients are served caption URLs without that flag, which fetch directly
 * -- no token, no browser, no headless Chrome.
 *
 * Both are listed because they are independently refused. Measured: a flagged
 * residential IP gets OK from both; a Vercel egress IP got LOGIN_REQUIRED from
 * Android, and every non-mobile client is refused from everywhere. Trying the
 * next client costs one request and is the difference between working and not
 * when YouTube sours on one of them.
 *
 * If both start failing, these versions are the first thing to bump.
 */
const PLAYER_CLIENTS: readonly { clientName: string; clientVersion: string }[] = [
  { clientName: "ANDROID", clientVersion: "20.10.38" },
  { clientName: "IOS", clientVersion: "20.10.4" },
];

/** YouTube's public web InnerTube key. Stable for years, but see scrapeInnertubeKey. */
const DEFAULT_INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

/** Marks a caption URL that requires a Proof-of-Origin token. */
const PO_TOKEN_FLAG = "exp=xpe";

const PLAYER_URL = "https://www.youtube.com/youtubei/v1/player";
const WATCH_URL = "https://www.youtube.com/watch";

/** The slice of the player response this module reads. */
interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: { title?: string };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
}

/**
 * Builds the fetch YouTube requests travel through.
 *
 * YouTube throttles and blocks datacentre IP ranges, so a deployment can be
 * refused where a laptop is not. `YOUTUBE_PROXY_URL` lets these calls exit
 * through a different egress: the target URL is appended, percent-encoded, to
 * the configured prefix.
 */
function createFetch(proxyUrl: string | undefined): typeof fetch {
  if (!proxyUrl) return fetch;

  return (input, init) => {
    const target = input instanceof Request ? input.url : input.toString();
    return fetch(`${proxyUrl}${encodeURIComponent(target)}`, init);
  };
}

/** Requests one client's player response, which carries the caption tracklist. */
function requestPlayer(
  fetchFn: typeof fetch,
  videoId: string,
  key: string,
  client: { clientName: string; clientVersion: string },
): Promise<Response> {
  return fetchFn(`${PLAYER_URL}?key=${key}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Without this YouTube picks a language from the egress IP, which decides
      // which caption track is listed first.
      "Accept-Language": "en-US",
    },
    body: JSON.stringify({ context: { client }, videoId }),
  });
}

/**
 * Recovers a fresh InnerTube key from the watch page.
 *
 * Only called when the constant key is rejected. The watch page is around a
 * megabyte, so paying for it on every ingest would be wasteful -- but having no
 * recovery path would let a single rotated key break the feature outright.
 */
async function scrapeInnertubeKey(fetchFn: typeof fetch, videoId: string): Promise<string> {
  const response = await fetchFn(`${WATCH_URL}?v=${encodeURIComponent(videoId)}`, {
    headers: { "Accept-Language": "en-US" },
  });
  if (!response.ok) {
    throw new YouTubeIngestError("blocked", "YouTube refused the request. Try again shortly.");
  }

  const key = /"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/.exec(await response.text())?.[1];
  if (!key) {
    throw new YouTubeIngestError("unknown", "That video's transcript could not be read.");
  }
  return key;
}

/**
 * How definitive a refusal is, for choosing which one to report when every
 * client fails.
 *
 * A video that does not exist, or that demonstrably has no captions, is true no
 * matter which client asked -- so those outrank a bot challenge, which says
 * only that this particular request was distrusted.
 */
const CODE_RANK: Record<YouTubeErrorCode, number> = {
  "not-found": 5,
  "no-captions": 4,
  unavailable: 3,
  empty: 2,
  blocked: 1,
  unknown: 0,
  "invalid-url": 0,
};

function mostDefinitive(errors: readonly YouTubeIngestError[]): YouTubeIngestError {
  return errors.reduce((best, candidate) =>
    CODE_RANK[candidate.code] > CODE_RANK[best.code] ? candidate : best,
  );
}

interface PlayerAttempt {
  player: PlayerResponse;
  track: CaptionTrack & { baseUrl: string };
}

/** Evaluates one player response, returning either a usable track or why not. */
function evaluate(player: PlayerResponse): PlayerAttempt | YouTubeIngestError {
  const status = player.playabilityStatus;
  if (status?.status) {
    const refusal = fromPlayabilityStatus(status.status, status.reason);
    if (refusal) return refusal;
  }

  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track = selectCaptionTrack(tracks);
  if (!track?.baseUrl) {
    return new YouTubeIngestError(
      "no-captions",
      "That video has no captions, so there is no transcript to read.",
    );
  }

  // Should not happen on a mobile client, but if YouTube ever extends the token
  // requirement, saying so beats returning an empty transcript.
  if (track.baseUrl.includes(PO_TOKEN_FLAG)) {
    return new YouTubeIngestError(
      "blocked",
      "YouTube now requires a verified browser session for this video's captions, which this server cannot provide.",
    );
  }

  return { player, track: { ...track, baseUrl: track.baseUrl } };
}

/**
 * Finds a client that YouTube will serve an ungated caption URL for.
 *
 * Tries each client in turn and keeps every refusal, so that when none works
 * the user is told the most informative reason rather than whichever client
 * happened to be last.
 */
async function findPlayableClient(fetchFn: typeof fetch, videoId: string): Promise<PlayerAttempt> {
  const refusals: YouTubeIngestError[] = [];
  let key = DEFAULT_INNERTUBE_KEY;

  for (const client of PLAYER_CLIENTS) {
    let response = await requestPlayer(fetchFn, videoId, key, client);

    if (response.status === 400 || response.status === 403) {
      // Most likely a rotated key. Recover once and reuse it for the rest.
      key = await scrapeInnertubeKey(fetchFn, videoId);
      response = await requestPlayer(fetchFn, videoId, key, client);
    }

    if (!response.ok) {
      refusals.push(refusalFor(response, "player"));
      continue;
    }

    const outcome = evaluate((await response.json()) as PlayerResponse);

    if (outcome instanceof YouTubeIngestError) {
      console.warn(`[ingest] youtube ${client.clientName} refused ${videoId}: ${outcome.code}`);
      refusals.push(outcome);
      continue;
    }

    return outcome;
  }

  throw mostDefinitive(refusals);
}

/**
 * Turns a refused response into a `blocked` error.
 *
 * 429 earns its own wording because it is the one anyone running this will
 * actually hit, and because its duration is badly misjudged by default. It is
 * not a per-minute rate limit: YouTube answers it with Google's "your computer
 * or network may be sending automated queries" page and holds the block against
 * the whole egress IP for hours -- measured here, outlasting a 12-minute poll
 * and still in force several hours later.
 */
function refusalFor(response: Response, stage: "player" | "captions"): YouTubeIngestError {
  console.warn(`[ingest] youtube ${stage} request refused with HTTP ${response.status}`);

  if (response.status === 429) {
    return new YouTubeIngestError(
      "blocked",
      "YouTube has temporarily blocked this server's network for automated requests. This usually clears after a few hours; a different network, or YOUTUBE_PROXY_URL, works around it.",
    );
  }

  return new YouTubeIngestError(
    "blocked",
    `YouTube refused the request (HTTP ${response.status}).`,
  );
}

/**
 * Distinguishes YouTube's bot challenge from a genuinely restricted video.
 *
 * The wording has changed before, so this matches on the stable part -- the bot
 * and sign-in-to-confirm phrasing -- and treats anything unrecognised as a real
 * restriction, which is the safer default: it blames neither the network nor
 * the user without evidence.
 */
function isBotCheck(reason: string | undefined): boolean {
  if (!reason) return false;
  return /not a bot|confirm you'?re not|bot|unusual traffic|automated/i.test(reason);
}

/** Maps a playability status onto an actionable message. */
function fromPlayabilityStatus(status: string, reason?: string): YouTubeIngestError | undefined {
  switch (status) {
    case "OK":
      return undefined;
    case "ERROR":
      return new YouTubeIngestError(
        "not-found",
        "That video does not exist, or it has been removed.",
      );
    case "LOGIN_REQUIRED":
      // LOGIN_REQUIRED has two unrelated causes and they need opposite
      // messages. A genuinely private or age-gated video is the caller's
      // problem and nothing will fix it. But YouTube also returns
      // LOGIN_REQUIRED to bot-check an egress IP it distrusts, which is what a
      // datacentre deployment gets for an ordinary public video -- observed on
      // Vercel for "Me at the zoo", which is neither private nor age-gated.
      // Calling that "private" would send the user hunting a nonexistent
      // problem with the video.
      if (isBotCheck(reason)) {
        return new YouTubeIngestError(
          "blocked",
          "YouTube is challenging this server's network rather than serving the video. Deployments on shared cloud IPs usually need YOUTUBE_PROXY_URL set to a different egress.",
        );
      }
      return new YouTubeIngestError(
        "unavailable",
        "That video is private or age-restricted, so its transcript cannot be read without signing in.",
      );
    case "AGE_VERIFICATION_REQUIRED":
    case "CONTENT_CHECK_REQUIRED":
      return new YouTubeIngestError(
        "unavailable",
        "That video is private or age-restricted, so its transcript cannot be read without signing in.",
      );
    case "UNPLAYABLE":
      return new YouTubeIngestError(
        "unavailable",
        reason
          ? `YouTube will not serve that video: ${reason}`
          : "That video cannot be played — it may be private, region-locked, or members-only.",
      );
    default:
      return new YouTubeIngestError(
        "unavailable",
        `YouTube returned an unexpected status for that video (${status}).`,
      );
  }
}

/**
 * Picks the most useful caption track.
 *
 * Human-written tracks beat auto-generated ones: they are punctuated, several
 * times smaller, and free of the rolling duplication. English is preferred
 * because the assistant converses in English; failing that, whatever the video
 * offers, still preferring a written track.
 */
export function selectCaptionTrack(tracks: readonly CaptionTrack[]): CaptionTrack | undefined {
  const usable = tracks.filter((track) => track.baseUrl);
  const written = (track: CaptionTrack) => track.kind !== "asr";
  const english = (track: CaptionTrack) => track.languageCode?.startsWith("en") ?? false;

  return (
    usable.find((track) => english(track) && written(track)) ??
    usable.find(english) ??
    usable.find(written) ??
    usable[0]
  );
}

/**
 * Pins the caption format instead of trusting the client's own URL.
 *
 * Android's URL carries `fmt=srv3`; iOS's carries no format at all, which
 * leaves the response shape to YouTube's default. `fmt` is not among the signed
 * `sparams`, so setting it does not invalidate the signature -- and pinning it
 * means both clients return the same document for one parser to read.
 */
export function captionUrlFor(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("fmt", "srv3");
    return url.toString();
  } catch {
    // A URL we cannot parse is one YouTube gave us; fetch it unchanged rather
    // than failing, since the parser tolerates both formats anyway.
    return baseUrl;
  }
}

/**
 * Caption lines arrive as short display fragments, roughly one per subtitle
 * card, so they are joined one per line: the model reads them as prose either
 * way, and keeping the breaks makes the preview legible.
 *
 * Consecutive duplicates are dropped because rolling auto-captions repeat the
 * trailing line of the previous card.
 */
export function joinCaptionLines(lines: readonly string[]): string {
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === kept.at(-1)) continue;
    kept.push(trimmed);
  }

  return kept.join("\n");
}

/** Last-resort net for failures that are not already classified. */
export function toYouTubeIngestError(error: unknown): YouTubeIngestError {
  if (error instanceof YouTubeIngestError) return error;

  const message = error instanceof Error ? error.message : String(error);

  if (/fetch failed|network|ECONNRESET|ETIMEDOUT|timeout|aborted/i.test(message)) {
    return new YouTubeIngestError("blocked", "Could not reach YouTube. Try again in a moment.");
  }

  console.error("[ingest] unmapped youtube failure", message);
  return new YouTubeIngestError("unknown", "That video's transcript could not be read.");
}

/**
 * Fetches a video's caption transcript, server-side and without an API key.
 *
 * Three steps: find a mobile client YouTube will serve an ungated caption URL
 * for, fetch that URL, and reduce the timed-text document to lines.
 */
export async function fetchYouTubeTranscript(videoId: string): Promise<YouTubeTranscript> {
  const fetchFn = createFetch(getYouTubeProxyUrl());

  try {
    const { player, track } = await findPlayableClient(fetchFn, videoId);

    const captions = await fetchFn(captionUrlFor(track.baseUrl));
    if (!captions.ok) throw refusalFor(captions, "captions");

    const body = await captions.text();

    // A 200 that is not a caption document is a refusal in disguise, and the
    // parser would otherwise turn an HTML error page into a transcript.
    if (!looksLikeCaptionXml(body)) {
      if (body.trim().length === 0) {
        // An empty 200 is specifically how YouTube refuses a gated URL.
        throw new YouTubeIngestError(
          "blocked",
          "YouTube returned no caption data for this video, which usually means it wants a verified browser session.",
        );
      }
      console.warn(`[ingest] youtube returned a non-caption body for ${videoId}`);
      throw new YouTubeIngestError(
        "blocked",
        "YouTube returned a page instead of captions, which usually means this network is being challenged.",
      );
    }

    const text = joinCaptionLines(parseCaptionXml(body));
    if (!text) {
      throw new YouTubeIngestError("empty", "That video's transcript came back empty.");
    }

    return { title: player.videoDetails?.title ?? `YouTube video ${videoId}`, text };
  } catch (error) {
    throw toYouTubeIngestError(error);
  }
}

/**
 * Returns a video's transcript, from cache when possible.
 *
 * Wraps the network call rather than living inside it so that
 * `fetchYouTubeTranscript` stays a plain "go and ask YouTube", which is what
 * makes it straightforward to test.
 *
 * Neither cache failure is allowed to fail the ingest: a read that throws falls
 * through to a live fetch, and a write that throws has already served the user.
 * Only successes are cached -- caching a block would turn a transient outage
 * into a week-long one.
 */
export async function loadYouTubeTranscript(videoId: string): Promise<YouTubeTranscript> {
  const cache = getTranscriptCache();

  try {
    const hit = await cache.get(videoId);
    if (hit) {
      console.info(`[ingest] youtube transcript cache hit for ${videoId}`);
      return { title: hit.title, text: hit.text };
    }
  } catch (error) {
    console.warn("[ingest] transcript cache read failed", error);
  }

  const transcript = await fetchYouTubeTranscript(videoId);

  try {
    await cache.put({ videoId, ...transcript });
  } catch (error) {
    console.warn("[ingest] transcript cache write failed", error);
  }

  return transcript;
}
